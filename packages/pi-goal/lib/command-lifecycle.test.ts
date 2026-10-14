import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";
import { reduceGoal, type GoalState, type OwnedWaiterOfferV1 } from "./goal.ts";
import { ENTRY, WAITER_STATE_ENTRY, readGoalBranch } from "./persistence.ts";

function fixture(seed: any[] = []) {
  const branch = [...seed],
    hooks = new Map<string, Function[]>(),
    events = new Map<string, Function[]>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  const notices: string[] = [];
  const statuses: string[] = [];
  const userMessages: string[] = [];
  const userMessageOptions: unknown[] = [];
  const emittedEvents: Array<{ name: string; value: unknown }> = [];
  let aborts = 0;
  let idle = true;
  const ctx: any = {
    sessionManager: { getSessionId: () => "fixture", getBranch: () => branch },
    hasUI: false,
    isIdle: () => idle,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_name: string, text?: string) => {
        if (text) statuses.push(text);
      },
    },
    abort() {
      aborts++;
    },
  };
  const api: any = {
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    events: {
      on: (name: string, fn: Function) => events.set(name, [...(events.get(name) ?? []), fn]),
      emit: (name: string, value: unknown) => {
        emittedEvents.push({ name, value });
        for (const fn of events.get(name) ?? []) fn(value);
      },
    },
    sendUserMessage(message: string, options: unknown) {
      userMessages.push(message);
      userMessageOptions.push(options);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => {
      assert.equal(options.triggerTurn, false, "clearing must not start another model turn");
      branch.push({ type: "custom_message", ...message });
    },
  };
  extension(api as ExtensionAPI);
  return {
    branch,
    ctx,
    api,
    notices,
    statuses,
    userMessages,
    userMessageOptions,
    emittedEvents,
    setIdle(value: boolean) {
      idle = value;
    },
    get aborts() {
      return aborts;
    },
    current: () => readGoalBranch(ctx),
    command: (args: string) => commands.get("goal").handler(args, ctx),
    run: (name: string, args: any) =>
      tools.get(name).execute("call", args, undefined, undefined, ctx),
    emit: async (name: string, value: any = {}) => {
      const results = [];
      for (const fn of hooks.get(name) ?? []) results.push(await fn(value, ctx));
      return results;
    },
  };
}
function seed(status: GoalState["status"]): GoalState {
  const state = reduceGoal(undefined, {
    type: "create",
    id: "goal-old",
    objective: "Old objective",
    budget: 100,
    criteria: [{ id: "task-old", requirement: "Old objective" }],
  })!;
  return {
    ...state,
    status,
    usage: { input: 5, output: 3, cacheRead: 7, cacheWrite: 1, missing: 0 },
  };
}
function pendingWait(f: ReturnType<typeof fixture>) {
  let accepted = false;
  const offer: OwnedWaiterOfferV1 = {
    version: 1,
    id: "wait-held",
    owner: "fixture",
    sessionId: "fixture",
    producerGeneration: "fixture-generation",
    promise: new Promise(() => {}),
    isCurrent: () => true,
    respond: (result) => {
      accepted = result.accepted;
    },
  };
  f.api.events.emit("goal:waiter", offer);
  assert.equal(accepted, true);
  const waiting = f.run("wait_for_goal_event", { id: offer.id });
  void waiting.catch(() => {});
  return waiting;
}

test("saved active goal explains a stopped evaluator after reopen and resume clears its cause", async () => {
  const saved = [
    { type: "custom", customType: ENTRY, data: { state: seed("active") } },
    {
      type: "custom",
      customType: WAITER_STATE_ENTRY,
      data: { version: 1, disarmed: true, stopReason: "evaluator error: model unavailable" },
    },
  ];
  const f = fixture(saved);
  await f.emit("session_start");
  assert.match(
    f.statuses.at(-1) ?? "",
    /Goal: active · Auto: stopped \(evaluator error: model unavailable\)/,
  );
  assert.match(f.statuses.at(-1) ?? "", /Next: fix evaluator; \/goal resume/);
  assert.doesNotMatch(f.statuses.at(-1) ?? "", /disarmed|Auto: running/);
  const reopened = fixture(f.branch);
  await reopened.emit("session_start");
  assert.equal(reopened.current().stopReason, "evaluator error: model unavailable");
  await reopened.command("resume");
  assert.equal(reopened.current().stopReason, undefined);
  assert.equal(reopened.current().disarmed, false);
  assert.match(reopened.statuses.at(-1) ?? "", /Goal: active · Auto: waiting \(ready for input\)/);
  await reopened.emit("agent_start");
  assert.match(reopened.statuses.at(-1) ?? "", /Goal: active · Auto: running/);
  await reopened.emit("agent_settled");
  assert.match(reopened.statuses.at(-1) ?? "", /Auto: waiting/);
});

test("shorthand and explicit edit immediately arm every unfinished status with the exact new objective", async () => {
  for (const status of ["active", "paused", "blocked"] as const)
    for (const explicit of [false, true]) {
      const f = fixture([
        { type: "custom", customType: ENTRY, data: { state: seed(status) } },
        { type: "custom", customType: WAITER_STATE_ENTRY, data: { version: 1, disarmed: true } },
      ]);
      await f.emit("session_start");
      const objective = " inspect  the whole new scope  ";
      await f.command(explicit ? `edit ${objective}` : objective);
      const current = f.current();
      assert.equal(current.goal?.objective, objective);
      assert.equal(current.goal?.criteria[0].requirement, objective);
      assert.equal(current.goal?.id, "goal-old");
      assert.equal(current.goal?.revision, 1);
      assert.equal(current.goal?.status, "active");
      assert.equal(current.goal?.budget, 100);
      assert.deepEqual(current.goal?.usage, seed(status).usage);
      assert.equal(
        current.disarmed,
        false,
        "the new human-authorized scope needs no second resume",
      );
      assert.equal(f.aborts, 0, "editing an idle scope does not abort unrelated work");
    }
});

test("empty/status queries do not write or abort, explicit empty objectives/control arguments fail unchanged", async () => {
  const f = fixture();
  await f.emit("session_start");
  for (const command of ["", " \t ", "status", "  status \t "]) await f.command(command);
  assert.equal(f.branch.length, 0);
  assert.equal(f.aborts, 0);
  assert.ok(f.notices.every((notice) => notice === "No goal is active."));
  for (const input of [
    "start",
    "start \t ",
    "edit",
    "edit \t ",
    "status extra",
    "pause extra",
    "resume extra",
    "clear extra",
  ])
    await assert.rejects(f.command(input), /empty|takes no arguments/);
  assert.equal(f.branch.length, 0);
  assert.equal(f.aborts, 0);
  await assert.rejects(f.command("edit New goal"), /No active goal/);
  await assert.rejects(f.command("pause"), /No active goal/);
  await assert.rejects(f.command("resume"), /No active goal/);
  await f.command("start status is part of this objective");
  assert.equal(f.current().goal?.objective, "status is part of this objective");
  await assert.rejects(f.command("start other scope"), /already exists/);
  await f.command("pause");
  assert.equal(f.current().goal?.status, "paused");
  await f.command("resume");
  assert.equal(f.current().goal?.status, "active");
  assert.equal(f.current().disarmed, false);
});

test("deadline expires while paused, stays persisted, and requires explicit human extension", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("start --for 1s finish the review");
  const initialDeadline = f.current().goal?.deadlineAt;
  assert.ok(initialDeadline && initialDeadline > Date.now());
  assert.match(f.statuses.at(-1) ?? "", /Deadline: .* · Remaining: \d+[smhd]/);
  await f.command("pause");
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(f.current().goal?.status, "expired");
  assert.equal(f.current().disarmed, true);
  assert.match(f.statuses.at(-1) ?? "", /deadline expired/);
  await assert.rejects(f.command("resume"), /new --for duration or --no-deadline/);
  await f.command("resume --no-deadline");
  assert.equal(f.current().goal?.status, "active");
  assert.equal(f.current().goal?.deadlineAt, undefined);
  assert.equal(f.current().disarmed, false);
});

test("completed goal status does not retain a changing countdown", async () => {
  const completed = { ...seed("completed"), deadlineAt: Date.now() + 60_000 };
  const f = fixture([{ type: "custom", customType: ENTRY, data: { state: completed } }]);
  await f.emit("session_start");
  const status = f.statuses.at(-1) ?? "";
  assert.match(status, /^Goal: completed · Auto: stopped \(goal completed\)/);
  assert.match(status, /Deadline:/);
  assert.doesNotMatch(status, /Remaining:/);
});

test("a session resumed after its deadline records expiry before any goal work can start", async () => {
  const expiredAt = Date.now() - 1;
  const f = fixture([
    {
      type: "custom",
      customType: ENTRY,
      data: { state: { ...seed("active"), deadlineAt: expiredAt } },
    },
    { type: "custom", customType: WAITER_STATE_ENTRY, data: { version: 1, disarmed: false } },
  ]);
  await f.emit("session_start");
  assert.equal(f.current().goal?.status, "expired");
  assert.equal(f.current().disarmed, true);
  assert.match(f.statuses.at(-1) ?? "", /deadline expired/);

  const reopened = fixture(f.branch);
  await reopened.emit("session_start");
  assert.equal(reopened.current().goal?.status, "expired");
  assert.equal(reopened.current().disarmed, true);
});

test("deadline expiry lets the current model turn finish but blocks its continuation", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("start --for 1s finish the current task");
  await f.emit("agent_start");
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(f.current().goal?.status, "expired");
  assert.equal(f.aborts, 0, "expiry does not cancel the in-flight model turn");
  const settled = await f.emit("agent_before_settle", { outcome: "completed" });
  assert.deepEqual(settled, [undefined], "an expired run cannot request another goal turn");
  await f.command("resume --for 1m");
  assert.equal(f.current().goal?.status, "active");
  assert.ok(f.current().goal?.deadlineAt && f.current().goal!.deadlineAt! > Date.now());
});

test("resume after deadline expiry does not interrupt a busy turn", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("start --for 1s finish the current task");
  const deadlineAt = f.current().goal?.deadlineAt;
  await f.emit("agent_start");
  const messagesBeforeResume = f.userMessages.length;
  f.setIdle(false);
  await new Promise((resolve) => setTimeout(resolve, 1_150));

  await f.command("resume --no-deadline");

  assert.equal(f.current().goal?.status, "expired");
  assert.equal(f.current().goal?.deadlineAt, deadlineAt);
  assert.equal(f.current().disarmed, true);
  assert.equal(f.aborts, 0, "resume cannot abort the turn already in progress");
  assert.equal(f.userMessages.length, messagesBeforeResume);
  assert.match(f.notices.at(-1) ?? "", /current turn may finish/);
  assert.match(f.notices.at(-1) ?? "", /deadline was not changed/);
});

test("expiry cancels an active goal wait without stopping its producer work", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("start --for 1s finish the delegated task");
  let finishProducer!: (value: { deliveryKey: string; value: unknown }) => void;
  let producerFinished = false;
  const producer = new Promise<{ deliveryKey: string; value: unknown }>((resolve) => {
    finishProducer = (value) => {
      producerFinished = true;
      resolve(value);
    };
  });
  const offer: OwnedWaiterOfferV1 = {
    version: 1,
    id: "wait-expiring",
    owner: "fixture",
    sessionId: "fixture",
    producerGeneration: "fixture-generation",
    promise: producer,
    isCurrent: () => true,
    respond: (result) => assert.equal(result.accepted, true),
  };
  f.api.events.emit("goal:waiter", offer);
  const waiting = f.run("wait_for_goal_event", { id: offer.id });
  const rejected = assert.rejects(waiting, /Goal deadline expired/);
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  await rejected;
  assert.equal(f.current().goal?.status, "expired");
  assert.doesNotMatch(f.statuses.at(-1) ?? "", /wait handle/, "the goal wait is removed");
  assert.equal(producerFinished, false, "expiry leaves the delegated work running");
  finishProducer({ deliveryKey: "late-result", value: "still running" });
  await producer;
  assert.equal(producerFinished, true);
});

test("human clear removes every goal status and persists absence across session reload", async () => {
  for (const status of ["active", "paused", "blocked", "completed"] as const) {
    const f = fixture([
      { type: "custom", customType: ENTRY, data: { state: seed(status) } },
      { type: "custom", customType: WAITER_STATE_ENTRY, data: { version: 1, disarmed: true } },
    ]);
    await f.emit("session_start");
    await f.command("clear");
    assert.equal(f.current().goal, undefined);
    assert.equal(f.current().disarmed, false);
    assert.equal(f.aborts, 0);
    assert.ok(f.branch.some((entry) => entry.customType === ENTRY && entry.data.state === null));
    assert.ok(f.branch.some((entry) => entry.customType === "pi-goal.cleared"));
    await f.emit("session_start");
    assert.equal(f.current().goal, undefined, "replay cannot restore an earlier objective");
    await f.command("clear");
    assert.equal(f.aborts, 0, "clearing an absent goal does not abort unrelated work");
    assert.equal(f.notices.at(-1), "No goal is active.");
    await f.command("A fresh objective");
    assert.equal(f.current().goal?.objective, "A fresh objective");
    assert.equal(f.current().goal?.revision, 0);
    assert.deepEqual(f.current().goal?.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      missing: 0,
    });
  }
});

test("human clear recovers malformed persisted goal and waiter state", async () => {
  const f = fixture([
    { type: "custom", customType: ENTRY, data: { state: { ...seed("active"), version: 999 } } },
    {
      type: "custom",
      customType: WAITER_STATE_ENTRY,
      data: { version: 1, disarmed: "false" },
    },
  ]);

  await assert.rejects(f.command("status"), /malformed or unsupported goal state/);
  await f.command("clear");

  assert.deepEqual(f.current(), { goal: undefined, disarmed: false });
  assert.ok(f.branch.some((entry) => entry.customType === ENTRY && entry.data.state === null));
  assert.ok(
    f.branch.some(
      (entry) =>
        entry.customType === WAITER_STATE_ENTRY &&
        entry.data.version === 1 &&
        entry.data.disarmed === false,
    ),
    "clear appends a canonical armed waiter record even when the cached flag was already false",
  );
  await f.command("A new user-authorized objective");
  assert.equal(f.current().goal?.objective, "A new user-authorized objective");
});

test("clear revokes delegation waits and stale run authority before a new goal", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("Old goal");
  await f.emit("agent_start");
  const waiting = pendingWait(f);
  await f.command("clear");
  await assert.rejects(waiting, /Goal cleared/);
  await assert.rejects(
    f.run("wait_for_goal_event", { id: "wait-held" }),
    /No active goal|inactive|unknown|active/i,
  );
  await f.command("New goal");
  assert.deepEqual(await f.emit("agent_before_settle", { outcome: "completed" }), [undefined]);
  assert.equal(f.current().goal?.objective, "New goal");
  assert.equal(f.current().disarmed, false);
});

test("clear revokes an unused trusted creation authorization", async () => {
  const f = fixture();
  await f.emit("session_start");
  f.api.events.emit("goal:create_authorization", { objective: "Old authorization", budget: 10 });
  await f.command("clear");
  await assert.rejects(
    f.run("create_goal", { objective: "Old authorization", budget: 10 }),
    /confirmation/,
  );
  assert.equal(f.current().goal, undefined);
});

test("human objective shorthand does not grant a model tool authorization or interpret permission/budget flags", async () => {
  const f = fixture();
  await f.emit("session_start");
  f.api.events.emit("goal:create_authorization", {
    objective: "different preauthorized objective",
    budget: 10,
  });
  await f.command("--budget 10 --allow-all is literal objective text");
  assert.equal(f.current().goal?.objective, "--budget 10 --allow-all is literal objective text");
  assert.equal(f.current().goal?.budget, undefined);
  await assert.rejects(
    f.run("create_goal", { objective: "different preauthorized objective", budget: 10 }),
    /confirmation/,
  );
  assert.equal(f.current().goal?.objective, "--budget 10 --allow-all is literal objective text");
});

test("late old waits and run settlements cannot disarm or continue a freshly edited human scope", async () => {
  for (const outcome of ["aborted", "error", "completed"]) {
    const f = fixture();
    await f.emit("session_start");
    await f.command("Old objective");
    await f.emit("agent_start");
    const waiting = pendingWait(f);
    await f.command("New exact objective");
    await assert.rejects(waiting, /scope edited/);
    assert.equal(f.current().disarmed, false);
    assert.deepEqual(await f.emit("agent_before_settle", { outcome }), [undefined]);
    assert.equal(f.current().disarmed, false, "a revoked run has no authority over the new scope");
    await f.emit("agent_start");
    const continuation = await f.emit("agent_before_settle", { outcome: "completed" });
    assert.deepEqual(
      continuation,
      [undefined],
      "no completed worker evidence means no evaluator or continuation",
    );
    assert.equal(f.current().goal?.status, "active");
    assert.equal(f.current().disarmed, false);
    assert.ok(f.branch.every((entry) => [ENTRY, WAITER_STATE_ENTRY].includes(entry.customType)));
  }
});

test("human resume fences a failed old run while current-scope cancellation still disarms", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("Authorized objective");
  await f.emit("agent_start");
  const waiting = pendingWait(f);
  await f.command("pause");
  await assert.rejects(waiting, /paused/);
  assert.equal(f.current().disarmed, true);
  await f.command("resume");
  assert.equal(f.current().disarmed, false);
  await f.emit("agent_before_settle", { outcome: "aborted" });
  assert.equal(f.current().disarmed, false);
  await f.emit("agent_start");
  await f.emit("agent_before_settle", { outcome: "aborted" });
  assert.equal(
    f.current().disarmed,
    true,
    "failure in the currently authorized run still stops continuation",
  );
});

test("resume restarts a restored active goal as a normal user message", async () => {
  const restored = seed("active");
  const f = fixture([{ type: "custom", customType: ENTRY, data: { state: restored } }]);
  await f.emit("session_start");

  await f.command("resume");

  const resumed = f.current().goal;
  assert.equal(resumed?.status, "active");
  assert.equal(resumed?.revision, restored.revision + 1);
  assert.equal(f.current().disarmed, false);
  assert.deepEqual(f.userMessages, [`Resume the authorized goal: ${restored.objective}`]);
  assert.deepEqual(f.userMessageOptions, [{ deliverAs: "followUp", expandPromptTemplates: false }]);
  assert.deepEqual(f.emittedEvents, [
    {
      name: "pi:human-input:v1",
      value: { version: 1, sessionId: "fixture", message: restored.objective },
    },
  ]);
});

test("resume does not fence or duplicate an already-running active goal", async () => {
  const restored = seed("active");
  const f = fixture([{ type: "custom", customType: ENTRY, data: { state: restored } }]);
  await f.emit("session_start");
  await f.emit("agent_start");
  f.setIdle(false);

  await f.command("resume");

  assert.equal(f.current().goal?.revision, restored.revision);
  assert.equal(f.current().disarmed, false);
  assert.equal(f.aborts, 0);
  assert.deepEqual(f.userMessages, []);
  assert.match(f.notices.at(-1) ?? "", /already active/);
});

test("resume does not interrupt a busy turn when the active goal is disarmed", async () => {
  const restored = seed("active");
  const f = fixture([
    { type: "custom", customType: ENTRY, data: { state: restored } },
    { type: "custom", customType: WAITER_STATE_ENTRY, data: { version: 1, disarmed: true } },
  ]);
  await f.emit("session_start");
  await f.emit("agent_start");
  f.setIdle(false);

  await f.command("resume");

  assert.equal(f.current().goal?.revision, restored.revision);
  assert.equal(f.current().disarmed, true);
  assert.equal(f.aborts, 0);
  assert.deepEqual(f.userMessages, []);
  assert.match(f.notices.at(-1) ?? "", /after this turn finishes/);
});

test("busy resume explicitly reports deadline options that were not applied", async () => {
  for (const disarmed of [false, true])
    for (const option of ["--for 30m", "--no-deadline"]) {
      const deadlineAt = Date.now() + 60 * 60_000;
      const restored = { ...seed("active"), deadlineAt };
      const f = fixture([
        { type: "custom", customType: ENTRY, data: { state: restored } },
        ...(disarmed
          ? [
              {
                type: "custom",
                customType: WAITER_STATE_ENTRY,
                data: { version: 1, disarmed: true },
              },
            ]
          : []),
      ]);
      await f.emit("session_start");
      await f.emit("agent_start");
      f.setIdle(false);

      await f.command(`resume ${option}`);

      assert.equal(f.current().goal?.revision, restored.revision);
      assert.equal(f.current().goal?.deadlineAt, deadlineAt);
      assert.equal(f.current().disarmed, disarmed);
      assert.equal(f.aborts, 0);
      assert.deepEqual(f.userMessages, []);
      assert.match(f.notices.at(-1) ?? "", /deadline was not changed/);
      assert.match(f.notices.at(-1) ?? "", /after this turn finishes/);
    }
});
