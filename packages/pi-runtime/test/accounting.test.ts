import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { USAGE_EVENT } from "pi-contracts";
import { installAccounting } from "../src/accounting.ts";
import { emptyUsage } from "../src/usage.ts";

function fixture(sessionManager = SessionManager.inMemory()) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events = new Map<string, (value: any) => void>();
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const commands = new Map<string, any>();
  const ctx = {
    sessionManager,
    ui: {
      setStatus: (name: string, text?: string) => statuses.set(name, text),
      notify: (text: string) => notices.push(text),
    },
  };
  const pi = {
    events: {
      on: (name: string, fn: any) => events.set(name, fn),
      emit: (name: string, value: any) => events.get(name)?.(value),
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    appendEntry: (name: string, value: any) => sessionManager.appendCustomEntry(name, value),
    registerCommand: (name: string, value: any) => commands.set(name, value),
  };
  installAccounting(pi as any);
  handlers.get("session_start")!({}, ctx);
  return { pi, ctx, handlers, notices, statuses, commands };
}

test("final evaluator usage appears in costs immediately, forwards once, and replays without duplication", async () => {
  const f = fixture();
  const usage = { ...emptyUsage(), input: 20, output: 4, totalTokens: 24 };
  usage.cost.total = 0.01;
  const record = {
    id: "evaluation-1",
    kind: "evaluator",
    source: "goal",
    ownerSessionId: f.ctx.sessionManager.getSessionId(),
    label: "Goal evaluator",
    provider: "fixture",
    model: "test",
    usage,
  };
  f.pi.events.emit(USAGE_EVENT, record);
  f.pi.events.emit(USAGE_EVENT, record);
  assert.equal(f.statuses.get("pi-usage"), undefined);
  const entries = f.ctx.sessionManager.getEntries();
  const native = entries.filter((e) => e.type === "usage");
  assert.equal(native.length, 0);
  const forwarded = f.handlers.get("tool_result")!({});
  assert.equal(forwarded.usage.totalTokens, 24);
  assert.equal(f.handlers.get("tool_result")!({}), undefined);
  f.ctx.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "next-tool",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 0,
    details: forwarded.details,
    usage: forwarded.usage,
  });
  await f.commands.get("costs").handler("", f.ctx);
  assert.match(f.notices[0], /Main model calls and summaries: 0 tokens/);
  assert.match(f.notices[0], /evaluator: Goal evaluator.*24 tokens/);
  assert.match(f.notices[0], /Session total: 24 tokens/);
  const resumed = fixture(f.ctx.sessionManager);
  assert.equal(resumed.handlers.get("tool_result")!({}), undefined);
  resumed.pi.events.emit(USAGE_EVENT, record);
  assert.equal(f.ctx.sessionManager.getEntries().filter((e) => e.type === "usage").length, 0);
});

test("evaluator-only work stays in accounting without a second footer", () => {
  const f = fixture();
  const usage = { ...emptyUsage(), input: 18, output: 3, totalTokens: 21 };
  f.pi.events.emit(USAGE_EVENT, {
    id: "evaluation-status",
    kind: "evaluator",
    source: "goal",
    ownerSessionId: f.ctx.sessionManager.getSessionId(),
    label: "Goal evaluator",
    usage,
  });
  assert.equal(f.statuses.get("pi-usage"), undefined);
});

test("unknown evaluator usage stays missing; later valid receipt is recorded once", () => {
  const f = fixture();
  const record = { id: "evaluation-2", kind: "evaluator", source: "goal", label: "Goal evaluator" };
  f.pi.events.emit(USAGE_EVENT, record);
  assert.equal(f.ctx.sessionManager.getEntries().filter((e) => e.type === "usage").length, 0);
  const usage = { ...emptyUsage(), output: 2, totalTokens: 2 };
  f.pi.events.emit(USAGE_EVENT, { ...record, usage });
  assert.equal(f.ctx.sessionManager.getEntries().filter((e) => e.type === "usage").length, 0);
  assert.equal(f.handlers.get("tool_result")!({}).usage.totalTokens, 2);
  assert.equal(f.handlers.get("tool_result")!({}), undefined);
});

test("combined session totals count child, classifiers and evaluator exactly once across resume", async () => {
  const f = fixture();
  const u = (n: number) => ({
    ...emptyUsage(),
    input: n,
    totalTokens: n,
    cost: { input: n / 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 1000 },
  });
  f.ctx.sessionManager.appendMessage({
    role: "assistant",
    content: [],
    usage: u(10),
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: 0,
  });
  for (const [id, kind, tokens] of [
    ["child-1", "child", 20],
    ["classifier-1", "classifier", 3],
    ["evaluator-1", "evaluator", 4],
  ] as const)
    f.pi.events.emit(USAGE_EVENT, { id, kind, source: id, label: id, usage: u(tokens) });
  await f.commands.get("costs").handler("", f.ctx);
  assert.match(f.notices.at(-1)!, /Session total: 37 tokens · \$0.0370/);
  const forwarded = f.handlers.get("tool_result")!({});
  f.ctx.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "fixture",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 0,
    ...forwarded,
  });
  const resumed = fixture(f.ctx.sessionManager);
  await resumed.commands.get("costs").handler("", resumed.ctx);
  assert.match(resumed.notices.at(-1)!, /Session total: 37 tokens · \$0.0370/);
  assert.equal(resumed.handlers.get("tool_result")!({}), undefined);
  resumed.pi.events.emit(USAGE_EVENT, {
    id: "missing",
    kind: "evaluator",
    source: "goal",
    label: "Goal evaluator",
  });
  await resumed.commands.get("costs").handler("", resumed.ctx);
  assert.match(resumed.notices.at(-1)!, /incomplete \(1\)/);
  assert.equal(resumed.statuses.get("pi-usage"), undefined);
});
