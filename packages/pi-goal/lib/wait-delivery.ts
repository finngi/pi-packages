import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withinBudget, type GoalState, type OwnedWaiterOfferV1 } from "./goal.ts";
import { DELIVERY_ENTRY } from "./persistence.ts";
import type { GoalExecutionGrant } from "./effects.ts";
type Waiter = {
  id: string;
  owner: string;
  sessionId: string;
  producerGeneration: string;
  promise: Promise<{ deliveryKey: string; value: unknown }>;
  isCurrent(): boolean;
  goalId: string;
  revision: number;
  branchToken: string;
  isReleased(): boolean;
  release(): void;
};

export type GoalWaitScope = Pick<Waiter, "goalId" | "revision" | "branchToken" | "sessionId">;

interface WaitHost {
  current(): {
    goal?: GoalState;
    sessionId: string;
    branchToken: string;
    automaticDisarmed: boolean;
  };
  sync(ctx: ExtensionContext): void;
  disarm(ctx: ExtensionContext, scope?: GoalWaitScope, reason?: string): void;
  refreshStatus(ctx?: ExtensionContext): void;
}
export function createGoalWaits(pi: ExtensionAPI, host: WaitHost) {
  const waiters = new Map<string, Waiter>();
  const deliveryClaims = new Map<string, "claimed" | "delivered">();
  const waitAborters = new Set<AbortController>();
  const yielders = new Set<() => void>();
  const yielded = Symbol("foreground goal wait yielded");
  const yieldForeground = (value?: unknown) => {
    const count = yielders.size;
    for (const yieldWait of yielders) yieldWait();
    const request = value as { respond?: (count: number) => void } | undefined;
    request?.respond?.(count);
  };
  pi.events.on("goal:yield-wait:v1", yieldForeground);
  pi.on("input", (event) => {
    if (event.source !== "extension" && event.streamingBehavior === "steer") yieldForeground();
  });
  const releaseWaiter = (waiter: Waiter) => {
    try {
      waiter.release();
    } catch {
      /* Cleanup cannot reopen delivery. */
    }
  };
  const releaseAllWaiters = () => {
    for (const waiter of waiters.values()) releaseWaiter(waiter);
    waiters.clear();
    host.refreshStatus();
  };
  const abort = (reason: string, ctx?: ExtensionContext) => {
    if (ctx) host.disarm(ctx, undefined, reason);
    releaseAllWaiters();
    for (const controller of waitAborters) controller.abort(new Error(reason));
    waitAborters.clear();
    if (ctx) host.refreshStatus(ctx);
  };
  pi.events.on("goal:waiter", (value) => {
    const { goal, sessionId, branchToken, automaticDisarmed } = host.current();
    if (!value || typeof value !== "object") return;
    const offer = value as Partial<OwnedWaiterOfferV1>;
    let answered = false;
    const reject = () => {
      if (!answered && typeof offer.respond === "function") {
        answered = true;
        offer.respond({ accepted: false });
      }
    };
    if (
      offer.version !== 1 ||
      typeof offer.id !== "string" ||
      !offer.id.trim() ||
      waiters.has(offer.id) ||
      typeof offer.owner !== "string" ||
      !offer.owner.trim() ||
      typeof offer.sessionId !== "string" ||
      !offer.sessionId.trim() ||
      typeof offer.producerGeneration !== "string" ||
      !offer.producerGeneration.trim() ||
      !offer.promise ||
      typeof (offer.promise as PromiseLike<unknown>).then !== "function" ||
      typeof offer.isCurrent !== "function" ||
      typeof offer.respond !== "function"
    ) {
      reject();
      return;
    }
    if (
      offer.sessionId !== sessionId ||
      !goal ||
      goal.status !== "active" ||
      (goal.deadlineAt !== undefined && goal.deadlineAt <= Date.now()) ||
      !withinBudget(goal) ||
      automaticDisarmed
    ) {
      reject();
      return;
    }
    let producerCurrent = false;
    try {
      producerCurrent = offer.isCurrent();
    } catch {
      producerCurrent = false;
    }
    if (!producerCurrent) {
      reject();
      return;
    }
    const offerId = offer.id;
    const scope = { goalId: goal.id, revision: goal.revision, branchToken };
    let released = false;
    let waiter!: Waiter;
    const release = () => {
      if (released) return;
      released = true;
      if (waiters.get(offerId) === waiter) {
        waiters.delete(offerId);
        host.refreshStatus();
      }
    };
    waiter = {
      id: offer.id,
      owner: offer.owner,
      sessionId: offer.sessionId,
      producerGeneration: offer.producerGeneration,
      promise: Promise.resolve(offer.promise),
      isCurrent: offer.isCurrent,
      ...scope,
      isReleased: () => released,
      release,
    };
    void waiter.promise.catch(() => {});
    waiters.set(waiter.id, waiter);
    host.refreshStatus();
    answered = true;
    try {
      offer.respond({
        accepted: true,
        scope,
        release: () => {
          if (!released) release();
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  });

  return {
    get size() {
      return waiters.size;
    },
    get waiting() {
      return waitAborters.size > 0;
    },
    release: releaseAllWaiters,
    abort,
    reset() {
      abort("Session changed");
      deliveryClaims.clear();
    },
    replay(ctx: ExtensionContext) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type !== "custom" ||
          entry.customType !== DELIVERY_ENTRY ||
          !entry.data ||
          typeof entry.data !== "object"
        )
          continue;
        const delivery = entry.data as { version?: unknown; deliveryKey?: unknown };
        if (
          delivery.version === 1 &&
          typeof delivery.deliveryKey === "string" &&
          delivery.deliveryKey.trim()
        )
          deliveryClaims.set(delivery.deliveryKey, "delivered");
      }
    },
    async execute(
      params: { id: string },
      signal: AbortSignal | undefined,
      ctx: ExtensionContext,
      grant?: GoalExecutionGrant,
    ) {
      host.sync(ctx);
      const { goal, automaticDisarmed } = host.current();
      const waitSessionId = ctx.sessionManager.getSessionId();
      const waiter = waiters.get(params.id);
      if (!goal || goal.status !== "active" || !withinBudget(goal) || automaticDisarmed)
        throw new Error(
          "An active, authorized, in-budget goal is required to wait for an asynchronous result",
        );
      if (!waiter) throw new Error(`Unknown asynchronous result offer: ${params.id}`);
      const fresh = () => {
        const { goal, sessionId, branchToken, automaticDisarmed } = host.current();
        let producerCurrent = false;
        try {
          producerCurrent = waiter.isCurrent();
        } catch {
          producerCurrent = false;
        }
        return (
          producerCurrent &&
          !waiter.isReleased() &&
          waiter.sessionId === sessionId &&
          waiter.goalId === goal?.id &&
          waiter.revision === goal?.revision &&
          waiter.branchToken === branchToken &&
          !!goal &&
          goal.status === "active" &&
          (goal.deadlineAt === undefined || goal.deadlineAt > Date.now()) &&
          withinBudget(goal) &&
          !automaticDisarmed
        );
      };
      if (!fresh()) {
        host.disarm(ctx, waiter, "wait offer no longer authorized");
        releaseWaiter(waiter);
        throw new Error("Asynchronous result offer is stale or no longer authorized");
      }
      grant?.dispatch(params, () => {
        if (!fresh()) throw new Error("Asynchronous result offer is stale or no longer authorized");
      });
      const controller = new AbortController();
      waitAborters.add(controller);
      host.refreshStatus(ctx);
      const abort = () => controller.abort(new Error("Wait aborted"));
      if (signal?.aborted || ctx.signal?.aborted || grant?.signal.aborted) abort();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        ctx.signal?.addEventListener("abort", abort, { once: true });
        grant?.signal.addEventListener("abort", abort, { once: true });
      }
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted)
          reject(controller.signal.reason ?? new Error("Wait aborted"));
        else {
          onAbort = () => reject(controller.signal.reason ?? new Error("Wait aborted"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      let yieldWait!: () => void;
      const pending = new Promise<typeof yielded>((resolve) => {
        yieldWait = () => resolve(yielded);
        yielders.add(yieldWait);
      });
      try {
        const settled = await Promise.race([waiter.promise, aborted, pending]);
        if (settled === yielded)
          return {
            content: [
              {
                type: "text",
                text: `Wait yielded to human input. Asynchronous result ${params.id} is still pending; use this same wait_id when its result is needed.`,
              },
            ],
            details: { id: params.id, wait_id: params.id, pending: true },
          };
        host.sync(ctx);
        if (!settled || typeof settled.deliveryKey !== "string" || !settled.deliveryKey.trim())
          throw new Error("Producer returned an invalid V1 delivery key");
        if (!fresh())
          throw new Error(
            "Goal or producer scope changed while waiting; owned result retained without notification",
          );
        grant?.assertCurrent(params);
        const prior = deliveryClaims.get(settled.deliveryKey);
        if (prior)
          throw new Error(
            prior === "delivered"
              ? "This response was already delivered through another handle"
              : "Another handle is already delivering this response",
          );
        deliveryClaims.set(settled.deliveryKey, "claimed");
        // Recheck immediately before the one point where the result becomes visible to the model.
        try {
          host.sync(ctx);
          grant?.assertCurrent(params);
          if (!fresh())
            throw new Error(
              "Goal or producer scope changed before delivery; owned result retained without notification",
            );
        } catch (error) {
          deliveryClaims.delete(settled.deliveryKey);
          throw error;
        }
        pi.appendEntry(DELIVERY_ENTRY, { version: 1, deliveryKey: settled.deliveryKey });
        deliveryClaims.set(settled.deliveryKey, "delivered");
        waiters.delete(params.id);
        releaseWaiter(waiter);
        return {
          content: [
            {
              type: "text",
              text: `Asynchronous result ${params.id}: ${typeof settled.value === "string" ? settled.value : JSON.stringify(settled.value)}`,
            },
          ],
          details: {
            id: params.id,
            owner: waiter.owner,
            producerGeneration: waiter.producerGeneration,
            deliveryKey: settled.deliveryKey,
            result: settled.value,
          },
        };
      } catch (error) {
        // Once the goal accepted ownership, failures and stale completions never fall back to a standalone wake.
        if (
          ctx.sessionManager.getSessionId() === waitSessionId &&
          host.current().sessionId === waitSessionId
        )
          host.disarm(
            ctx,
            waiter,
            `wait interrupted: ${error instanceof Error ? error.message : String(error)}`,
          );
        releaseWaiter(waiter);
        throw error;
      } finally {
        yielders.delete(yieldWait);
        waitAborters.delete(controller);
        host.refreshStatus(ctx);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", abort);
        ctx.signal?.removeEventListener("abort", abort);
        grant?.signal.removeEventListener("abort", abort);
      }
    },
  };
}
