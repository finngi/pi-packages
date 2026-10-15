import assert from "node:assert/strict";
import test from "node:test";
import { classify, parseVerdict } from "../lib/classifier.ts";
import {
  assistantDecisionBeforeTool,
  classifierTranscript,
  recentUserMessages,
} from "../lib/classifier-context.ts";

const view = {
  tool: "bash",
  input: { command: "rm -rf build" },
  cwd: "/repo",
  userMessages: ["Clean the build output"],
};
const chatModel = { id: "judge", provider: "fixture", api: "fixture" } as any;
const reply = (text: string, stopReason = "stop") => ({
  stopReason,
  content: [{ type: "text", text }],
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
});

test("chat replies are parsed from the first JSON object", () => {
  assert.deepEqual(parseVerdict('{"reason":"requested","verdict":"allow"}'), {
    verdict: "allow",
    reason: "requested",
  });
  assert.deepEqual(parseVerdict('Sure: {"verdict":"deny","reason":"wrong dir"} done'), {
    verdict: "deny",
    reason: "wrong dir",
  });
  assert.equal(parseVerdict('{"verdict":"maybe"}'), undefined);
  assert.equal(parseVerdict("allow"), undefined);
});

test("a chat model verdict is returned with its reason and usage", async () => {
  let prompt = "";
  const usage: unknown[] = [];
  const result = await classify(view, {
    model: chatModel,
    native: false,
    timeoutSec: 5,
    onUsage: (value) => usage.push(value),
    client: {
      complete: async (_model: unknown, context: any) => {
        prompt = context.messages[0].content;
        return reply('{"reason":"user asked to clean","verdict":"allow"}');
      },
    } as any,
  });
  assert.deepEqual(result, { verdict: "allow", reason: "user asked to clean" });
  assert.match(prompt, /User: Clean the build output/);
  assert.match(prompt, /Tool call: bash \{"command":"rm -rf build"\}/);
  assert.equal(usage.length, 1);
});

test("failures, bad replies and timeouts come back as unsure", async () => {
  const run = (complete: () => Promise<unknown>, timeoutSec = 5) =>
    classify(view, { model: chatModel, native: false, timeoutSec, client: { complete } as any });
  assert.equal((await run(async () => reply("no json"))).verdict, "unsure");
  assert.equal((await run(async () => reply("", "error"))).verdict, "unsure");
  assert.equal((await run(async () => Promise.reject(Error("offline")))).reason, "offline");
  const slow = await run(
    () => new Promise((_, reject) => setTimeout(() => reject(Error("late")), 200)),
    0.01,
  );
  assert.deepEqual(slow, { verdict: "unsure", reason: "the classifier timed out" });
});

test("native classifier models answer a choice question", async () => {
  const result = await classify(view, {
    model: { id: "native", provider: "fixture" } as any,
    native: true,
    timeoutSec: 5,
    client: {
      classify: async (_model: unknown, context: any) => {
        assert.deepEqual(Object.keys(context.questions.verdict.criteria), [
          "allow",
          "deny",
          "unsure",
        ]);
        return { stopReason: "stop", answers: { verdict: { type: "choice", choice: "deny" } } };
      },
    } as any,
  });
  assert.equal(result.verdict, "deny");
});

test("the transcript keeps the newest user messages and trims long fields", () => {
  const long = "x".repeat(20_000);
  const text = classifierTranscript({
    ...view,
    userMessages: ["first", ...Array(8).fill(long), "latest"],
    assistantDecision: { text: long, thinking: "" },
  });
  assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  assert.match(text, /^\[earlier user messages omitted\]/);
  assert.match(text, /User: latest/);
  assert.doesNotMatch(text, /User: first/);
  assert.match(text, /Agent text before the call: \[…trimmed\]x+/);
});

test("context comes from user messages and the text before the matching call", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "Run the tests" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "npm test is the script" },
          { type: "text", text: "Running tests." },
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ],
      },
    },
    { type: "custom", customType: "other", data: {} },
  ];
  assert.deepEqual(recentUserMessages(entries), ["Run the tests"]);
  assert.deepEqual(assistantDecisionBeforeTool(entries, { toolCallId: "call-1" }), {
    text: "Running tests.",
    thinking: "npm test is the script",
  });
  assert.deepEqual(
    assistantDecisionBeforeTool(entries, { toolCallId: "x", parentToolCallId: "call-1/0" }),
    { text: "Running tests.", thinking: "npm test is the script" },
  );
});

test("calls too large to show in full are left to the user", async () => {
  let called = false;
  const result = await classify(
    { ...view, tool: "write", input: { path: "/etc/hosts", content: "x".repeat(30_000) } },
    {
      model: chatModel,
      native: false,
      timeoutSec: 5,
      client: {
        complete: async () => {
          called = true;
          return reply('{"reason":"ok","verdict":"allow"}');
        },
      } as any,
    },
  );
  assert.equal(result.verdict, "unsure");
  assert.equal(called, false);
});

test("the deadline holds even when a provider ignores the abort signal", async () => {
  const late = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve(reply('{"reason":"late","verdict":"allow"}')), 100),
    );
  const timedOut = await classify(view, {
    model: chatModel,
    native: false,
    timeoutSec: 0.01,
    client: { complete: late } as any,
  });
  assert.deepEqual(timedOut, { verdict: "unsure", reason: "the classifier timed out" });
  const hung = await classify(view, {
    model: chatModel,
    native: false,
    timeoutSec: 0.01,
    client: { complete: () => new Promise(() => {}) } as any,
  });
  assert.equal(hung.verdict, "unsure");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await classify(view, {
    model: chatModel,
    native: false,
    timeoutSec: 5,
    signal: controller.signal,
    client: { complete: late } as any,
  });
  assert.deepEqual(cancelled, { verdict: "unsure", reason: "cancelled" });
});
