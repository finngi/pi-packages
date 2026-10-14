import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";

test("custom wakeups keep prompt sections, queued context and startup ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-wakeup-"));
  const contexts: any[] = [],
    starts: any[] = [];
  let session: sdk.AgentSession | undefined,
    calls = 0,
    cancelledHook = false;
  let signalCancelStarted!: () => void, releaseCancelHook!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    signalCancelStarted = resolve;
  });
  const cancelHook = new Promise<void>((resolve) => {
    releaseCancelHook = resolve;
  });
  const model: any = {
    id: "wakeup",
    name: "Wakeup fixture",
    api: "wakeup-fixture",
    provider: "fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(dir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture-only",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple: (_model: any, context: any) => {
        contexts.push(structuredClone(context));
        const index = calls++,
          tool = index === 1;
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: tool
            ? [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }]
            : [{ type: "text", text: "done" }],
          stopReason: tool ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            ...model.cost,
            input: 1,
            output: 1,
            totalTokens: 2,
            cost: { ...model.cost, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        });
        return stream;
      },
    });
    const settings = sdk.SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        {
          path: "fixture:wakeup",
          factory(pi) {
            pi.registerTool({
              name: "probe",
              label: "Probe",
              description: "Fixture tool",
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "tool result" }], details: {} };
              },
            });
            pi.on("before_agent_start", async (event, ctx) => {
              starts.push({
                type: event.messageType,
                idle: ctx.isIdle(),
                prompt: "prompt" in event,
              });
              if (event.messageType === "custom" && event.message.customType === "cancel-fixture") {
                cancelledHook = true;
                signalCancelStarted();
                await cancelHook;
              }
              return {
                systemPrompt: event.systemPrompt + "\n<fixture_context>stable</fixture_context>",
              };
            });
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(dir),
      tools: [],
    }));
    await session.bindExtensions({});
    await session.prompt("initial user turn");
    await session.sendCustomMessage(
      { customType: "queued-fixture", content: "queued context", display: false },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
    await session.sendCustomMessage(
      { customType: "result-fixture", content: "worker completed", display: true },
      { triggerTurn: true },
    );
    assert.deepEqual(starts.slice(0, 2), [
      { type: "user", idle: false, prompt: true },
      { type: "custom", idle: false, prompt: false },
    ]);
    assert.equal(contexts.length, 3);
    const prompts = contexts.map((context) =>
      JSON.stringify(context.messages.filter((m: any) => m.role === "system")),
    );
    assert.equal(prompts[1], prompts[2]);
    assert.equal(prompts[2].split("<fixture_context>").length, 2);
    assert.match(JSON.stringify(contexts[1].messages), /queued context/);
    assert.equal(
      session.state.messages.filter((m: any) => m.customType === "queued-fixture").length,
      1,
    );
    const beforeQuiet = calls;
    await session.sendCustomMessage(
      { customType: "progress-fixture", content: "routine progress", display: true },
      { triggerTurn: false },
    );
    assert.equal(calls, beforeQuiet);
    const cancellingTurn = session.sendCustomMessage(
      { customType: "cancel-fixture", content: "cancel during startup", display: false },
      { triggerTurn: true },
    );
    await cancelStarted;
    const aborting = session.abort();
    releaseCancelHook();
    await Promise.all([cancellingTurn, aborting]);
    assert.equal(cancelledHook, true);
    assert.equal(calls, beforeQuiet, "cancel during hook must not dispatch provider work");
    assert.equal(session.isStreaming, false);
  } finally {
    await session?.abort();
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
