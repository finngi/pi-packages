import { withFixtureEvaluator } from "./evaluator-fixture.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";
import { parseGoalCommand } from "./command.ts";
import { reduceGoal, type GoalState } from "./goal.ts";
import { CONTINUE_ENTRY, ENTRY, WAITER_STATE_ENTRY, readGoalBranch } from "./persistence.ts";

function goal(status: GoalState["status"] = "active"): GoalState {
  let state = reduceGoal(undefined, {
    type: "create",
    id: "goal-semantic-blue-fox-one",
    objective: "Original objective",
    budget: 200,
    criteria: [{ id: "task-blue-fox-one", requirement: "Inspect the relevant output" }],
  })!;
  state = reduceGoal(state, {
    type: "usage",
    id: "provider-response-one",
    goalId: state.id,
    usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 },
  })!;
  if (status === "paused") state = reduceGoal(state, { type: "pause" })!;
  if (status === "blocked")
    for (const cycleId of [
      "request-blue-fox-one",
      "request-blue-fox-two",
      "request-blue-fox-three",
    ])
      state = reduceGoal(state, {
        type: "blocker",
        key: "provider-unavailable",
        blocker: "Provider unavailable",
        cycleId,
      })!;
  if (status === "completed")
    state = reduceGoal(state, {
      type: "audit",
      requirements: [
        {
          criterionId: "task-blue-fox-one",
          evidence: "Inspected the relevant output",
          verdict: "met",
        },
      ],
    })!;
  return state;
}

function branchContext(branch: any[]): ExtensionContext {
  return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

test("CLI parser preserves shorthand and explicit objective spacing while reserving exact control words", () => {
  assert.deepEqual(parseGoalCommand("   \t "), { kind: "status" });
  assert.deepEqual(parseGoalCommand("  inspect  each  output  "), {
    kind: "start",
    objective: "  inspect  each  output  ",
  });
  assert.deepEqual(parseGoalCommand("start  inspect  each  output  "), {
    kind: "start",
    objective: " inspect  each  output  ",
  });
  assert.deepEqual(parseGoalCommand("start start", undefined), {
    kind: "start",
    objective: "start",
  });
  assert.deepEqual(parseGoalCommand("edit\t  revised  scope  ", goal("paused")), {
    kind: "edit",
    objective: "  revised  scope  ",
  });
  assert.deepEqual(parseGoalCommand("starting means the exact objective", goal()), {
    kind: "edit",
    objective: "starting means the exact objective",
  });
  assert.deepEqual(parseGoalCommand("  new objective  ", goal("completed")), {
    kind: "start",
    objective: "  new objective  ",
  });
  for (const status of ["active", "paused", "blocked"] as const)
    assert.equal(parseGoalCommand("new scope", goal(status)).kind, "edit");
  for (const kind of ["status", "pause", "resume", "clear"] as const)
    assert.deepEqual(parseGoalCommand(kind, goal()), { kind });
  for (const input of ["start", "start \t ", "edit", "edit   "])
    assert.throws(() => parseGoalCommand(input, goal()), /Objective must not be empty/);
  for (const input of ["status extra", "pause extra", "resume extra", "clear extra"])
    assert.throws(() => parseGoalCommand(input, goal()), /takes no arguments/);
  assert.throws(
    () => parseGoalCommand("status is part of my objective", undefined),
    /takes no arguments/,
  );
  assert.deepEqual(parseGoalCommand("clear"), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("start clear the cache"), {
    kind: "start",
    objective: "clear the cache",
  });
});

test("CLI shorthand edits unfinished goals, preserves accounting and immediately arms the new scope", async () => {
  const branch: any[] = [{ type: "custom", customType: ENTRY, data: { state: goal("blocked") } }];
  const hooks = new Map<string, Function[]>();
  const events = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const ctx: any = {
    sessionManager: { getSessionId: () => "fixture-session", getBranch: () => branch },
    hasUI: false,
    signal: new AbortController().signal,
    abort() {},
    ui: { notify() {}, setStatus() {} },
  };
  const api: any = {
    on(name: string, handler: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Function) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
      emit(name: string, value: unknown) {
        for (const handler of events.get(name) ?? []) handler(value);
      },
    },
    sendUserMessage() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
  };
  extension(api as ExtensionAPI);
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx);

  await commands.get("goal").handler("new  full scope  ", ctx);
  let current = readGoalBranch(branchContext(branch));
  assert.equal(current.goal?.objective, "new  full scope  ");
  assert.equal(current.goal?.status, "active");
  assert.equal(current.goal?.revision, 1);
  assert.equal(current.goal?.budget, 200);
  assert.deepEqual(current.goal?.usage, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    missing: 0,
  });
  assert.equal(current.disarmed, false, "the newly human-authorized scope is immediately usable");

  await commands.get("goal").handler("pause", ctx);
  current = readGoalBranch(branchContext(branch));
  assert.equal(current.goal?.status, "paused");
  assert.equal(current.disarmed, true, "pause still disarms automatic continuation");
  await commands.get("goal").handler("resume", ctx);
  current = readGoalBranch(branchContext(branch));
  assert.equal(current.goal?.status, "active");
  assert.equal(current.goal?.revision, 2);
  assert.equal(current.disarmed, false, "explicit human resume rearms a paused scope");
  assert.equal(current.goal?.budget, 200);
  assert.equal(current.goal?.usage.input, 7);

  const beforeInvalidCommand = branch.length;
  await commands.get("goal").handler(" \t ", ctx);
  await assert.rejects(commands.get("goal").handler("pause extra", ctx), /takes no arguments/);
  await assert.rejects(
    commands.get("goal").handler("start   ", ctx),
    /Objective must not be empty/,
  );
  await assert.rejects(
    commands.get("goal").handler("edit \t ", ctx),
    /Objective must not be empty/,
  );
  assert.equal(
    branch.length,
    beforeInvalidCommand,
    "invalid/empty explicit input appends no goal or waiter state",
  );
});

test("human shorthand starts without a goal and replaces a completed goal with fresh identity and accounting", async () => {
  const branch: any[] = [];
  const hooks = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const ctx: any = {
    sessionManager: { getSessionId: () => "fixture-session", getBranch: () => branch },
    hasUI: false,
    signal: new AbortController().signal,
    abort() {},
    ui: { notify() {}, setStatus() {} },
  };
  const api: any = {
    on(name: string, handler: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    events: { on() {}, emit() {} },
    sendUserMessage() {},
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
  };
  extension(api as ExtensionAPI);
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx);
  await commands.get("goal").handler("  inspect  initial scope  ", ctx);
  const created = readGoalBranch(branchContext(branch)).goal!;
  assert.equal(created.status, "active");
  assert.equal(created.objective, "  inspect  initial scope  ");
  assert.equal(created.criteria[0].requirement, "  inspect  initial scope  ");
  assert.equal(created.budget, undefined);

  const completed = reduceGoal(created, {
    type: "audit",
    requirements: created.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: "Inspected the authorized output",
      verdict: "met" as const,
    })),
  })!;
  branch.push({ type: "custom", customType: ENTRY, data: { state: completed } });
  await commands.get("goal").handler("replacement scope", ctx);
  const replacement = readGoalBranch(branchContext(branch)).goal!;
  assert.equal(replacement.status, "active");
  assert.equal(replacement.objective, "replacement scope");
  assert.notEqual(replacement.id, created.id);
  assert.equal(replacement.revision, 0);
  assert.deepEqual(replacement.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    missing: 0,
  });
  assert.ok(branch.some((entry) => entry.customType === ENTRY));
  assert.equal(ENTRY, "pi-goal.state");
  assert.equal(WAITER_STATE_ENTRY, "pi-goal.waiter-state.v1");
  assert.equal(CONTINUE_ENTRY, "pi-goal.continue");
});

test("late waiter failure and prior-run settlement cannot disarm or continue an edited scope", async () => {
  const branch: any[] = [{ type: "custom", customType: ENTRY, data: { state: goal() } }];
  const hooks = new Map<string, Function[]>();
  const events = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const ctx: any = {
    sessionManager: { getSessionId: () => "fixture-session", getBranch: () => branch },
    hasUI: false,
    signal: new AbortController().signal,
    abort() {},
    ui: { notify() {}, setStatus() {} },
  };
  const api: any = {
    on(name: string, handler: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Function) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
      emit(name: string, value: unknown) {
        for (const handler of events.get(name) ?? []) handler(value);
      },
    },
    sendUserMessage() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
  };
  extension(api as ExtensionAPI);
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx);

  let accepted: any;
  api.events.emit("goal:waiter", {
    version: 1,
    id: "wait-from-old-scope",
    owner: "independent-fixture",
    sessionId: "fixture-session",
    producerGeneration: "generation-one",
    promise: new Promise(() => {}),
    isCurrent: () => true,
    respond(value: unknown) {
      accepted = value;
    },
  });
  assert.equal(accepted?.accepted, true);
  for (const handler of hooks.get("agent_start") ?? []) await handler({}, ctx);
  const waiting = tools
    .get("wait_for_goal_event")
    .execute("wait-call", { id: "wait-from-old-scope" }, ctx.signal, undefined, ctx);
  await commands.get("goal").handler("human-edited scope", ctx);
  await assert.rejects(waiting, /Goal scope edited|Wait aborted/);
  const updated = readGoalBranch(branchContext(branch));
  assert.equal(updated.goal?.objective, "human-edited scope");
  assert.equal(updated.goal?.status, "active");
  assert.equal(updated.goal?.revision, 1);
  assert.equal(
    updated.disarmed,
    false,
    "the old wait's late rejection cannot disarm the new scope",
  );

  const beforeSettlement = branch.length;
  const settleResults: unknown[] = [];
  for (const handler of hooks.get("agent_before_settle") ?? [])
    settleResults.push(await handler({ outcome: "completed" }, ctx));
  assert.deepEqual(
    settleResults,
    [undefined],
    "the previous run generation cannot request a continuation",
  );
  assert.equal(
    branch.length,
    beforeSettlement,
    "stale settlement does not write a turn or disarm record",
  );
  assert.equal(readGoalBranch(branchContext(branch)).disarmed, false);
});

test("pinned Pi CLI start alone dispatches its objective as a native user message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-cli-no-prompt-"));
  const model: Model<Api> = {
    id: "cli-scripted",
    name: "CLI scripted fixture",
    provider: "cli-scripted-fixture",
    api: "cli-scripted-fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
  };
  let providerCalls = 0;
  let handler: ((args: string, ctx: any) => Promise<unknown>) | undefined;
  let commandContext: any;
  let session: any;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture-only",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple(requested, context) {
        providerCalls++;
        const stream = createAssistantMessageEventStream();
        const tail = context.messages.at(-1) as any;
        const tailText = Array.isArray(tail?.content)
          ? tail.content.map((part: any) => (part.type === "text" ? part.text : "")).join("\n")
          : "";
        const criteria = [...tailText.matchAll(/<criterion id="([^"]+)"/g)].map(
          (match) => match[1],
        );
        const goalId = /<goal-state id="([^"]+)"/.exec(tailText)?.[1];
        const branchToken = /branch="([^"]+)"/.exec(tailText)?.[1];
        assert.ok(
          goalId && branchToken && criteria.length > 0,
          "ordinary prompt carries the new active scope",
        );
        const message: any = {
          role: "assistant",
          content: [{ type: "text", text: "Inspected the scripted request scope" }],
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });
    const captureCommand = (pi: any) => {
      const registerCommand = pi.registerCommand.bind(pi);
      pi.registerCommand = (name: string, command: any) => {
        if (name === "goal") handler = command.handler;
        return registerCommand(name, command);
      };
      extension(pi);
      pi.on("session_start", async (_event: unknown, ctx: any) => {
        commandContext = ctx;
      });
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [withFixtureEvaluator(captureCommand)],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    }));
    await session.bindExtensions({
      mode: "print",
      onError: (error: unknown) => {
        throw error;
      },
    });
    assert.ok(handler && commandContext);
    session.setActiveToolsByName(["get_goal"]);
    await handler("start initial objective", commandContext);
    for (
      let attempt = 0;
      attempt < 100 &&
      readGoalBranch(branchContext(session.sessionManager.getBranch())).goal?.status !==
        "completed";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      providerCalls,
      1,
      "start dispatches exactly one native user request without a follow-up prompt",
    );
    const userMessages = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.type === "message" && entry.message.role === "user");
    assert.ok(
      userMessages.some((entry: any) =>
        JSON.stringify(entry.message.content).includes("initial objective"),
      ),
    );
    assert.equal(
      readGoalBranch(branchContext(session.sessionManager.getBranch())).goal?.status,
      "completed",
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("current canonical goal and waiter records replay while unrelated extension records are ignored", () => {
  const canonical = goal("completed");
  const branch = [
    { type: "custom", customType: "other-extension.state", data: { arbitrary: true } },
    { type: "custom", customType: ENTRY, data: { state: canonical } },
    { type: "custom", customType: "other-extension.waiter", data: { disarmed: true } },
    { type: "custom", customType: WAITER_STATE_ENTRY, data: { version: 1, disarmed: false } },
  ];
  const loaded = readGoalBranch(branchContext(branch));
  assert.equal(loaded.goal?.id, canonical.id);
  assert.equal(loaded.goal?.version, 3);
  assert.equal(loaded.goal?.status, "completed");
  assert.equal(loaded.disarmed, false);
  assert.equal(ENTRY, "pi-goal.state");
  assert.equal(WAITER_STATE_ENTRY, "pi-goal.waiter-state.v1");
  assert.equal(CONTINUE_ENTRY, "pi-goal.continue");
});
