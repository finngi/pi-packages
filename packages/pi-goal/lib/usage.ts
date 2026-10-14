import { randomUUID } from "node:crypto";
import type { GoalState } from "./goal.ts";
const REQUEST_AUTHORITY = Symbol("pi-goal-request-authority");
export interface RequestAuthority {
  requestId: string;
  sessionId: string;
  branchToken: string;
  signal?: AbortSignal;
  goal?: { id: string; revision: number };
  dispatched: boolean;
}
/** One main-model response per request; delegated tool usage never enters this ledger. */
export class GoalRequests {
  private current?: RequestAuthority;
  private dispatched?: RequestAuthority;
  private runGoal?: RequestAuthority["goal"];
  cycleId: string = randomUUID();
  prepare(
    goal: GoalState | undefined,
    sessionId: string,
    branchToken: string,
    signal?: AbortSignal,
  ) {
    if (goal?.status === "active") this.runGoal = { id: goal.id, revision: goal.revision };
    const request: RequestAuthority = {
      requestId: randomUUID(),
      sessionId,
      branchToken,
      signal,
      goal: this.runGoal,
      dispatched: false,
    };
    this.current = request;
    this.cycleId = request.requestId;
    return request;
  }
  find(
    messages: readonly any[],
    sessionId?: string,
    signal?: AbortSignal,
  ): RequestAuthority | undefined {
    const current = this.current;
    if (!current || sessionId !== current.sessionId || signal !== current.signal) return;
    if (messages.some((message) => message[REQUEST_AUTHORITY] === current.requestId))
      return current;
  }
  bind(messages: readonly any[], request: RequestAuthority): any[] {
    if (request !== this.current) throw Error("Goal request authority is stale");
    const index = messages.findLastIndex((message) =>
      ["user", "assistant", "toolResult"].includes(message.role),
    );
    if (index < 0) throw Error("Main provider request has no ordinary message to bind");
    // Custom messages are converted by Pi; ordinary messages survive the conversion.
    // Symbols survive shallow copies but never enter serialized provider text.
    return messages.map((message, position) =>
      position === index ? { ...message, [REQUEST_AUTHORITY]: request.requestId } : message,
    );
  }

  dispatch(request: RequestAuthority) {
    if (request !== this.current || request.dispatched)
      throw Error("Goal request authority was already consumed or superseded");
    request.dispatched = true;
    this.dispatched = request;
  }
  takeResponse(): RequestAuthority | undefined {
    const receipt = this.dispatched;
    this.dispatched = undefined;
    return receipt;
  }
  startRun() {
    this.current = undefined;
    this.dispatched = undefined;
    this.runGoal = undefined;
  }
  reset() {
    this.runGoal = undefined;
    this.current = undefined;
    this.dispatched = undefined;
    this.cycleId = randomUUID();
  }
}
