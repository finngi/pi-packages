import { withFixtureEvaluator } from "./evaluator-fixture.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Api, Model, CredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";

const credentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_id, fn) => fn(undefined),
  delete: async () => {},
};
const model: Model<Api> = {
  id: "fixture-codex",
  name: "Fixture Codex",
  provider: "fixture-codex",
  api: "openai-codex-responses",
  baseUrl: "https://fixture.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 128,
};
function response(call: { name: string; arguments: Record<string, unknown> }, index: number) {
  const item = {
    type: "function_call",
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
    status: "completed",
  };
  const events = [
    { type: "response.created", response: { id: `resp_${index}`, status: "in_progress" } },
    { type: "response.output_item.added", item: { ...item, arguments: "" }, output_index: 0 },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", item, output_index: 0 },
    {
      type: "response.completed",
      response: {
        id: `resp_${index}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens: 2,
          total_tokens: 7,
        },
      },
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("stock Codex serializer keeps request history append-only and private receipts out of model text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-serializer-"));
  const requests: any[] = [];
  let session: any, api: any;
  const objective = "Inspect every SERIALIZED_OBJECTIVE_SENTINEL condition";
  // A synthetic local token satisfies the adapter's claim parser; no account is consulted.
  const key = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
  try {
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: key,
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple: (physical, context, options) =>
        codexStream(physical, context, {
          ...options,
          transport: "sse",
          maxRetries: 0,
          fetch: async (_url, init) => {
            const bytes = init?.body;
            const body =
              bytes instanceof Uint8Array
                ? zstdDecompressSync(bytes).toString("utf8")
                : String(bytes);
            const payload = JSON.parse(body);
            requests.push(payload);
            if (requests.length === 1)
              return response(
                {
                  name: "create_goal",
                  arguments: {
                    objective,
                    budget: 30,
                    criteria: ["Inspect serializer", "Check admission"],
                  },
                },
                1,
              );
            if (requests.length === 2 || requests.length === 4)
              return response({ name: "get_goal", arguments: {} }, requests.length);
            if (requests.length === 3) return response({ name: "get_goal", arguments: {} }, 3);
            assert.equal(requests.length, 5, "evaluation must stop before a sixth worker request");
            const item = {
              type: "message",
              id: "msg-final",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Fixture payload inspected", annotations: [] },
              ],
            };
            const events = [
              { type: "response.created", response: { id: "resp-final", status: "in_progress" } },
              {
                type: "response.output_item.added",
                item: { ...item, content: [] },
                output_index: 0,
              },
              {
                type: "response.content_part.added",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: "Fixture payload inspected",
              },
              { type: "response.output_item.done", item, output_index: 0 },
              {
                type: "response.completed",
                response: {
                  id: "resp-final",
                  status: "completed",
                  output: [item],
                  usage: {
                    input_tokens: 5,
                    input_tokens_details: { cached_tokens: 1 },
                    output_tokens: 2,
                    total_tokens: 7,
                  },
                },
              },
            ];
            return new Response(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        }),
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
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: { mode: "off" },
      } as any),
    }));
    await session.bindExtensions({
      mode: "print",
      onError: (error: unknown) => {
        throw error;
      },
    });
    session.setActiveToolsByName(["create_goal", "get_goal"]);
    api.events.emit("goal:create_authorization", {
      objective,
      budget: 30,
      criteria: ["Inspect serializer", "Check admission"],
    });
    await session.prompt(
      "Create the authorized fixture, inspect it and assess the fixed criteria.",
    );
    assert.equal(
      requests.length,
      5,
      JSON.stringify(
        session.messages
          ?.filter((message: any) => message.role === "assistant")
          .map((message: any) => ({
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
          })),
      ),
    );
    assert.doesNotMatch(requests[0].instructions, /An explicitly authorized goal/);
    for (const [index, payload] of requests.entries()) {
      if (index > 0) {
        assert.equal(payload.instructions, requests[1].instructions);
        assert.match(payload.instructions, /fixed acceptance criteria/);
      }
      assert.doesNotMatch(
        payload.instructions,
        /SERIALIZED_OBJECTIVE_SENTINEL|Recorded goal usage|remaining:|scope revision:/,
      );
    }
    assert.doesNotMatch(JSON.stringify(requests), /pi-goal-request:|No goal is active/);
    assert.match(JSON.stringify(requests[1].input), /SERIALIZED_OBJECTIVE_SENTINEL/);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1].input;
      assert.deepEqual(requests[index].input.slice(0, previous.length), previous);
    }
    const state = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "pi-goal.state")
      .at(-1).data.state;
    assert.equal(state.status, "completed");
    assert.deepEqual(state.usage, {
      input: 16,
      output: 8,
      cacheRead: 4,
      cacheWrite: 0,
      missing: 0,
    });
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
