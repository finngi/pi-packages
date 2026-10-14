import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSIFIER_OUTPUT_SCHEMA,
  classify,
  classifierTranscript,
  parseClassifierOutput,
} from "../../src/classifier.ts";

const view = {
  tool: "bash",
  input: { command: "true" },
  permissions: { write: false, network: [] },
};
const model = { api: "openai-codex-responses", reasoning: true, thinkingLevelMap: { off: "none" } };
const json = JSON.stringify({ reason: "Requested action", verdict: "allow" });
const completed = (text = json) => ({
  stopReason: "stop",
  rawStopReason: "completed",
  content: [{ type: "text", text }],
});
async function run({
  response = completed(),
  events = [],
  applyPayload = true,
  api = model.api,
} = {}) {
  return classify(view, {
    model: { ...model, api },
    client: {
      complete: async (_model, _context, options) => {
        if (applyPayload) options.onPayload({ text: { verbosity: "low" } });
        for (const event of events) await options.onProviderStreamEvent(event);
        return response;
      },
    },
  });
}

test("Responses schema is strict, preserves text settings, and disables tools", async () => {
  for (const api of ["openai-codex-responses", "openai-responses"]) {
    const result = await classify(view, {
      model: { ...model, api },
      client: {
        complete: async (_model, context, options) => {
          assert.equal(context.tools, undefined);
          assert.equal(options.reasoningEffort, "none");
          const body = options.onPayload({ model: "fixture", text: { verbosity: "low" } });
          assert.equal(body.model, "fixture");
          assert.equal(body.text.verbosity, "low");
          assert.equal(body.tool_choice, "none");
          assert.deepEqual(Object.keys(body.text.format.schema.properties), ["reason", "verdict"]);
          assert.match(context.systemPrompt, /short reason, then the permission verdict/);
          assert.deepEqual(body.text.format, {
            type: "json_schema",
            name: "permission_verdict",
            strict: true,
            schema: CLASSIFIER_OUTPUT_SCHEMA,
          });
          assert.deepEqual(body.text.format.schema, {
            type: "object",
            properties: {
              reason: { type: "string" },
              verdict: { type: "string", enum: ["allow", "deny", "ask"] },
            },
            required: ["reason", "verdict"],
            additionalProperties: false,
          });
          return completed();
        },
      },
    });
    assert.equal(result.verdict, "allow");
    assert.equal(result.note, "Requested action");
  }
});

test("whole JSON parser rejects repairs, extra fields, missing fields, and wrong types", () => {
  for (const raw of [
    "<verdict>allow</verdict> yes",
    `Heading\n${json}`,
    `\x60\x60\x60json\n${json}\n\x60\x60\x60`,
    `${json}\n${json}`,
    '{"verdict":"allow","reason":"partial"',
    '{"verdict":"ALLOW","reason":"wrong case"}',
    '{"verdict":"banana","reason":"invalid enum"}',
    '{"verdict":"allow"}',
    '{"verdict":"allow","reason":42}',
    '{"verdict":"allow","reason":null}',
    '{"verdict":"allow","reason":""}',
    '{"verdict":"allow","reason":" \\t\\n"}',
    '{"verdict":"allow","reason":"yes","extraWritablePaths":["/"]}',
    "null",
    "[]",
    "true",
  ])
    assert.equal(parseClassifierOutput(raw), undefined, raw);
  assert.deepEqual(parseClassifierOutput(` \n${json}\n `), {
    verdict: "allow",
    reason: "Requested action",
  });
});

test("allow, deny and ask preserve bounded reasons, and ask maps to unsure", async () => {
  for (const verdict of ["allow", "deny", "ask"]) {
    const result = await run({
      response: completed(JSON.stringify({ verdict, reason: ` ${"r".repeat(350)} ` })),
    });
    assert.equal(result.verdict, verdict === "ask" ? "unsure" : verdict);
    assert.equal(result.note, "r".repeat(300));
    assert.equal(result.reasonCode, "classifier-chat");
  }
});

test("incomplete and failed responses never allow even when their text is valid JSON", async () => {
  for (const stopReason of ["length", "error", "aborted", "pending", "toolUse"]) {
    const result = await run({ response: { ...completed(), stopReason } });
    assert.equal(result.verdict, "unsure", stopReason);
  }
  for (const rawStopReason of [
    undefined,
    "incomplete.max_output_tokens",
    "incomplete.content_filter",
    "queued",
    "in_progress",
    "failed",
  ]) {
    assert.equal(
      (await run({ response: { ...completed(), rawStopReason } })).verdict,
      "unsure",
      String(rawStopReason),
    );
  }
});

test("refusal is detected before Pi flattens it into ordinary text", async () => {
  for (const event of [
    { type: "response.refusal.delta", delta: json },
    { type: "response.refusal.done", refusal: json },
    {
      type: "response.output_item.added",
      item: { type: "message", content: [{ type: "refusal", refusal: json }] },
    },
    {
      type: "response.output_item.done",
      item: { type: "message", content: [{ type: "refusal", refusal: json }] },
    },
    {
      type: "response.completed",
      response: { output: [{ type: "message", content: [{ type: "refusal", refusal: json }] }] },
    },
  ]) {
    const result = await run({ events: [event] });
    assert.equal(result.verdict, "unsure");
    assert.equal(result.reasonCode, "refusal");
  }
});

test("missing payload hook, extra messages, and unexpected tools fail closed", async () => {
  assert.equal((await run({ applyPayload: false })).verdict, "unsure");
  for (const content of [
    [],
    [...completed().content, { type: "text", text: "extra" }],
    [
      ...completed().content,
      {
        type: "toolCall",
        name: "permission_verdict",
        arguments: { verdict: "allow", reason: "yes" },
      },
    ],
    [{ type: "text", text: "sure allow" }],
  ])
    assert.equal((await run({ response: { ...completed(), content } })).verdict, "unsure");
  const withReasoning = await run({
    response: {
      ...completed(),
      content: [{ type: "thinking", thinking: "evidence" }, ...completed().content],
    },
  });
  assert.equal(withReasoning.verdict, "allow");
});

test("unsupported APIs make no model call and transport errors do not retry prompt-only", async () => {
  let calls = 0;
  for (const api of ["anthropic-messages", "openai-completions", "google-generative-ai"]) {
    const result = await classify(view, {
      model: { ...model, api },
      client: {
        complete: async () => {
          calls++;
          return completed();
        },
      },
    });
    assert.equal(result.reasonCode, "unsupported-api");
  }
  assert.equal(calls, 0);
  const result = await classify(view, {
    model,
    client: {
      complete: async () => {
        calls++;
        throw Error("Unsupported text.format");
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.verdict, "unsure");
  assert.equal(result.reasonCode, "transport-error");
});

test("normalized per-call paths are separate evidence and output cannot grant paths", () => {
  const transcript = classifierTranscript({
    ...view,
    input: { command: "touch /tmp/report", permissions: { write: ["/tmp"] } },
    permissions: { write: true, network: [] },
    writeGrants: [{ path: "/private/tmp/report", kind: "file", createParents: [] }],
  });
  assert.match(transcript, /Context: .*"writeGrants":\[\{"path":"\/private\/tmp\/report"/);
  assert.match(transcript, /bash: .*"permissions":\{"write":\["\/tmp"\]/);
  assert.equal(
    parseClassifierOutput('{"verdict":"allow","reason":"yes","paths":["/"]}'),
    undefined,
  );
});

test("native choice classification remains independent of chat schema support", async () => {
  for (const [choice, confidence, stopReason, expected] of [
    ["allow", 0.9, "stop", "allow"],
    ["deny", 1, "stop", "deny"],
    ["ask", 0, "stop", "unsure"],
    ["banana", 1, "stop", "unsure"],
    ["allow", Number.NaN, "stop", "unsure"],
    ["allow", 2, "stop", "unsure"],
    ["allow", 0.9, "error", "unsure"],
  ]) {
    const result = await classify(view, {
      client: {
        classify: async () => ({
          stopReason,
          answers: { verdict: { type: "choice", choice, confidence } },
        }),
      },
    });
    assert.equal(result.verdict, expected);
  }
});
