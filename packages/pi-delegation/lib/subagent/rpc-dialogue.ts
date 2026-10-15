import { StringDecoder } from "node:string_decoder";
import type { BackgroundService } from "../background/service.ts";
import type { Snapshot, Stream } from "../background/types.ts";
import { readUsage, emptyUsage, addUsage, newSemanticId, type UsageRecord } from "pi-runtime";
import type { Usage } from "@earendil-works/pi-ai";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const HISTORY_LIMIT = 128;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
type Status = "busy" | "idle" | "failed" | "closed";
export interface DialogueReply {
  sequence: number;
  requestIds: string[];
  text: string;
  truncated?: boolean;
  usage?: unknown;
  model?: string;
  usageSummary?: { usage: Usage; missing: number };
}
interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface ReplyWaiter {
  resolve(reply: DialogueReply): void;
  reject(error: Error): void;
}
interface CompletedTurn {
  text: string;
  requestIds: string[];
  usage?: unknown;
  model?: string;
}

export class RpcDialogue {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextRequest = 0;
  private pending = new Map<string, Pending>();
  private replies: DialogueReply[] = [];
  private replyBytes = 0;
  private lostReplies = 0;
  private currentRequestIds: string[] = [];
  private queuedRequestIds: string[] = [];
  private completedTurns: CompletedTurn[] = [];
  private replyWaiters = new Map<string, ReplyWaiter>();
  private assistantText = "";
  private assistantUsage?: unknown;
  private assistantModel?: string;
  private assistantFailure?: string;
  private status: Status = "busy";
  private failure?: string;
  private retryable = false;
  private failureRequestIds: string[] = [];
  private settled?: () => void;
  private idleWait?: Promise<void>;
  private stderr = "";
  private dead = false;
  private protocolBroken = false;
  private readonly service: BackgroundService;
  readonly id: string;
  private readonly onReply?: (reply: DialogueReply) => void;
  private readonly onFailure?: () => void;
  private readonly stockRpc: boolean;
  private readonly isCurrent: () => boolean;
  private usageSequence = 0;
  private sessionUsage = emptyUsage();
  private missingUsage = 0;
  private readonly onUsage?: (record: UsageRecord) => void;

  constructor(
    service: BackgroundService,
    id: string,
    onReply?: (reply: DialogueReply) => void,
    onFailure?: () => void,
    isCurrent: () => boolean = () => true,
    stockRpc = false,
    onUsage?: (record: UsageRecord) => void,
  ) {
    this.stockRpc = stockRpc;
    this.service = service;
    this.id = id;
    this.onReply = onReply;
    this.onFailure = onFailure;
    this.isCurrent = isCurrent;
    this.onUsage = onUsage;
  }

  data(stream: Stream, bytes: Buffer): void {
    if (!this.current()) return;
    if (this.dead || this.protocolBroken || this.status === "closed") return;
    if (stream === "stderr") {
      this.stderr = (this.stderr + bytes.toString("utf8")).slice(-8192);
      return;
    }
    this.buffer += this.decoder.write(bytes);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.parse(line);
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.fail("RPC JSONL line exceeds 4 MiB");
  }

  private parse(line: string): void {
    if (this.dead || this.protocolBroken || this.status === "closed") return;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      this.fail("RPC JSONL line exceeds 4 MiB");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("Malformed RPC JSONL from child");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.fail("Invalid RPC JSONL record shape");
      return;
    }
    const value = parsed as Record<string, unknown>;
    if (value.type === "bridge_error") {
      this.fail(typeof value.error === "string" ? value.error : "Fixed dialogue bridge failed");
      return;
    }
    if (value.type === "response") {
      if (typeof value.id !== "string") {
        this.fail("Invalid RPC response ID");
        return;
      }
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if (typeof value.success !== "boolean") {
          pending.reject(new Error("RPC response is missing boolean success"));
          this.fail("Invalid RPC response shape");
        } else if (value.success === false)
          pending.reject(new Error(String(value.error ?? "RPC request failed")));
        else pending.resolve(value);
      }
      return;
    }
    if (value.type === "message_end") {
      if (
        typeof value.message !== "object" ||
        value.message === null ||
        Array.isArray(value.message)
      ) {
        this.fail("Invalid RPC message_end shape");
        return;
      }
      const msg = value.message as {
        role?: unknown;
        content?: unknown;
        usage?: unknown;
        model?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
      };
      if (msg.role !== "assistant") return;
      if (
        !Array.isArray(msg.content) ||
        msg.content.some((c) => typeof c !== "object" || c === null || Array.isArray(c))
      ) {
        this.fail("Invalid assistant content in RPC message_end");
        return;
      }
      const content = msg.content as { type?: unknown; text?: unknown }[];
      if (content.some((c) => c.type === "text" && typeof c.text !== "string")) {
        this.fail("Invalid assistant text content in RPC message_end");
        return;
      }
      this.assistantText = content
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .join("\n");
      this.assistantUsage = msg.usage;
      const usage = readUsage(msg.usage);
      if (usage) this.sessionUsage = addUsage(this.sessionUsage, usage);
      const incomplete = !usage || usage.totalTokens === 0;
      if (incomplete) this.missingUsage++;
      this.refreshReplyUsageSummaries();
      this.onUsage?.({
        id: `${this.id}:message:${++this.usageSequence}`,
        kind: "child",
        source: this.id,
        label: "Child agent",
        usage,
        incomplete,
        model: typeof msg.model === "string" ? msg.model : undefined,
      });
      this.assistantModel = typeof msg.model === "string" ? msg.model : undefined;
      if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.stopReason === "length")
        this.assistantFailure =
          msg.stopReason === "length"
            ? String(msg.errorMessage ?? "Assistant response reached the model output limit")
            : String(msg.errorMessage ?? `Assistant turn ${String(msg.stopReason)}`);
      return;
    }
    if (
      value.type === "message_start" &&
      typeof value.message === "object" &&
      value.message !== null &&
      !Array.isArray(value.message) &&
      (value.message as { role?: unknown }).role === "assistant"
    ) {
      this.assistantText = "";
      this.assistantUsage = undefined;
      this.assistantModel = undefined;
      this.assistantFailure = undefined;
      return;
    }
    if (value.type === "turn_end") {
      if (
        typeof value.message !== "object" ||
        value.message === null ||
        Array.isArray(value.message)
      )
        return;
      const message = value.message as { role?: unknown; content?: unknown; stopReason?: unknown };
      if (
        message.role !== "assistant" ||
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        message.stopReason === "length"
      )
        return;
      if (
        !Array.isArray(message.content) ||
        message.content.some((c) => typeof c !== "object" || c === null || Array.isArray(c))
      )
        return;
      const content = message.content as { type?: unknown; text?: unknown }[];
      if (content.some((c) => c.type === "toolCall")) return;
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      if (!text) return;
      this.completedTurns.push({
        text,
        requestIds: [...this.currentRequestIds],
        ...(this.assistantUsage === undefined ? {} : { usage: this.assistantUsage }),
        ...(this.assistantModel === undefined ? {} : { model: this.assistantModel }),
      });
      this.currentRequestIds = this.queuedRequestIds.splice(0);
      this.assistantText = "";
      this.assistantUsage = undefined;
      this.assistantModel = undefined;
      return;
    }
    if (value.type === "agent_settled") {
      if (typeof value.aborted !== "boolean") {
        this.fail("agent_settled is missing boolean aborted state");
        return;
      }
      if (value.aborted) {
        for (const turn of this.completedTurns.splice(0)) this.recordReply(turn);
        this.assistantText = "";
        this.assistantUsage = undefined;
        this.assistantModel = undefined;
        this.assistantFailure ??= "Assistant run aborted";
      }
      if (this.status === "failed") return;
      if (this.assistantFailure) {
        const failure = this.assistantFailure;
        this.assistantText = "";
        this.assistantUsage = undefined;
        this.assistantModel = undefined;
        this.assistantFailure = undefined;
        for (const turn of this.completedTurns.splice(0)) this.recordReply(turn);
        this.status = "failed";
        this.failure = failure;
        this.retryable = true;
        this.failureRequestIds = this.currentRequestIds;
        this.rejectAllReplyWaiters(new Error(failure));
        this.currentRequestIds = [];
        this.settled?.();
        this.settled = undefined;
        this.idleWait = undefined;
        return;
      }
      this.status = "idle";
      if (this.onUsage && this.stockRpc) void this.reconcileUsage();
      const turns = this.completedTurns.splice(0);
      if (turns.length) {
        for (const turn of turns) this.recordReply(turn);
        // A prompt can arrive while Pi is emitting agent_settled. Its RPC ack is
        // deferred by the SDK, so preserve its ID across the previous turn's settle.
        this.currentRequestIds = [
          ...new Set([...this.currentRequestIds, ...this.queuedRequestIds.splice(0)]),
        ];
      } else if (this.assistantText) {
        if (!this.currentRequestIds.length) {
          const failure = "Assistant settled an answer without a matching request";
          this.status = "failed";
          this.failure = failure;
          this.retryable = false;
          this.rejectAllReplyWaiters(new Error(failure));
          this.settled?.();
          this.settled = undefined;
          this.idleWait = undefined;
          this.assistantText = "";
          this.assistantUsage = undefined;
          this.assistantModel = undefined;
          return;
        }
        this.recordReply({
          text: this.assistantText,
          requestIds: [...this.currentRequestIds],
          ...(this.assistantUsage === undefined ? {} : { usage: this.assistantUsage }),
          ...(this.assistantModel === undefined ? {} : { model: this.assistantModel }),
        });
        this.currentRequestIds = this.queuedRequestIds.splice(0);
      } else if (this.currentRequestIds.some((id) => this.pending.has(id))) {
        // The prior turn settled while the SDK was still dispatching a prompt
        // deferred from its agent_settled callback. That event is not an answer.
        this.status = "busy";
        this.currentRequestIds = [
          ...new Set([...this.currentRequestIds, ...this.queuedRequestIds.splice(0)]),
        ];
        this.assistantFailure = undefined;
        this.settled?.();
        this.settled = undefined;
        this.idleWait = undefined;
        return;
      } else if (this.currentRequestIds.length) {
        const failure = "Assistant settled without a text answer";
        this.status = "failed";
        this.failure = failure;
        this.retryable = true;
        this.failureRequestIds = [...this.currentRequestIds];
        this.rejectAllReplyWaiters(new Error(failure));
        this.currentRequestIds = this.queuedRequestIds.splice(0);
        this.assistantText = "";
        this.assistantUsage = undefined;
        this.assistantModel = undefined;
        this.settled?.();
        this.settled = undefined;
        this.idleWait = undefined;
        return;
      } else {
        this.currentRequestIds = this.queuedRequestIds.splice(0);
      }
      this.assistantFailure = undefined;
      this.settled?.();
      this.settled = undefined;
      this.idleWait = undefined;
    }
  }

  private fail(reason: string): void {
    if (this.status === "closed" || this.status === "failed") return;
    this.protocolBroken = true;
    this.status = "failed";
    this.failure = reason;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
    this.settled?.();
    this.settled = undefined;
    for (const [id] of this.replyWaiters) this.rejectReplyWaiter(id, new Error(reason));
    this.onFailure?.();
  }

  private current(): boolean {
    if (this.isCurrent()) return true;
    if (this.status !== "closed") this.fail("Dialogue permission or session grant was revoked");
    return false;
  }

  /** Wait for one exact request's completed answer; acknowledgements never resolve this promise. */
  waitForRequest(requestId: string): Promise<DialogueReply> {
    const reply = this.replies.find((candidate) => candidate.requestIds.includes(requestId));
    if (reply) return Promise.resolve(reply);
    if (this.failureRequestIds.includes(requestId))
      return Promise.reject(new Error(this.failure ?? "Dialogue request failed"));
    if (this.dead || this.status === "closed" || (this.status === "failed" && !this.retryable))
      return Promise.reject(new Error(this.failure ?? `Dialogue ${this.id} is ${this.status}`));
    if (this.replyWaiters.has(requestId))
      throw new Error(`A response waiter already exists for ${requestId}`);
    const promise = new Promise<DialogueReply>((resolve, reject) =>
      this.replyWaiters.set(requestId, { resolve, reject }),
    );
    // The waiter is an optional event capability; absent consumers must not cause an unhandled rejection.
    void promise.catch(() => {});
    return promise;
  }

  private resolveReplyWaiter(requestId: string, reply: DialogueReply): void {
    const waiter = this.replyWaiters.get(requestId);
    if (!waiter) return;
    this.replyWaiters.delete(requestId);
    waiter.resolve(reply);
  }

  private rejectReplyWaiter(requestId: string, error: Error): void {
    const waiter = this.replyWaiters.get(requestId);
    if (!waiter) return;
    this.replyWaiters.delete(requestId);
    waiter.reject(error);
  }

  private rejectAllReplyWaiters(error: Error): void {
    for (const [id] of this.replyWaiters) this.rejectReplyWaiter(id, error);
  }

  /** Stop retaining an offer after input interception or goal release; this never creates an answer. */
  releaseReplyWaiter(requestId: string, reason = "Dialogue response offer released"): void {
    this.rejectReplyWaiter(requestId, new Error(reason));
  }

  private recordReply(turn: CompletedTurn): void {
    const textBytes = Buffer.byteLength(turn.text);
    let replyText = turn.text,
      truncated = false;
    if (textBytes > MAX_REPLY_BYTES) {
      replyText = Buffer.from(turn.text).subarray(0, MAX_REPLY_BYTES).toString("utf8");
      truncated = true;
    }
    const reply: DialogueReply = {
      sequence: (this.replies.at(-1)?.sequence ?? this.lostReplies) + 1,
      requestIds: turn.requestIds,
      text: replyText,
      ...(truncated ? { truncated: true } : {}),
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      ...(turn.model === undefined ? {} : { model: turn.model }),
      ...(this.onUsage
        ? {
            usageSummary: { usage: structuredClone(this.sessionUsage), missing: this.missingUsage },
          }
        : {}),
    };
    this.replies.push(reply);
    this.replyBytes += Buffer.byteLength(replyText);
    while (this.replies.length > HISTORY_LIMIT || this.replyBytes > MAX_HISTORY_BYTES) {
      const removed = this.replies.shift();
      if (!removed) break;
      this.replyBytes -= Buffer.byteLength(removed.text);
      this.lostReplies++;
    }
    if (!this.current()) return;
    this.onReply?.(reply);
    for (const id of reply.requestIds) this.resolveReplyWaiter(id, reply);
  }

  accountAuxiliary(record: UsageRecord): void {
    const usage = readUsage(record.usage);
    if (usage) this.sessionUsage = addUsage(this.sessionUsage, usage);
    if (!usage || record.incomplete) this.missingUsage++;
    this.refreshReplyUsageSummaries();
    this.onUsage?.({ ...record, id: `${this.id}:auxiliary:${record.id}`, source: this.id });
  }

  async reconcileUsage(): Promise<void> {
    if (!this.onUsage || this.dead || !this.stockRpc || !this.current()) return;
    const id = `usage_stats_${++this.nextRequest}`;
    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error("Child usage statistics unavailable"));
        }, 2000);
        this.pending.set(id, { resolve, reject, timer });
        void this.service
          .write(this.id, Buffer.from(JSON.stringify({ type: "get_session_stats", id }) + "\n"))
          .catch((error) => {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          });
      });
      const stats = response.data as
        | {
            sessionId?: string;
            tokens?: {
              input: number;
              output: number;
              cacheRead: number;
              cacheWrite: number;
              total: number;
            };
            cost?: number;
          }
        | undefined;
      if (!stats?.tokens || !Number.isFinite(stats.cost)) return;
      const reported = readUsage({
        ...stats.tokens,
        totalTokens: stats.tokens.total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
      });
      if (!reported) return;
      const delta = emptyUsage();
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
        delta[key] = Math.max(0, reported[key] - this.sessionUsage[key]);
      delta.cost.total = Math.max(0, reported.cost.total - this.sessionUsage.cost.total);
      if (!delta.totalTokens && !delta.cost.total) return;
      this.sessionUsage = addUsage(this.sessionUsage, delta);
      this.refreshReplyUsageSummaries();
      this.onUsage({
        id: `${this.id}:stats:${stats.sessionId}:${reported.totalTokens}:${reported.cost.total}`,
        kind: "child",
        source: this.id,
        label: "Child session summaries",
        usage: delta,
      });
    } catch {
      /* Per-message records remain available if the process has already exited. */
    }
  }

  request<T extends Record<string, unknown>>(
    body: Record<string, unknown>,
    literalText?: string,
    trackId?: (id: string) => void,
  ): Promise<T> {
    if (!this.current())
      return Promise.reject(new Error("Dialogue permission or session grant was revoked"));
    if (this.dead || this.status === "closed" || this.status === "failed")
      return Promise.reject(new Error(this.failure ?? `Dialogue ${this.id} is ${this.status}`));
    const id = ["prompt", "steer", "follow_up"].includes(String(body.type))
      ? newSemanticId("message")
      : `rpc_${++this.nextRequest}`;
    trackId?.(id);
    const control = body.type === "follow_up" ? "followUp" : body.type;
    const data = Buffer.from(
      `${JSON.stringify({ version: 1, ...body, type: this.stockRpc ? body.type : control, ...(literalText === undefined ? {} : this.stockRpc ? { message: literalText } : { text: literalText }), id })}\n`,
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(`Timed out waiting for RPC acknowledgement to ${String(body.type)}`),
        30_000,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void Promise.resolve()
        .then(() => {
          if (!this.current())
            throw new Error(
              "Dialogue permission or session grant was revoked before transport write",
            );
          return this.service.write(this.id, data);
        })
        .catch((error) => {
          const pending = this.pending.get(id);
          if (pending) clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async start(
    initialPrompt: string,
    beforeDispatch?: (requestId: string) => void,
  ): Promise<{ requestId: string; disposition?: unknown }> {
    let requestId = "";
    const response = await this.request<{ id?: string; data?: { disposition?: unknown } }>(
      { type: "prompt" },
      initialPrompt,
      (id) => {
        requestId = id;
        this.currentRequestIds.push(id);
        beforeDispatch?.(id);
      },
    );
    if (response.data?.disposition !== "handled" && this.replies.length === 0) this.status = "busy";
    return { requestId: requestId || String(response.id), disposition: response.data?.disposition };
  }

  async message(
    text: string,
    mode: "steer" | "followUp",
    beforeDispatch?: (requestId: string) => void,
  ): Promise<{ requestId: string; disposition: unknown }> {
    if (!text.trim()) throw new Error("Message must not be empty");
    if (this.status === "closed" || (this.status === "failed" && !this.retryable))
      throw new Error(this.failure ?? `Dialogue ${this.id} is ${this.status}`);
    const previous = this.status;
    const previousFailure = this.failure;
    const previousFailureIds = [...this.failureRequestIds];
    const repliesBefore = this.replies.length;
    const command =
      previous === "failed" || previous === "idle"
        ? "prompt"
        : mode === "steer"
          ? "steer"
          : "follow_up";
    if (previous === "failed") this.currentRequestIds = [];
    this.failure = undefined;
    this.retryable = false;
    this.failureRequestIds = [];
    this.status = "busy";
    let response: { id?: string; data?: { disposition?: unknown } };
    let dispatchedRequestId = "";
    try {
      response = await this.request<{ id?: string; data?: { disposition?: unknown } }>(
        { type: command },
        text,
        (id) => {
          dispatchedRequestId = id;
          if (command === "follow_up" && this.currentRequestIds.length === 0)
            this.currentRequestIds.push(id);
          else if (command === "follow_up") this.queuedRequestIds.push(id);
          else if (command === "prompt") this.currentRequestIds = [id];
          else this.currentRequestIds.push(id);
          beforeDispatch?.(id);
        },
      );
    } catch (error) {
      this.currentRequestIds = this.currentRequestIds.filter((id) => id !== dispatchedRequestId);
      this.queuedRequestIds = this.queuedRequestIds.filter((id) => id !== dispatchedRequestId);
      if (this.status === "busy" && this.replies.length === repliesBefore) {
        this.status = previous;
        this.failure = previousFailure;
        this.retryable = previous === "failed";
        this.failureRequestIds = previousFailureIds;
      }
      throw error;
    }
    if (response.data?.disposition === "handled") {
      this.currentRequestIds = this.currentRequestIds.filter((id) => id !== dispatchedRequestId);
      this.queuedRequestIds = this.queuedRequestIds.filter((id) => id !== dispatchedRequestId);
      if (this.replies.length === repliesBefore && this.status === "busy") this.status = previous;
    }
    return { requestId: String(response.id), disposition: response.data?.disposition };
  }

  async waitIdle(timeoutMs = 60_000): Promise<void> {
    if (this.status === "idle") return;
    if (this.status === "failed") throw new Error(this.failure);
    if (!this.idleWait)
      this.idleWait = new Promise((resolve) => {
        this.settled = resolve;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.idleWait,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out waiting for agent_settled")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if ((this.status as Status) === "failed") throw new Error(this.failure);
  }

  complete(snapshot: Snapshot): void {
    if (this.dead) return;
    const exitFailure =
      snapshot.reason ??
      `Child exited before the dialogue was closed (${snapshot.exitCode})${this.stderr ? `: ${this.stderr}` : ""}`;
    if (this.status !== "closed" && this.status !== "failed") this.fail(exitFailure);
    else if (this.status === "failed" && this.retryable) {
      this.failure = exitFailure;
      this.retryable = false;
    }
    if (this.decoder.end().length > 0)
      this.fail("Child exited with an incomplete UTF-8 RPC record");
    if (this.buffer.trim()) this.fail("Child exited with a partial RPC JSONL record");
    this.buffer = "";
    this.dead = true;
  }

  close(): void {
    this.status = "closed";
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Dialogue closed"));
    }
    this.pending.clear();
    for (const [id] of this.replyWaiters) this.rejectReplyWaiter(id, new Error("Dialogue closed"));
    this.settled?.();
    this.settled = undefined;
  }
  /** Active inputs observed when source telemetry arrives; queued follow-ups are excluded. */
  activeRequestIds(): string[] {
    return this.status === "busy" ? [...this.currentRequestIds] : [];
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      failure: this.failure,
      retryable: this.retryable,
      failureRequestIds: [...this.failureRequestIds],
      replies: [...this.replies],
      replyCursor: this.replies.at(-1)?.sequence ?? this.lostReplies,
      retainedFrom: this.replies[0]?.sequence ?? this.lostReplies + 1,
      lostReplies: this.lostReplies,
      pendingRequests: this.pending.size,
      ...(this.onUsage
        ? {
            usageSummary: {
              usage: structuredClone(this.sessionUsage),
              missing: this.missingUsage,
            },
          }
        : {}),
    };
  }

  private refreshReplyUsageSummaries(): void {
    for (const reply of this.replies) {
      if (!reply.usageSummary) continue;
      reply.usageSummary.usage = structuredClone(this.sessionUsage);
      reply.usageSummary.missing = this.missingUsage;
    }
  }
}
