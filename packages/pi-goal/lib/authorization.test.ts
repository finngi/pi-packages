import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";
import { MAX_GOAL_CRITERIA, MAX_GOAL_TEXT_FIELD_CHARS } from "./limits.ts";
import { reduceGoal } from "./goal.ts";

function fixture() {
  const hooks = new Map<string, Function[]>(),
    events = new Map<string, Function[]>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  const branch: any[] = [];
  let session = "first";
  const controller = new AbortController();
  const ctx: any = {
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
    hasUI: false,
    signal: controller.signal,
    abort() {},
    ui: { notify() {}, setStatus() {} },
  };
  const api: any = {
    on: (name: string, handler: Function) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    events: {
      on: (name: string, handler: Function) =>
        events.set(name, [...(events.get(name) ?? []), handler]),
      emit: (name: string, value: unknown) => {
        for (const handler of events.get(name) ?? []) handler(value);
      },
    },
    sendUserMessage() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  extension(api as ExtensionAPI);
  const emit = async (name: string, value: unknown = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(value, ctx);
  };
  return {
    api,
    branch,
    ctx,
    tools,
    emit,
    run: (name: string, input: any, grant?: any) =>
      tools.get(name).execute("call", input, controller.signal, undefined, ctx, grant),
    command: (input: string) => commands.get("goal").handler(input, ctx),
    switchSession: () => {
      session = "second";
    },
  };
}

test("create_goal schema advertises the same fixed criterion limit as runtime validation", () => {
  const f = fixture();
  assert.equal(
    f.tools.get("create_goal").parameters.properties.criteria.maxItems,
    MAX_GOAL_CRITERIA,
  );
  assert.equal(
    f.tools.get("create_goal").parameters.properties.objective.maxLength,
    MAX_GOAL_TEXT_FIELD_CHARS,
  );
  assert.equal(
    f.tools.get("create_goal").parameters.properties.criteria.items.maxLength,
    MAX_GOAL_TEXT_FIELD_CHARS,
  );
});

test("oversized goal text is rejected before asking for authorization", async () => {
  const f = fixture();
  await f.emit("session_start");
  await assert.rejects(
    f.run("create_goal", { objective: "x".repeat(MAX_GOAL_TEXT_FIELD_CHARS + 1) }),
    /bounded evaluator input limits/,
  );
  await assert.rejects(
    f.run("create_goal", { objective: "\u0000".repeat(4_000) }),
    /bounded evaluator input limits/,
  );
  assert.equal(f.branch.length, 0);
});

test("creation grant includes exact criteria, is one-use, and does not authorize replacement", async () => {
  const f = fixture();
  await f.emit("session_start");
  const auth = { objective: "full objective", budget: 100, criteria: ["first", "second"] };
  f.api.events.emit("goal:create_authorization", auth);
  await assert.rejects(f.run("create_goal", { ...auth, criteria: ["first"] }), /confirmation/);
  await f.run("create_goal", { ...auth, criteria: [...auth.criteria] });
  const current = (await f.run("get_goal", {})).details;
  assert.deepEqual(
    current.criteria.map((item: any) => item.requirement),
    auth.criteria,
  );
  await assert.rejects(f.run("create_goal", auth), /confirmation/);
  const state = f.branch.filter((entry: any) => entry.customType === "pi-goal.state").at(-1)
    .data.state;
  f.api.appendEntry("pi-goal.state", {
    state: reduceGoal(state, {
      type: "audit",
      requirements: current.criteria.map((item: any) => ({
        criterionId: item.id,
        evidence: "checked fixture",
        verdict: "met",
      })),
    }),
  });
  await assert.rejects(f.run("create_goal", auth), /confirmation/);
});

test("trusted creation authorization binds the exact deadline and persists its resolved timestamp", async () => {
  const f = fixture();
  await f.emit("session_start");
  const authorization = { objective: "finish the review", deadline: "30m" };
  f.api.events.emit("goal:create_authorization", authorization);
  await assert.rejects(
    f.run("create_goal", { objective: authorization.objective, deadline: "31m" }),
    /confirmation/,
  );
  const before = Date.now();
  await f.run("create_goal", authorization);
  const goal = (await f.run("get_goal", {})).details;
  assert.ok(goal.deadlineAt >= before + 30 * 60_000);
  assert.ok(goal.deadlineAt <= Date.now() + 30 * 60_000);
});

test("session/branch replacement and changed goal scope revoke pending host authorization", async () => {
  for (const change of ["session", "branch", "goal"] as const) {
    const f = fixture();
    await f.emit("session_start");
    if (change === "goal") await f.command("start old");
    const auth = { objective: "new" };
    f.api.events.emit("goal:create_authorization", auth);
    if (change === "session") {
      f.switchSession();
      await f.emit("session_start");
    }
    if (change === "branch") await f.emit("session_tree");
    if (change === "goal") await f.command("edit different");
    await assert.rejects(f.run("create_goal", auth), /confirmation/);
  }
});

test("interactive confirmation cannot create after human edits while it waits", async () => {
  const f = fixture();
  await f.emit("session_start");
  let resolve!: (value: boolean) => void;
  f.ctx.hasUI = true;
  f.ctx.ui.confirm = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.run("create_goal", { objective: "requested" });
  await f.command("start human scope");
  resolve(true);
  await assert.rejects(pending, /confirmation is stale/);
  assert.equal((await f.run("get_goal", {})).content[0].text.includes("human scope"), true);
});

test("canonical goal execution requires fresh grants adjacent to atomic persistence", async () => {
  const f = fixture();
  await f.emit("session_start");
  f.api.events.emit("permissions:effect-declarations:v1", {
    version: 1,
    declare() {},
    wrapToolExecution: (_owner: unknown, tool: any) => ({ ...tool }),
  });
  const auth = { objective: "full" };
  f.api.events.emit("goal:create_authorization", auth);
  await assert.rejects(f.run("create_goal", auth), /grant is missing/);
  let checks = 0;
  const revoked = {
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (++checks > 1) throw Error("revoked grant");
    },
    dispatch: (_input: unknown, operation: Function) => operation(),
  };
  await assert.rejects(f.run("create_goal", auth, revoked), /revoked grant/);
  assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.state").length, 0);
  const fresh = {
    signal: new AbortController().signal,
    assertCurrent() {},
    dispatch: (_input: unknown, operation: Function) => operation(),
  };
  await f.run("create_goal", auth, fresh);
  assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.state").length, 1);
});
