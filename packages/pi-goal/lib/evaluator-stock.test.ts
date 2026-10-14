import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";
import { EVALUATION_TOOL, type GoalEvaluation } from "./evaluator.ts";
import { readGoalBranch } from "./persistence.ts";

const base: Model<Api> = {
  id: "worker",
  provider: "goal-stock-worker",
  api: "goal-stock-worker",
  name: "Worker fixture",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};
function output(
  model: Model<Api>,
  content: AssistantMessage["content"],
  reason: AssistantMessage["stopReason"] = "stop",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7 },
    stopReason: reason,
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: reason === "toolUse" ? "toolUse" : "stop", message });
  return stream;
}
async function fixture(
  options: {
    decisions?: Array<{ verdict: GoalEvaluation["verdict"]; key?: string }>;
    malformed?: boolean;
    malformedAt?: number | number[];
    budget?: number;
    hang?: boolean;
    timeout?: string;
    unavailable?: boolean;
    defer?: boolean;
    foregroundWait?: boolean;
    persistent?: boolean;
    beforeGoalFactory?: (pi: any) => void;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-evaluator-stock-"));
  const evaluationContexts: Context[] = [];
  const workerContexts: Context[] = [];
  const notifications: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const evaluator: Model<Api> = {
    ...base,
    id: "evaluator",
    provider: "goal-stock-evaluator",
    api: "goal-stock-evaluator",
  };
  let evaluatorStarted!: () => void;
  let releaseEvaluation: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    evaluatorStarted = resolve;
  });
  runtime.registerProvider(base.provider, {
    api: base.api,
    apiKey: "fixture-only",
    baseUrl: base.baseUrl,
    models: [base],
    streamSimple(model, context) {
      workerContexts.push(structuredClone(context));
      if (fixtureOptions.foregroundWait && [1, 3].includes(workerContexts.length))
        return output(
          model,
          [
            {
              type: "toolCall",
              id: `wait-${workerContexts.length}`,
              name: "wait_for_goal_event",
              arguments: { id: "wait-steer" },
            },
          ],
          "toolUse",
        );
      return output(model, [
        {
          type: "text",
          text: `Worker stop ${workerContexts.length}: inspected files and ran checks.`,
        },
      ]);
    },
  });
  runtime.registerProvider(evaluator.provider, {
    api: evaluator.api,
    apiKey: "fixture-only",
    baseUrl: evaluator.baseUrl,
    models: [evaluator],
    streamSimple(model, context, options) {
      assert.equal(
        options?.apiKey,
        "fixture-only",
        "evaluator resolves authentication through stock provider composition",
      );
      evaluationContexts.push(structuredClone(context));
      evaluatorStarted();
      if (options?.signal?.aborted) throw options.signal.reason;
      if (options?.timeoutMs === undefined) throw Error("Evaluator timeout missing");
      if (options?.maxTokens !== 2048) throw Error("Evaluator response bound missing");
      if (options?.signal && options.signal instanceof AbortSignal === false)
        throw Error("No evaluator abort signal");
      if (options?.temperature !== 0) throw Error("Expected deterministic sampling preference");
      if (fixtureOptions.hang) return createAssistantMessageEventStream();
      if (
        fixtureOptions.malformed ||
        (Array.isArray(fixtureOptions.malformedAt)
          ? fixtureOptions.malformedAt.includes(evaluationContexts.length)
          : fixtureOptions.malformedAt === evaluationContexts.length)
      )
        return output(model, [{ type: "text", text: "Finished!" }]);
      const initial = context.messages.find((message) => message.role === "user");
      const goal = JSON.parse(String(initial?.content)).goal;
      const decision = fixtureOptions.decisions?.[evaluationContexts.length - 1] ?? {
        verdict: "finished",
      };
      const assessment = {
        verdict: decision.verdict,
        reason:
          decision.verdict === "finished"
            ? "Verified all fixed criteria"
            : decision.verdict === "blocked"
              ? "Required service unavailable"
              : "Run the remaining acceptance checks",
        blockerKey: decision.verdict === "blocked" ? (decision.key ?? "missing-service") : null,
        requirements: goal.criteria.map((criterion: any) => ({
          criterionId: criterion.id,
          evidence: "Observed scripted execution output",
          verdict: decision.verdict === "finished" ? "met" : "unmet",
        })),
      };
      const content: AssistantMessage["content"] = [
        {
          type: "toolCall",
          id: `eval-${evaluationContexts.length}`,
          name: EVALUATION_TOOL,
          arguments: assessment,
        },
      ];
      if (fixtureOptions.defer) {
        const stream = createAssistantMessageEventStream();
        releaseEvaluation = () => {
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7 },
            stopReason: "toolUse",
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
        };
        return stream;
      }
      return output(model, content, "toolUse");
    },
  });
  const fixtureOptions = options;
  let api: any, ctx: any, command: any;
  const tools = new Map<string, any>();
  const hooks = new Map<string, Function[]>();
  const factory = (pi: any) => {
    api = pi;
    const on = pi.on.bind(pi);
    pi.on = (name: string, handler: Function) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return on(name, handler);
    };
    const getFlag = pi.getFlag.bind(pi),
      registerTool = pi.registerTool.bind(pi),
      registerCommand = pi.registerCommand.bind(pi);
    pi.getFlag = (name: string) =>
      name === "goal-evaluator-model"
        ? options.unavailable
          ? "missing/model"
          : `${evaluator.provider}/${evaluator.id}`
        : name === "goal-evaluator-timeout" && options.timeout
          ? options.timeout
          : getFlag(name);
    pi.registerTool = (tool: any) => {
      tools.set(tool.name, tool);
      registerTool(tool);
    };
    pi.registerCommand = (name: string, value: any) => {
      if (name === "goal") command = value.handler;
      registerCommand(name, value);
    };
    options.beforeGoalFactory?.(pi);
    extension(pi);
    pi.on("session_start", (_event: unknown, value: any) => {
      ctx = value;
      const notify = ctx.ui.notify.bind(ctx.ui);
      ctx.ui.notify = (message: string, ...args: any[]) => {
        notifications.push(message);
        return notify(message, ...args);
      };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model: base,
    resourceLoader: loader,
    sessionManager: options.persistent
      ? SessionManager.create(cwd, join(cwd, "sessions"))
      : SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: { mode: "off" },
    } as any),
  });
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      throw error;
    },
  });
  {
    const input = {
      objective: "Implement parser and verify all cases",
      criteria: ["Implement parser", "Verify all cases"],
      ...(options.budget ? { budget: options.budget } : {}),
    };
    api.events.emit("goal:create_authorization", input);
    await tools.get("create_goal").execute("authorized-create", input, undefined, undefined, ctx);
  }
  session.setActiveToolsByName(["get_goal", "wait_for_goal_event"]);
  return {
    session,
    runtime,
    api,
    ctx,
    tools,
    started,
    releaseEvaluation: () => releaseEvaluation?.(),
    hook: async (name: string) => {
      for (const handler of hooks.get(name) ?? []) await handler({}, ctx);
    },
    workerContexts,
    evaluationContexts,
    notifications,
    current: () => readGoalBranch({ sessionManager: session.sessionManager } as any),
    command: (args: string) => command(args, ctx),
    cleanup: async () => {
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("stock settlement uses independent evaluator, stable accumulated prefix and separate usage", async () => {
  const f = await fixture({ decisions: [{ verdict: "incomplete" }, { verdict: "finished" }] });
  try {
    assert.equal(f.tools.has("update_goal"), false);
    await f.session.prompt("Build the requested parser; inspect real evidence.");
    assert.equal(f.current().goal?.status, "completed");
    assert.equal(f.workerContexts.length, 2);
    assert.equal(f.evaluationContexts.length, 2);
    const first = f.evaluationContexts[0],
      second = f.evaluationContexts[1];
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.deepEqual(
      (f.workerContexts[0].messages[0] as any).sections,
      (f.workerContexts[1].messages[0] as any).sections,
    );
    assert.equal(
      f.current().goal?.usage.input,
      8,
      "evaluator input never enters the explicit parent-worker budget",
    );
    const receipts = f.session.sessionManager
      .getBranch()
      .filter(
        (entry: any) => entry.type === "custom" && entry.customType === "pi-runtime.usage.v1",
      );
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((entry: any) => entry.data.kind === "evaluator"));
    assert.ok(
      f.evaluationContexts.every(
        (context) =>
          context.messages[0].role === "system" &&
          (context.messages[0] as any).toolsAdded.length === 1,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("standalone goal and evaluator receipts survive a real stock Pi session-file reopen", async () => {
  const f = await fixture({ persistent: true, malformed: true });
  let resumed: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await f.session.prompt("Inspect the requested parser and retain the evaluator failure.");
    const saved = JSON.parse(JSON.stringify(f.current()));
    const sessionFile = f.session.sessionManager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(saved.goal?.status, "active");
    assert.equal(saved.disarmed, true);
    const receipts = JSON.parse(
      JSON.stringify(
        f.session.sessionManager
          .getEntries()
          .filter(
            (entry: any) => entry.type === "custom" && entry.customType === "pi-runtime.usage.v1",
          ),
      ),
    );
    assert.equal(receipts.length, 2);
    await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
    f.session.dispose();
    const cwd = f.session.sessionManager.getCwd();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [extension],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session: resumed } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: f.runtime,
      model: base,
      resourceLoader,
      sessionManager: SessionManager.open(sessionFile),
      settingsManager: SettingsManager.inMemory({ cacheWarming: { mode: "off" } } as any),
    }));
    await resumed.bindExtensions({ mode: "print" });
    const restored = () => readGoalBranch({ sessionManager: resumed!.sessionManager } as any);
    assert.deepEqual(restored(), saved);
    const read = resumed.extensionRunner.getToolDefinition("get_goal")!;
    const result = await read.execute(
      "read-restored",
      {},
      undefined,
      undefined,
      resumed.extensionRunner.createToolContext("read-restored", undefined),
    );
    assert.match(result.content[0].text, /Goal|goal/);
    await resumed.prompt("Explain the saved state without resuming automatic work.");
    assert.equal(restored().goal?.status, "active");
    assert.equal(restored().disarmed, true);
    assert.equal(f.evaluationContexts.length, 2, "reopening never silently retries an evaluator");
    assert.deepEqual(
      resumed.sessionManager
        .getEntries()
        .filter(
          (entry: any) => entry.type === "custom" && entry.customType === "pi-runtime.usage.v1",
        ),
      receipts,
      "receipt IDs and accounting records are retained exactly once",
    );
  } finally {
    if (resumed) {
      await resumed.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
      resumed.dispose();
    }
    await f.cleanup();
  }
});

test("stock evaluator stops on the third consecutive same-condition verdict", async () => {
  const f = await fixture({
    decisions: [
      { verdict: "blocked", key: "missing-service" },
      { verdict: "blocked", key: "missing-service" },
      { verdict: "blocked", key: "missing-service" },
    ],
  });
  try {
    await f.session.prompt("Investigate the unavailable service.");
    assert.equal(f.current().goal?.status, "blocked");
    assert.equal(f.current().goal?.blockerTurns, 3);
    assert.equal(f.workerContexts.length, 3);
    assert.equal(f.evaluationContexts.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("owned pending results defer both evaluation and automatic continuation", async () => {
  const f = await fixture();
  try {
    let resolve!: (value: any) => void, accepted: any;
    f.api.events.emit("goal:waiter", {
      version: 1,
      id: "wait-result",
      owner: "fixture",
      sessionId: f.ctx.sessionManager.getSessionId(),
      producerGeneration: "generation",
      promise: new Promise((done) => {
        resolve = done;
      }),
      isCurrent: () => true,
      respond(value: any) {
        accepted = value;
      },
    });
    assert.equal(accepted.accepted, true);
    await f.session.prompt("Do independent work while the child runs.");
    assert.equal(f.evaluationContexts.length, 0);
    assert.equal(f.workerContexts.length, 1);
    resolve({ deliveryKey: "result-one", value: "Verified result" });
    await f.tools
      .get("wait_for_goal_event")
      .execute("wait-call", { id: "wait-result" }, undefined, undefined, f.ctx);
    await f.session.prompt("Integrate and verify the returned result.");
    assert.equal(f.current().goal?.status, "completed");
    assert.equal(f.evaluationContexts.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("malformed and unavailable evaluators visibly disarm without changing completion state", async () => {
  for (const options of [{ malformed: true }, { unavailable: true }]) {
    const f = await fixture(options);
    try {
      await f.session.prompt("Work then stop.");
      assert.equal(f.current().goal?.status, "active");
      assert.equal(f.current().disarmed, true);
      assert.match(f.current().stopReason ?? "", /^evaluator error:/);
      assert.ok(
        f.notifications.some((message) => /evaluation stopped automatic work/.test(message)),
      );
      assert.equal(f.workerContexts.length, 1);
      const malformed = f.session.sessionManager
        .getBranch()
        .find(
          (entry: any) =>
            entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "failure",
        );
      if (options.malformed) {
        assert.match(JSON.stringify((malformed as any)?.data.response), /Finished!/);
        assert.equal(
          f.session.sessionManager
            .getBranch()
            .filter(
              (entry: any) =>
                entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "failure",
            ).length,
          2,
        );
        assert.equal(f.current().goal?.blockerTurns, 0);
      }
      await f.session.prompt("Explain the current result to me.");
      assert.equal(
        f.workerContexts.length,
        2,
        "manual messages reach the worker while automation is suspended",
      );
      assert.equal(
        f.evaluationContexts.length,
        options.malformed ? 2 : 0,
        "manual messages do not retry the suspended evaluator",
      );
      assert.doesNotMatch(JSON.stringify(f.workerContexts.at(-1)), /Finished!/);
    } finally {
      await f.cleanup();
    }
  }
});

test("timeout produces a missing auxiliary receipt and stops even when provider ignores cancellation", async () => {
  const f = await fixture({ hang: true, timeout: "0.02" });
  try {
    await f.session.prompt("Perform work then stop.");
    assert.equal(f.current().disarmed, true);
    const records = f.session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-runtime.usage.v1");
    assert.equal(records.length, 1);
    assert.equal(records[0].data.kind, "evaluator");
    assert.equal(records[0].data.usage, undefined);
  } finally {
    await f.cleanup();
  }
});

test("rejects evaluator timeouts above the Node timer range before dispatch", async () => {
  const f = await fixture({ timeout: "2147483.648" });
  try {
    await f.session.prompt("Work then stop.");
    assert.equal(f.evaluationContexts.length, 0);
    assert.equal(f.current().goal?.status, "active");
    assert.equal(f.current().disarmed, true);
    assert.ok(
      f.notifications.some((message) => /no greater than 2147483\.647 seconds/.test(message)),
    );
  } finally {
    await f.cleanup();
  }
});

test("human edits and pause abort evaluator promptly and preserve new authority", async () => {
  for (const action of ["edit A different authorized scope", "pause"]) {
    const f = await fixture({ hang: true, timeout: "30" });
    try {
      const running = f.session.prompt("Start the task.");
      await f.started;
      await f.command(action);
      await Promise.race([
        running,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("Evaluator did not abort promptly")), 1000),
        ),
      ]);
      assert.equal(f.current().goal?.status, action === "pause" ? "paused" : "active");
      if (action.startsWith("edit")) {
        assert.equal(f.current().goal?.objective, "A different authorized scope");
        assert.equal(f.current().disarmed, false);
      }
      assert.equal(f.evaluationContexts.length, 1);
    } finally {
      await f.cleanup();
    }
  }
});

test("late successful provider output after an edit cannot complete the replacement goal", async () => {
  const f = await fixture({ defer: true });
  try {
    const running = f.session.prompt("Start the task.");
    await f.started;
    await f.command("edit Different authorized task");
    await running;
    f.releaseEvaluation();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.current().goal?.objective, "Different authorized task");
    assert.equal(f.current().goal?.status, "active");
    assert.equal(f.current().disarmed, false);
    assert.equal(
      f.session.sessionManager
        .getBranch()
        .filter(
          (entry: any) =>
            entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "result",
        ).length,
      0,
    );
    const receipts = f.session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-runtime.usage.v1");
    assert.equal(receipts.length, 1);
    assert.equal(
      receipts[0].data.usage,
      undefined,
      "the public SDK aborts completion, so late provider output cannot establish billed usage",
    );
  } finally {
    await f.cleanup();
  }
});

test("human clear aborts an in-flight evaluator and cannot revive the goal on replay", async () => {
  const f = await fixture({ defer: true });
  try {
    const running = f.session.prompt("Start the task.");
    await f.started;
    await f.command("clear");
    await running;
    f.releaseEvaluation();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.current().goal, undefined);
    assert.equal(f.current().disarmed, false);
    assert.equal(f.workerContexts.length, 1, "clearing does not start an automatic worker turn");
    assert.equal(
      f.session.sessionManager
        .getBranch()
        .filter(
          (entry: any) =>
            entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "result",
        ).length,
      0,
      "late evaluator output has no authority after clearing",
    );
    assert.ok(
      f.session.sessionManager
        .getBranch()
        .some((entry: any) => entry.customType === "pi-goal.cleared"),
      "the model receives the cleared-state acknowledgement",
    );
    await f.hook("session_start");
    assert.equal(f.current().goal, undefined);
  } finally {
    await f.cleanup();
  }
});

test("branch navigation and shutdown fence pending evaluation without accepting late completion", async () => {
  for (const hook of ["session_tree", "session_shutdown"]) {
    const f = await fixture({ defer: true });
    try {
      const running = f.session.prompt("Work in the selected branch.");
      await f.started;
      await f.hook(hook);
      await running;
      f.releaseEvaluation();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.current().goal?.status, "active");
      assert.equal(
        f.session.sessionManager
          .getBranch()
          .filter(
            (entry: any) =>
              entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "result",
          ).length,
        0,
      );
      assert.equal(
        f.current().disarmed,
        hook === "session_tree",
        "shutdown with no wait does not mutate the goal authority after closure",
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("queued continuation is handled by the worker before the evaluator assesses completion", async () => {
  let injected = false;
  const f = await fixture({
    beforeGoalFactory(pi) {
      pi.on("agent_before_settle", (event: any) => {
        if (injected) return;
        injected = true;
        return {
          continue: true,
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "fixture-result",
              content: "Inspect the additional acceptance result before stopping.",
              display: false,
            },
          ],
        };
      });
    },
  });
  try {
    await f.session.prompt("Perform the whole task.");
    assert.equal(f.workerContexts.length, 2);
    assert.equal(f.evaluationContexts.length, 1);
    assert.equal(f.current().goal?.status, "completed");
    assert.match(JSON.stringify(f.evaluationContexts[0]), /additional acceptance result/);
  } finally {
    await f.cleanup();
  }
});

test("human resume after evaluator failure starts a fresh blocker audit and preserves authorized scope and budget", async () => {
  const f = await fixture({
    budget: 1000,
    malformedAt: [3, 4],
    decisions: [
      { verdict: "blocked" },
      { verdict: "blocked" },
      { verdict: "incomplete" },
      { verdict: "incomplete" },
      { verdict: "blocked" },
      { verdict: "finished" },
    ],
  });
  try {
    await f.session.prompt("Investigate the required service.");
    const before = f.current().goal!;
    assert.equal(before.status, "active");
    assert.equal(before.blockerTurns, 2);
    assert.equal(f.current().disarmed, true);
    await f.command("resume");
    const resumed = f.current().goal!;
    assert.equal(resumed.revision, before.revision + 1);
    assert.equal(resumed.blockerTurns, 0);
    assert.equal(resumed.blocker, undefined);
    assert.equal(resumed.blockerKey, undefined);
    assert.equal(resumed.lastCountedCycle, undefined);
    assert.equal(resumed.lastCountedConditionKey, undefined);
    assert.deepEqual(resumed.audit, []);
    assert.equal(resumed.objective, before.objective);
    assert.deepEqual(resumed.criteria, before.criteria);
    assert.equal(resumed.budget, 1000);
    assert.deepEqual(resumed.usage, before.usage);
    assert.deepEqual(resumed.usageIds, before.usageIds);
    assert.equal(f.current().disarmed, false);
    await assert.rejects(
      f.tools
        .get("create_goal")
        .execute(
          "new-create",
          { objective: "Unapproved replacement" },
          undefined,
          undefined,
          f.ctx,
        ),
      /confirmation/,
    );
    for (let attempt = 0; attempt < 100 && f.current().goal?.status !== "completed"; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.current().goal?.status, "completed");
    const newStates = f.session.sessionManager
      .getBranch()
      .filter(
        (entry: any) =>
          entry.customType === "pi-goal.state" && entry.data.state.revision === resumed.revision,
      )
      .map((entry: any) => entry.data.state);
    assert.ok(
      newStates.some((state: any) => state.blockerTurns === 1 && state.status === "active"),
    );
    assert.ok(newStates.every((state: any) => state.status !== "blocked"));
    assert.equal(f.evaluationContexts.length, 6);
  } finally {
    await f.cleanup();
  }
});

test("stock steering yields a foreground goal wait and preserves its later one-time delivery", async () => {
  const f = await fixture({ foregroundWait: true });
  try {
    let resolve!: (value: any) => void;
    f.api.events.emit("goal:waiter", {
      version: 1,
      id: "wait-steer",
      owner: "fixture",
      sessionId: f.ctx.sessionManager.getSessionId(),
      producerGeneration: "steer-generation",
      promise: new Promise((done) => {
        resolve = done;
      }),
      isCurrent: () => true,
      respond(value: any) {
        assert.equal(value.accepted, true);
      },
    });
    const running = f.session.prompt("Await the delegated result.");
    for (
      let attempt = 0;
      attempt < 100 &&
      !f.session.messages.some(
        (message: any) =>
          message.role === "assistant" &&
          message.content.some(
            (part: any) => part.type === "toolCall" && part.name === "wait_for_goal_event",
          ),
      );
      attempt++
    )
      await new Promise((done) => setTimeout(done, 10));
    // Give the tool execution a turn to register its foreground waiter.
    await new Promise((done) => setTimeout(done, 10));
    await f.session.prompt("Answer my question while that result is pending.", {
      streamingBehavior: "steer",
    });
    await running;
    assert.equal(f.workerContexts.length, 2);
    assert.equal(f.current().disarmed, false);
    assert.equal(f.evaluationContexts.length, 0);
    assert.match(JSON.stringify(f.session.messages), /Wait yielded to human input/);
    assert.equal(
      f.session.sessionManager
        .getBranch()
        .filter((entry: any) => entry.customType === "pi-goal.delivery.v1").length,
      0,
    );
    resolve({ deliveryKey: "steered-result", value: "Verified delegated result" });
    await f.session.prompt("Await and integrate the same wait_id now.");
    assert.equal(f.current().goal?.status, "completed");
    assert.equal(
      f.session.sessionManager
        .getBranch()
        .filter((entry: any) => entry.customType === "pi-goal.delivery.v1").length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("one malformed assessment gets a bounded correction with separate usage and no extra worker turn", async () => {
  const f = await fixture({ malformedAt: 1 });
  try {
    await f.session.prompt("Perform and verify the task.");
    assert.equal(f.current().goal?.status, "completed");
    assert.equal(f.workerContexts.length, 1);
    assert.equal(f.evaluationContexts.length, 2);
    assert.match(
      JSON.stringify(f.evaluationContexts[1].messages.at(-1)),
      /prior assessment failed validation/,
    );
    const branch = f.session.sessionManager.getBranch();
    assert.equal(
      branch.filter(
        (entry: any) =>
          entry.customType === "pi-goal.evaluator.v1" && entry.data.kind === "failure",
      ).length,
      1,
    );
    assert.equal(
      branch.filter(
        (entry: any) =>
          entry.customType === "pi-runtime.usage.v1" && entry.data.kind === "evaluator",
      ).length,
      2,
    );
    assert.equal(f.current().goal?.blockerTurns, 0);
  } finally {
    await f.cleanup();
  }
});
