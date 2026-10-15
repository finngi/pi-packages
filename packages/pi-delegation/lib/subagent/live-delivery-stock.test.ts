import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import extension from "../../extensions/subagent.ts";
import { MESSAGE_BRIDGE } from "./messages.ts";

async function deliveryFixture(delayed: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "agent-delivery-stock-"));
  const agentDir = join(dir, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents/general-purpose.md"),
    "---\nname: general-purpose\ndescription: Fixture worker\nconversation: none\n---\nComplete the assigned work.",
  );
  const saved = {
    agent: process.env.PI_CODING_AGENT_DIR,
    transport: process.env.PI_SECURITY_TRANSPORT,
    child: process.env.PI_SUBAGENT,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_SECURITY_TRANSPORT: "extensions",
  });
  delete process.env.PI_SUBAGENT;
  let session: sdk.AgentSession | undefined,
    run: any,
    resolveDone: Function = () => {},
    next = 0,
    childId = "",
    childRequestId = "";
  const seen: any[] = [],
    contexts: any[] = [],
    errors: any[] = [];
  const emit = (value: any) => run.onData("stdout", Buffer.from(JSON.stringify(value) + "\n"));
  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const transport = {
    launch(spec: any) {
      run = spec;
      return { id: "worker-1", done: new Promise((resolve) => (resolveDone = resolve)) };
    },
    async write(_id: string, data: Buffer) {
      const value = JSON.parse(data.toString());
      if (value.type === "prompt") childRequestId = value.id;
      if (value.type !== "extension_ui_response")
        emit({
          type: "response",
          id: value.id,
          success: true,
          data: { disposition: "queued" },
        });
    },
    cancel() {
      resolveDone({ id: "worker-1", status: "cancelled", exitCode: 0 });
    },
  };
  const model: any = {
    id: "scripted-delivery",
    name: "Scripted delivery",
    api: "delivery-fixture",
    provider: "delivery-fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  try {
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture-only",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple: (_model: any, context: any) => {
        contexts.push(context.messages);
        const index = next++,
          stream = createAssistantMessageEventStream();
        const calls = [
          { name: "subagent", arguments: { agent: "general-purpose", task: "Fixture task" } },
          { name: "hold", arguments: {} },
          ...(delayed
            ? [
                { name: "subagent_check", arguments: { id: childId } },
                { name: "subagent_close", arguments: { id: childId } },
              ]
            : []),
        ];
        const call = calls[index];
        const reason = call ? "toolUse" : "stop";
        const message: any = {
          role: "assistant",
          content: call
            ? [{ type: "toolCall", id: `call-${index}`, ...call }]
            : [
                {
                  type: "text",
                  text: index === 2 ? "Read live updates" : "Read deferred update",
                },
              ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { ...model.cost, total: 0 },
          },
          stopReason: reason,
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason, message });
          stream.end();
        });
        return stream;
      },
    });
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          path: "fixture:delivery",
          factory(pi) {
            const security: any = {
              version: 1,
              prepareShell() {},
              describeChild: async () => ({
                tools: ["read", "agent_message", "agent_list"],
                scope: { write: "none" },
              }),
              prepareChildLaunch: async (spec: any) => {
                childId = spec.communication.id;
                return {
                  id: "launch",
                  argv: ["pi"],
                  env: {},
                  cwd: dir,
                  tmp: dir,
                  communication: spec.communication,
                  effectiveResources: { tools: ["read", "agent_message", "agent_list"] },
                  workspaceKind: "project",
                  cleanup: async () => {},
                };
              },
            };
            pi.events.on("pi-security:service:v1", (value: any) => value.respond(security));
            pi.events.on("background:service", (value: any) => value.respond(transport));
            extension(pi);
            pi.registerTool({
              name: "hold",
              label: "Hold",
              description: "Fixture boundary",
              parameters: Type.Object({}),
              async execute(_id, _params, _signal, _update, ctx) {
                assert.equal(ctx.isIdle(), false);
                const main: any = ctx.sessionManager
                  .getBranch()
                  .find((e: any) => e.customType === "pi-subagents.identity.v1");
                for (const [id, message, mode, kind] of delayed
                  ? [["routine", "DELAYED_ROUTINE", "followUp", "progress"]]
                  : [
                      ["live", "LIVE_STATUS", undefined, "question"],
                      ["later", "DEFERRED_STATUS", "followUp", "message"],
                    ])
                  emit({
                    type: "extension_ui_request",
                    id,
                    method: "select",
                    options: ["Deliver"],
                    title:
                      MESSAGE_BRIDGE +
                      JSON.stringify({
                        to: main.data.agentId,
                        message,
                        kind,
                        emittedAt: "2026-10-13T10:00:00.000Z",
                        ...(mode ? { mode } : {}),
                      }),
                  });
                if (!delayed) await tick();
                const answer = {
                  role: "assistant",
                  content: [{ type: "text", text: "READY_RESULT" }],
                  stopReason: "stop",
                };
                emit({ type: "message_start", message: answer });
                emit({ type: "message_end", message: answer });
                emit({ type: "turn_end", message: answer });
                if (delayed) {
                  run.onData(
                    "stdout",
                    Buffer.from(
                      [
                        { type: "agent_settled", aborted: false },
                        {
                          type: "extension_ui_request",
                          id: "after-final",
                          method: "select",
                          options: ["Deliver"],
                          title:
                            MESSAGE_BRIDGE +
                            JSON.stringify({
                              to: main.data.agentId,
                              message: "AFTER_FINAL_ROUTINE",
                              kind: "progress",
                              emittedAt: "2026-10-13T10:00:00.000Z",
                            }),
                        },
                      ]
                        .map((value) => JSON.stringify(value) + "\n")
                        .join(""),
                    ),
                  );
                  await tick();
                } else emit({ type: "agent_settled", aborted: false });
                assert(
                  !ctx.sessionManager
                    .getBranch()
                    .some(
                      (e: any) =>
                        e.type === "custom_message" && String(e.content).includes("LIVE_STATUS"),
                    ),
                  "Never append between the tool call and its result",
                );
                return { content: [{ type: "text", text: "HOLD_FINISHED" }], details: {} };
              },
            });
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd: dir,
      agentDir,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(dir),
      noTools: "builtin",
      model,
      thinkingLevel: "off",
    }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    session.subscribe((event) => {
      if (event.type === "message_end" || event.type === "agent_settled") seen.push(event);
    });
    await session.prompt("Run deterministic message-delivery fixture.");
    assert.deepEqual(errors, []);
    if (delayed) {
      assert.equal(contexts.length, 5, "only the four requested tools and final response run");
      assert(seen.filter((e) => e.message?.role === "toolResult").every((e) => !e.message.isError));
      const entries: any[] = session.sessionManager.getBranch();
      const progress = entries.find(
        (e) => e.type === "custom_message" && String(e.content).includes("DELAYED_ROUTINE"),
      );
      assert(progress);
      assert.equal(progress.details.kind, "progress");
      assert.equal(progress.details.emittedAt, "2026-10-13T10:00:00.000Z");
      assert.deepEqual(progress.details.sourceRequestIds, [childRequestId]);
      const afterFinal = entries.find(
        (e) => e.type === "custom_message" && String(e.content).includes("AFTER_FINAL_ROUTINE"),
      );
      assert(afterFinal);
      assert.deepEqual(
        afterFinal.details.sourceRequestIds,
        [],
        "a later frame in the same stdout chunk has no active request after settlement",
      );
      const receipt = entries.find(
        (e) =>
          e.type === "message" &&
          e.message.role === "toolResult" &&
          e.message.toolName === "subagent_close",
      ).message.details;
      assert.equal(receipt.status, "closed");
      assert.equal(receipt.artifacts.scope, "project-reference");
      assert.equal(receipt.artifacts.externalEffects, "untracked");
      assert.equal(receipt.artifacts.owned, false);
      assert.deepEqual(receipt.artifacts.files, []);
      const main: any = entries.find((e) => e.customType === "pi-subagents.identity.v1");
      emit({
        type: "extension_ui_request",
        id: "after-close",
        method: "select",
        options: ["Deliver"],
        title:
          MESSAGE_BRIDGE +
          JSON.stringify({
            to: main.data.agentId,
            message: "CLOSED_LATE_TELEMETRY",
            kind: "progress",
            emittedAt: "2026-10-13T10:00:00.000Z",
          }),
      });
      await tick();
      assert.equal(contexts.length, 5, "terminal closure cannot create a new turn");
      const retained: any[] = session.sessionManager.getBranch();
      assert(
        retained.some(
          (e) => e.type === "custom_message" && String(e.content).includes("DELAYED_ROUTINE"),
        ),
        "already queued telemetry stays history",
      );
      assert(
        !retained.some(
          (e) => e.type === "custom_message" && String(e.content).includes("CLOSED_LATE_TELEMETRY"),
        ),
        "new frames from a closed source are refused",
      );
      return;
    }
    assert.equal(contexts.length, 4);
    assert(seen.filter((e) => e.message?.role === "toolResult").every((e) => !e.message.isError));
    assert.match(JSON.stringify(contexts[2]), /LIVE_STATUS/);
    assert.match(JSON.stringify(contexts[2]), /READY_RESULT/);
    assert(!JSON.stringify(contexts[2]).includes("DEFERRED_STATUS"));
    assert.match(JSON.stringify(contexts[3]), /DEFERRED_STATUS/);
    const entries: any[] = session.sessionManager.getBranch();
    const hold = entries.findIndex(
      (e) =>
        e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "hold",
    );
    const live = entries.findIndex(
      (e) => e.type === "custom_message" && String(e.content).includes("LIVE_STATUS"),
    );
    const ready = entries.findIndex(
      (e) => e.type === "custom_message" && String(e.content).includes("READY_RESULT"),
    );
    assert(hold >= 0 && live > hold && ready > hold);
    assert.equal(
      entries.filter(
        (e) => e.type === "custom_message" && String(e.content).includes("READY_RESULT"),
      ).length,
      1,
    );
    const settled = seen.findIndex((e) => e.type === "agent_settled");
    assert(
      settled >
        seen.findIndex(
          (e) =>
            e.message?.customType === "agent-message" &&
            String(e.message.content).includes("LIVE_STATUS"),
        ),
    );
    const main: any = entries.find((e) => e.customType === "pi-subagents.identity.v1");
    emit({
      type: "extension_ui_request",
      id: "idle-progress",
      method: "select",
      options: ["Deliver"],
      title:
        MESSAGE_BRIDGE +
        JSON.stringify({
          to: main.data.agentId,
          message: "IDLE_ROUTINE",
          kind: "progress",
          emittedAt: "2026-10-13T10:00:00.000Z",
        }),
    });
    await tick();
    assert.equal(contexts.length, 4, "routine telemetry does not wake an idle parent");
    assert(
      session.sessionManager
        .getBranch()
        .some(
          (e: any) => e.type === "custom_message" && String(e.content).includes("IDLE_ROUTINE"),
        ),
    );
    // Wait for Pi's actual idle turn; a fixed number of event-loop ticks can finish before it starts.
    const questionSettled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(Error("idle question did not settle"));
      }, 2000);
      const unsubscribe = session!.subscribe((event) => {
        if (event.type !== "agent_settled") return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
    emit({
      type: "extension_ui_request",
      id: "idle-question",
      method: "select",
      options: ["Deliver"],
      title:
        MESSAGE_BRIDGE +
        JSON.stringify({
          to: main.data.agentId,
          message: "IDLE_QUESTION",
          kind: "question",
          emittedAt: "2026-10-13T10:00:00.000Z",
        }),
    });
    await questionSettled;
    assert.equal(contexts.length, 5, "questions retain idle wakeups");
  } finally {
    if (session) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", saved.agent],
      ["PI_SECURITY_TRANSPORT", saved.transport],
      ["PI_SUBAGENT", saved.child],
    ])
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const delayed of [false, true])
  test(
    delayed
      ? "stock Pi retains delayed routine telemetry across final/check/close without new work"
      : "stock Pi receives live messages and unconsumed results before settlement, after tool results",
    () => deliveryFixture(delayed),
  );
