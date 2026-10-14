import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/goal.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OwnedWaiterOfferV1 } from "./goal.ts";

function setup(branch: any[] = []) {
  const hooks = new Map<string, Function[]>(),
    events = new Map<string, Function[]>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  let session = "fixture-session";
  const ctx: any = {
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
    hasUI: false,
    signal: undefined,
    abort() {},
    ui: {
      notify() {},
      setStatus: (name: string, text: string | undefined) => statuses.set(name, text),
    },
  };
  const api: any = {
    on: (name: string, fn: Function) => {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    events: {
      on: (name: string, fn: Function) => {
        events.set(name, [...(events.get(name) ?? []), fn]);
      },
      emit: (name: string, value: unknown) => {
        for (const fn of events.get(name) ?? []) fn(value);
      },
    },
    sendUserMessage() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  extension(api as ExtensionAPI);
  const emit = async (name: string, value: any = {}) => {
    const values = [];
    for (const hook of hooks.get(name) ?? []) values.push(await hook(value, ctx));
    return values;
  };
  const run = (name: string, input: any, signal?: AbortSignal) =>
    tools.get(name).execute("call", input, signal, undefined, ctx);
  return {
    api,
    branch,
    ctx,
    statuses,
    emit,
    run,
    command: (args: string) => commands.get("goal").handler(args, ctx),
    switchSession: () => {
      session = "other-session";
    },
  };
}
function offer(f: ReturnType<typeof setup>, id: string, deliveryKey = "same-reply") {
  let resolve!: (value: any) => void,
    accepted = false,
    released = 0;
  let release = () => {},
    current = true;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  const value: OwnedWaiterOfferV1 = {
    version: 1,
    id,
    owner: "subagent",
    sessionId: f.ctx.sessionManager.getSessionId(),
    producerGeneration: "fixture-generation",
    promise,
    isCurrent: () => current,
    respond: (result) => {
      accepted = result.accepted;
      if (result.accepted) release = result.release;
    },
  };
  f.api.events.emit("goal:waiter", value);
  return {
    accepted,
    resolve: () =>
      resolve({
        deliveryKey,
        value: { text: "answer", sequence: 1, requestIds: ["request"] },
      }),
    revoke: () => {
      current = false;
    },
    release: () => {
      released++;
      release();
    },
    get released() {
      return released;
    },
  };
}
test("versioned offer binds exact scope, result delivered once across handles and reload", async () => {
  const f = setup();
  await f.emit("session_start");
  await f.command("start fixture objective");
  const first = offer(f, "first"),
    second = offer(f, "second");
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  const summary = await f.run("get_goal", {});
  assert.match(summary.content[0].text, /2 owned wait handles pending/);
  first.resolve();
  second.resolve();
  const result = await f.run("wait_for_goal_event", { id: "first" });
  assert.equal(result.details.result.text, "answer");
  await assert.rejects(f.run("wait_for_goal_event", { id: "second" }), /already delivered/);
  assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.delivery.v1").length, 1);
  const restored = setup(f.branch);
  await restored.emit("session_start");
  await restored.command("resume");
  const third = offer(restored, "third");
  assert.equal(third.accepted, true);
  third.resolve();
  await assert.rejects(restored.run("wait_for_goal_event", { id: "third" }), /already delivered/);
});
test("unowned offers reject without active goal and malformed/duplicate offers cannot replace accepted ownership", async () => {
  const f = setup();
  await f.emit("session_start");
  assert.equal(offer(f, "absent").accepted, false);
  await f.command("start fixture objective");
  assert.equal(offer(f, "one").accepted, true);
  assert.equal(offer(f, "one").accepted, false);
  let response: any;
  f.api.events.emit("goal:waiter", {
    version: 2,
    id: "invalid",
    respond: (value: any) => (response = value),
  });
  assert.deepEqual(response, { accepted: false });
});
test("a deadline crossed during the final sync prevents wait delivery", async () => {
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  try {
    const f = setup();
    await f.emit("session_start");
    await f.command("start --for 1s finish the task");
    const deadlineAt = f.branch.filter((entry) => entry.customType === "pi-goal.state").at(-1).data
      .state.deadlineAt;
    const owned = offer(f, "deadline-wait");
    const originalSetStatus = f.ctx.ui.setStatus;
    let crossDeadlineOnStatus = false;
    f.ctx.ui.setStatus = (name: string, text: string | undefined) => {
      originalSetStatus(name, text);
      if (crossDeadlineOnStatus) {
        crossDeadlineOnStatus = false;
        now = deadlineAt;
      }
    };
    const waiting = f.run("wait_for_goal_event", { id: "deadline-wait" });
    crossDeadlineOnStatus = true;
    owned.resolve();
    await assert.rejects(waiting, /scope changed while waiting/);
    assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.delivery.v1").length, 0);
  } finally {
    Date.now = realNow;
  }
});
test("pause, producer revocation, session switch and branch selection fence result delivery", async () => {
  for (const fence of ["pause", "revoke", "session", "branch"] as const) {
    const f = setup();
    await f.emit("session_start");
    await f.command("start fixture objective");
    const owned = offer(f, "pending");
    assert.equal(owned.accepted, true);
    const waiting = f.run("wait_for_goal_event", { id: "pending" });
    void waiting.catch(() => {});
    if (fence === "pause") await f.command("pause");
    if (fence === "revoke") owned.revoke();
    if (fence === "session") {
      f.switchSession();
      await f.emit("session_start");
    }
    if (fence === "branch") await f.emit("session_tree");
    owned.resolve();
    await assert.rejects(waiting, /paused|scope changed|Session changed|branch changed/);
    assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.delivery.v1").length, 0);
  }
});
test("cancellation disarms automatic continuation until explicit human resume", async () => {
  const f = setup();
  await f.emit("session_start");
  await f.command("start fixture objective");
  const owned = offer(f, "pending");
  const abort = new AbortController();
  const waiting = f.run("wait_for_goal_event", { id: "pending" }, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /Wait aborted/);
  assert.match(
    f.statuses.get("pi-goal") ?? "",
    /Goal: active · Auto: stopped \(wait interrupted: Wait aborted\)/,
  );
  assert.match(f.statuses.get("pi-goal") ?? "", /Next: \/goal resume/);
  assert.equal(
    f.branch.filter((entry) => entry.customType === "pi-goal.waiter-state.v1").at(-1).data
      .stopReason,
    "wait interrupted: Wait aborted",
  );
  owned.resolve();
  assert.deepEqual(await f.emit("agent_before_settle", { outcome: "completed" }), [undefined]);
  await f.command("resume");
  assert.doesNotMatch(f.statuses.get("pi-goal") ?? "", /wait interrupted|Auto: stopped/);
  await f.emit("agent_start");
  const continuation = await f.emit("agent_before_settle", {
    outcome: "completed",
  });
  assert.deepEqual(
    continuation,
    [undefined],
    "a resumed goal awaits actual worker evidence before evaluation",
  );
  const rearmed = offer(f, "rearmed");
  assert.equal(rearmed.accepted, true);
  rearmed.release();
});
test("throwing producer acceptance cannot leave a retained goal waiter", async () => {
  const f = setup();
  await f.emit("session_start");
  await f.command("start fixture objective");
  assert.throws(
    () =>
      f.api.events.emit("goal:waiter", {
        version: 1,
        id: "bad",
        owner: "subagent",
        sessionId: "fixture-session",
        producerGeneration: "generation",
        promise: new Promise(() => {}),
        isCurrent: () => true,
        respond() {
          throw Error("fixture rejection");
        },
      }),
    /fixture rejection/,
  );
  await assert.rejects(f.run("wait_for_goal_event", { id: "bad" }), /Unknown/);
});

test("background yield retains the same pending handle and responds with the number of released foreground waits", async () => {
  const f = setup();
  await f.emit("session_start");
  await f.command("start fixture objective");
  const owned = offer(f, "pending-background");
  assert.match(
    f.statuses.get("pi-goal") ?? "",
    /Goal: active · Auto: waiting .* · 1 wait handle pending/,
  );
  const waiting = f.run("wait_for_goal_event", { id: "pending-background" });
  assert.match(
    f.statuses.get("pi-goal") ?? "",
    /Goal: active · Auto: waiting \(owned result\) · 1 wait handle pending/,
  );
  let count = -1;
  f.api.events.emit("goal:yield-wait:v1", {
    respond(value: number) {
      count = value;
    },
  });
  const pending = await waiting;
  assert.equal(count, 1);
  assert.equal(pending.details.pending, true);
  assert.equal(pending.details.wait_id, "pending-background");
  assert.match(
    f.statuses.get("pi-goal") ?? "",
    /Goal: active · Auto: waiting .* · 1 wait handle pending/,
  );
  const summary = await f.run("get_goal", {});
  assert.match(summary.content[0].text, /1 owned wait handle pending/);
  owned.resolve();
  const result = await f.run("wait_for_goal_event", { id: "pending-background" });
  assert.equal(result.details.result.text, "answer");
  assert.match(f.statuses.get("pi-goal") ?? "", /Goal: active · Auto: waiting \(ready for input\)/);
  assert.doesNotMatch(f.statuses.get("pi-goal") ?? "", /wait handle pending/);
  assert.equal(f.branch.filter((entry) => entry.customType === "pi-goal.delivery.v1").length, 1);
});

test("producer release refreshes the footer after dropping an owned wait handle", async () => {
  const f = setup();
  await f.emit("session_start");
  await f.command("start fixture objective");
  const owned = offer(f, "released");
  assert.match(
    f.statuses.get("pi-goal") ?? "",
    /Goal: active · Auto: waiting .* · 1 wait handle pending/,
  );
  owned.release();
  assert.match(f.statuses.get("pi-goal") ?? "", /Goal: active · Auto: waiting \(ready for input\)/);
  assert.doesNotMatch(f.statuses.get("pi-goal") ?? "", /wait handle pending/);
});
