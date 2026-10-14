import type { RpcDialogue, DialogueReply } from "./rpc-dialogue.ts";
import { newSemanticId } from "pi-runtime";
export interface OwnedWaiterOfferV1 {
  version: 1;
  id: string;
  owner: string;
  sessionId: string;
  producerGeneration: string;
  promise: Promise<{ deliveryKey: string; value: unknown }>;
  isCurrent(): boolean;
  respond(
    result:
      | { accepted: false }
      | {
          accepted: true;
          scope: { goalId: string; revision: number; branchToken: string };
          release(): void;
        },
  ): void;
}
/** Accepted request ownership survives release so stale results never fall back to an unsolicited wake. */
export class ResponseOffers {
  private owned = new Set<string>();
  private releases = new Map<string, () => void>();
  private readonly emit: (name: string, value: unknown) => void;
  constructor(emit: (name: string, value: unknown) => void) {
    this.emit = emit;
  }
  offer(
    dialogue: RpcDialogue,
    requestId: string,
    sessionId: string,
    generation: string,
    isCurrent: () => boolean,
  ) {
    const key = `${dialogue.id}:${requestId}`,
      waitId = newSemanticId("wait");
    const promise = dialogue.waitForRequest(requestId).then((reply) => ({
      deliveryKey: `${generation}:reply:${reply.sequence}`,
      value: reply,
    }));
    void promise.catch(() => {});
    let open = true,
      responded = false,
      accepted = false,
      released = false,
      goalRelease = () => {};
    const release = () => {
      if (released) return;
      released = true;
      dialogue.releaseReplyWaiter(requestId);
      goalRelease();
      this.releases.delete(key);
    };
    const offer: OwnedWaiterOfferV1 = {
      version: 1,
      id: waitId,
      owner: "subagent",
      sessionId,
      producerGeneration: generation,
      promise,
      isCurrent,
      respond: (result) => {
        if (!open || responded)
          throw Error("Goal waiter acceptance must be synchronous and exactly once");
        responded = true;
        if (result.accepted) {
          accepted = true;
          this.owned.add(key);
          goalRelease = result.release;
        }
      },
    };
    try {
      this.emit("goal:waiter", offer);
    } finally {
      open = false;
    }
    if (accepted) this.releases.set(key, release);
    else release();
    return { waitId, accepted, release };
  }
  ownsReply(id: string, reply: DialogueReply): boolean {
    const owned = reply.requestIds.some((request) => this.owned.has(`${id}:${request}`));
    for (const request of reply.requestIds) this.owned.delete(`${id}:${request}`);
    // Resolve producer promises after RpcDialogue records this reply; do not release here.
    return owned;
  }
  releaseWorker(id: string) {
    for (const [key, release] of [...this.releases]) if (key.startsWith(`${id}:`)) release();
  }
  clear() {
    for (const release of [...this.releases.values()]) release();
    this.releases.clear();
    this.owned.clear();
  }
}
