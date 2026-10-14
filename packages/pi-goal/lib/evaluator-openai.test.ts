import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import {
  EVALUATION_PARAMETERS,
  EVALUATION_TOOL,
  EVALUATOR_SYSTEM,
  evaluationFromResponse,
} from "./evaluator.ts";

const model: Model<"openai-completions"> = {
  id: "evaluator-fixture",
  provider: "baseten",
  api: "openai-completions",
  name: "Structured evaluator serializer fixture",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};
const criteria = [{ id: "task-blue-green-red", requirement: "Tests pass" }];
const assessment = {
  verdict: "finished",
  reason: "All tests passed",
  blockerKey: null,
  requirements: [{ criterionId: criteria[0].id, evidence: "node --test passed", verdict: "met" }],
};

test("stock OpenAI serializer sends Literal enums and uses strict sampling only when the model declares support", async () => {
  for (const strict of [false, true]) {
    let payload: any;
    const response = await streamSimple(
      { ...model, compat: { supportsStrictMode: strict } },
      {
        messages: [
          {
            role: "system",
            content: EVALUATOR_SYSTEM,
            timestamp: 0,
            toolsAdded: [
              {
                name: EVALUATION_TOOL,
                description: "Return assessment",
                parameters: EVALUATION_PARAMETERS,
                constrainedSampling: { type: "json_schema", strict: "prefer" },
              },
            ],
          },
          {
            role: "user",
            content: JSON.stringify({ goal: { objective: "Verify", criteria } }),
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: "fixture-only",
        maxTokens: 2048,
        reasoning: "minimal",
        fetch: async (_url, init) => {
          payload = JSON.parse(String(init?.body));
          const chunks = [
            {
              id: "chat-fixture",
              object: "chat.completion.chunk",
              created: 0,
              model: model.id,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-eval",
                        type: "function",
                        function: { name: EVALUATION_TOOL, arguments: JSON.stringify(assessment) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chat-fixture",
              object: "chat.completion.chunk",
              created: 0,
              model: model.id,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
            },
          ];
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    ).result();
    assert.equal(evaluationFromResponse(response, { criteria }).verdict, "finished");
    assert.equal(payload.tools.length, 1);
    const definition = payload.tools[0].function;
    assert.equal(definition.name, EVALUATION_TOOL);
    assert.equal(definition.strict, strict ? true : undefined);
    const schema = JSON.stringify(definition.parameters.properties.verdict);
    for (const verdict of ["finished", "incomplete", "blocked"])
      assert.ok(schema.includes(verdict));
    assert.equal(
      payload.tool_choice,
      undefined,
      "Pi 1.1.0 has no neutral forced-named-tool option; local validation is still required",
    );
  }
});
