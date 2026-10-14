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
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { goalBudgetSummary } from "./presentation.ts";
import { reduceGoal, withinBudget } from "./goal.ts";

const fixtureModel: Model<Api> = {
  id: "scripted",
  name: "Scripted",
  api: "goal-admission-fixture",
  provider: "goal-admission-fixture",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 128,
};

function scriptedResponse(
  model: Model<Api>,
  tool?: { id: string; name: string; arguments: Record<string, unknown> },
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: tool
      ? [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.arguments }]
      : [{ type: "text", text: "Finished scripted work." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: tool ? "toolUse" : "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
  return stream;
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.map((part: any) => (part.type === "text" ? part.text : "")).join("\n")
    : "";
}

test("pinned Pi 1.1.0 stops the next tool-loop dispatch at budget and retains goal data in ordinary tool results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-admission-"));
  const calls: { system: unknown; tail: string }[] = [];
  let api: any;
  let requestCount = 0;
  let session: any;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      apiKey: "fixture-only",
      baseUrl: fixtureModel.baseUrl,
      models: [fixtureModel],
      streamSimple(model, context, options) {
        assert.equal(
          options?.apiKey,
          "fixture-only",
          "the wrapped composed provider retains request-time auth",
        );
        requestCount++;
        const last = context.messages.at(-1);
        calls.push({ system: context.messages[0], tail: messageText(last) });
        if (requestCount === 1) {
          return scriptedResponse(model, {
            id: "create-goal",
            name: "create_goal",
            arguments: {
              objective: "Inspect both authorized requirements",
              criteria: ["Inspect source", "Verify behavior"],
              budget: 2,
            },
          });
        }
        if (requestCount === 2) {
          assert.match(calls.at(-1)!.tail, /Inspect source/);
          return scriptedResponse(model, { id: "inspect-goal", name: "get_goal", arguments: {} });
        }
        return scriptedResponse(model);
      },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [
        withFixtureEvaluator(goalExtension),
        (pi) => {
          api = pi;
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: fixtureModel,
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
    api.events.emit("goal:create_authorization", {
      objective: "Inspect both authorized requirements",
      criteria: ["Inspect source", "Verify behavior"],
      budget: 2,
    });
    session.setActiveToolsByName(["create_goal", "get_goal"]);
    await session.prompt("Start and make one evidence-backed update.");

    assert.equal(
      requestCount,
      2,
      "provider saw only the create request and one in-scope continuation",
    );
    assert.equal(calls.length, 2);
    assert.equal(
      (calls[0].system as any).sections.goal,
      undefined,
      "a request without a goal has no goal instructions",
    );
    assert.match((calls[1].system as any).sections.goal, /fixed acceptance criteria/);
    assert.doesNotMatch(calls[0].tail, /No goal is active|pi-goal-request:/);
    assert.match(calls[1].tail, /goal-[a-z-]+/);
    assert.match(calls[1].tail, /Inspect source/);
    assert.match(calls[1].tail, /Verify behavior/);
    assert.match(calls[1].tail, /Recorded goal usage: 0 parent-provider tokens/);

    const saved = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-goal.state")
      .at(-1)?.data.state;
    assert.equal(saved.usage.input, 2);
    assert.equal(saved.evidence.length, 0);
    assert.equal(saved.criteria.length, 2);
    assert.equal(saved.status, "active");
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit missing usage stops while an omitted budget stays unlimited", () => {
  let limited = reduceGoal(undefined, {
    type: "create",
    id: "goal-limited",
    objective: "Do all of it",
    budget: 10,
  })!;
  limited = reduceGoal(limited, {
    type: "usage",
    id: "missing-request",
    goalId: limited.id,
    usage: undefined,
  })!;
  assert.equal(withinBudget(limited), false);
  assert.match(goalBudgetSummary(limited), /remaining: unknown/);

  let unlimited = reduceGoal(undefined, {
    type: "create",
    id: "goal-unlimited",
    objective: "Do all of it",
  })!;
  unlimited = reduceGoal(unlimited, {
    type: "usage",
    id: "missing-request",
    goalId: unlimited.id,
    usage: undefined,
  })!;
  assert.equal(withinBudget(unlimited), true);
  assert.match(goalBudgetSummary(unlimited), /Goal token limit: unlimited/);
});

test("completion fences the remaining tool loop, while an unmarked standalone call is uncharged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-completion-"));
  const calls: string[] = [];
  let api: any;
  let providerCalls = 0;
  let runtime: ModelRuntime | undefined;
  let session: any;
  try {
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      apiKey: "fixture-only",
      baseUrl: fixtureModel.baseUrl,
      models: [fixtureModel],
      streamSimple(model, context) {
        providerCalls++;
        const tail = messageText(context.messages.at(-1));
        calls.push(tail);
        if (providerCalls === 1) {
          return scriptedResponse(model, {
            id: "create-goal",
            name: "create_goal",
            arguments: {
              objective: "Verify the complete fixed scope",
              criteria: ["First acceptance item", "Second acceptance item"],
            },
          });
        }
        return scriptedResponse(model);
      },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      extensionFactories: [
        withFixtureEvaluator(goalExtension),
        (pi) => {
          api = pi;
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: fixtureModel,
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
    api.events.emit("goal:create_authorization", {
      objective: "Verify the complete fixed scope",
      criteria: ["First acceptance item", "Second acceptance item"],
    });
    session.setActiveToolsByName(["create_goal", "get_goal"]);
    await session.prompt("Create, assess every fixed criterion, and stop when complete.");

    assert.equal(
      providerCalls,
      2,
      "evaluation at settlement completes the goal without another worker dispatch",
    );
    assert.match(calls[1], /^Goal: active/);
    const saved = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-goal.state")
      .at(-1)?.data.state;
    assert.equal(saved.status, "completed");
    assert.equal(
      saved.usage.input,
      2,
      "the request that completed the goal was charged under its captured authority",
    );

    // A direct runtime request without a main-request binding is allowed but has no goal receipt.
    const unrelated = await runtime
      .streamSimple(
        fixtureModel,
        {
          messages: [
            { role: "user", content: [{ type: "text", text: "unrelated standalone request" }] },
          ],
        } as any,
        { sessionId: session.sessionManager.getSessionId() },
      )
      .result();
    assert.equal(unrelated.stopReason, "stop");
    assert.equal(providerCalls, 3);
    const latest = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-goal.state")
      .at(-1)?.data.state;
    assert.equal(
      latest.usage.input,
      2,
      "an unmarked direct request does not enter the goal ledger",
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a dispatched request remains charged to its captured goal when a human pauses in flight", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-inflight-pause-"));
  let commandHandler: ((args: string, ctx: any) => Promise<unknown>) | undefined;
  let commandContext: any;
  let extensionApi: any;
  let providerCalls = 0;
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let session: any;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      apiKey: "fixture-only",
      baseUrl: fixtureModel.baseUrl,
      models: [fixtureModel],
      streamSimple(model, _context, options) {
        providerCalls++;
        if (providerCalls === 1)
          return scriptedResponse(model, {
            id: "create-goal",
            name: "create_goal",
            arguments: {
              objective: "Pause during one authorized request",
              criteria: ["Inspect the in-flight response"],
            },
          });
        const stream = createAssistantMessageEventStream();
        const partial = {
          role: "assistant" as const,
          content: [] as any[],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 8 },
          stopReason: "pending" as const,
          timestamp: Date.now(),
        } as unknown as AssistantMessage;
        stream.push({ type: "start", partial });
        const abort = () => {
          const message = {
            ...partial,
            stopReason: "aborted" as const,
            errorMessage: "Request was aborted",
            timestamp: Date.now(),
          } as AssistantMessage;
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
        started();
        return stream;
      },
    });
    const captureCommand = (pi: any) => {
      extensionApi = pi;
      const registerCommand = pi.registerCommand.bind(pi);
      pi.registerCommand = (name: string, command: any) => {
        if (name === "goal") commandHandler = command.handler;
        return registerCommand(name, command);
      };
      goalExtension(pi);
      pi.on("context_with_system", async (_event: unknown, ctx: any) => {
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
      model: fixtureModel,
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
    session.setActiveToolsByName(["create_goal", "get_goal"]);
    extensionApi.events.emit("goal:create_authorization", {
      objective: "Pause during one authorized request",
      criteria: ["Inspect the in-flight response"],
    });
    const prompt = session.prompt("Create the authorized goal and begin a follow-up request.");
    await providerStarted;
    assert.equal(providerCalls, 2, "the second request has reached its provider before the pause");
    assert.ok(commandHandler && commandContext);
    await commandHandler("pause", commandContext);
    await prompt;

    const saved = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-goal.state")
      .at(-1)?.data.state;
    assert.equal(saved.status, "paused");
    assert.equal(saved.usage.input, 5);
    assert.equal(saved.usage.cacheRead, 2);
    assert.equal(saved.usage.output, 1);
    assert.equal(
      saved.usage.missing,
      1,
      "known usage is retained while aborted completeness is marked unknown",
    );
    assert.equal(
      providerCalls,
      2,
      "pause aborts the active provider request and no further tool-loop call is admitted",
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
