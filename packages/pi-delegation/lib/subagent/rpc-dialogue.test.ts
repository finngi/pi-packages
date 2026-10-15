import assert from "node:assert/strict";
import test from "node:test";
import { RpcDialogue } from "./rpc-dialogue.ts";
import type { BackgroundService } from "../background/service.ts";
import type { Snapshot } from "../background/types.ts";

function setup() {
  let dialogue!: RpcDialogue;
  const writes: string[] = [];
  const service = {
    async write(id: string, bytes: Uint8Array) {
      assert.equal(id, "run");
      const line = Buffer.from(bytes).toString();
      writes.push(line);
      const request = JSON.parse(line);
      queueMicrotask(() =>
        dialogue.data(
          "stdout",
          Buffer.from(
            JSON.stringify({
              type: "response",
              id: request.id,
              command: request.type,
              success: true,
              data: { disposition: "queued" },
            }) + "\r\n",
          ),
        ),
      );
    },
  } as unknown as BackgroundService;
  dialogue = new RpcDialogue(service, "run");
  return { dialogue, writes };
}

test("correlates acknowledgements separately from completed numbered replies", async () => {
  const { dialogue, writes } = setup();
  const ack = await dialogue.message("text with U+2028 \u2028 and @file", "followUp");
  assert.equal(ack.disposition, "queued");
  assert.match(writes[0], /"version":1,"type":"followUp"/);
  assert.equal(dialogue.snapshot().replies.length, 0);
  dialogue.data(
    "stdout",
    Buffer.from(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "answer 🐈" }] },
      }) + "\n",
    ),
  );
  dialogue.data("stdout", Buffer.from('{"type":"agent_end"}\n'));
  assert.equal(dialogue.snapshot().status, "busy");
  dialogue.data("stdout", Buffer.from('{"type":"agent_settled","aborted":false}\n'));
  assert.deepEqual(dialogue.snapshot().replies, [
    { sequence: 1, requestIds: [ack.requestId], text: "answer 🐈" },
  ]);
  assert.equal(dialogue.snapshot().status, "idle");
});

test("identifiable response waiter resolves only a completed correlated assistant turn", async () => {
  const { dialogue } = setup();
  const ack = await dialogue.message("request exact result", "followUp");
  const waiting = dialogue.waitForRequest(ack.requestId);
  assert.throws(() => dialogue.waitForRequest(ack.requestId), /already exists/);
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "correlated result" }],
  };
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "turn_end", message })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  assert.equal((await waiting).text, "correlated result");
  assert.deepEqual(dialogue.snapshot().replies[0].requestIds, [ack.requestId]);
  assert.equal(dialogue.snapshot().replies.length, 1);
});

test("provider failure rejects the exact pending response waiter without a reply", async () => {
  const { dialogue } = setup();
  const ack = await dialogue.message("request that fails", "followUp");
  const waiting = dialogue.waitForRequest(ack.requestId);
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "fixture provider failed", content: [{ type: "text", text: "not an answer" }] } })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  await assert.rejects(waiting, /fixture provider failed/);
  assert.equal(dialogue.snapshot().replies.length, 0);
});

test("a response stopped at the model output limit is incomplete, never a reply", async () => {
  const { dialogue } = setup();
  const started = await dialogue.start("request a complete result");
  const waiting = dialogue.waitForRequest(started.requestId);
  const message = {
    role: "assistant",
    stopReason: "length",
    content: [{ type: "text", text: "partial answer" }],
  };
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "turn_end", message })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  await assert.rejects(waiting, /output limit/);
  assert.equal(dialogue.snapshot().status, "failed");
  assert.equal(dialogue.snapshot().replies.length, 0);
  assert.equal(dialogue.snapshot().retryable, true);
});

test("an empty settled turn is a retryable failure, never a synthetic answer", async () => {
  const { dialogue } = setup();
  const started = await dialogue.start("exact initial task");
  const waiting = dialogue.waitForRequest(started.requestId);
  dialogue.data("stdout", Buffer.from('{"type":"agent_settled","aborted":false}\n'));
  await assert.rejects(waiting, /without a text answer/);
  assert.equal(dialogue.snapshot().status, "failed");
  assert.equal(dialogue.snapshot().replies.length, 0);
  assert.equal(dialogue.snapshot().retryable, true);
});

test("an aborted Pi 1.1 settlement rejects its request and discards any partial answer", async () => {
  const { dialogue } = setup();
  const started = await dialogue.start("request that is cancelled");
  const waiting = dialogue.waitForRequest(started.requestId);
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } })}\n{"type":"agent_settled","aborted":true}\n`,
    ),
  );
  await assert.rejects(waiting, /Assistant run aborted/);
  assert.equal(dialogue.snapshot().status, "failed");
  assert.equal(dialogue.snapshot().replies.length, 0);
  assert.equal(dialogue.snapshot().retryable, true);
});

test("an aborted later run keeps replies completed before cancellation", async () => {
  const { dialogue } = setup();
  const started = await dialogue.start("request already answered");
  const waiting = dialogue.waitForRequest(started.requestId);
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "completed before abort" }],
  };
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "turn_end", message })}\n{"type":"agent_settled","aborted":true}\n`,
    ),
  );
  assert.equal((await waiting).text, "completed before abort");
  assert.equal(dialogue.snapshot().replies.length, 1);
});

test("retains a bounded history and rejects malformed or oversized JSONL", async () => {
  const { dialogue } = setup();
  const reply = (i: number) =>
    dialogue.data(
      "stdout",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(i) }] } })}\n{"type":"agent_settled","aborted":false}\n`,
      ),
    );
  await dialogue.start("request 0");
  for (let i = 0; i < 130; i++) {
    if (i > 0) await dialogue.message(`request ${i}`, "followUp");
    reply(i);
  }
  assert.equal(dialogue.snapshot().replies.length, 128);
  assert.equal(dialogue.snapshot().replies[0].sequence, 3);
  assert.equal(dialogue.snapshot().lostReplies, 2);
  dialogue.data("stdout", Buffer.from("x".repeat(4 * 1024 * 1024 + 1)));
  assert.equal(dialogue.snapshot().status, "failed");
});

test("message input stays exact JSON string data and close is terminal", async () => {
  const { dialogue, writes } = setup();
  const body = "/slash @path\u2028𝄞";
  await dialogue.message(body, "steer");
  assert.equal(JSON.parse(writes[0]).text, body);
  dialogue.close();
  await assert.rejects(() => dialogue.message("later", "followUp"), /closed/);
});

test("versioned bridge ingress sends command-like text without a prefix or wrapper", async () => {
  const body =
    "/fixture-command arg\n/skill:fixture\n/template $@\n@/tmp/private.txt\n--permissions dangerously-unrestricted\n🐈\u2028x\u2029y";
  const { dialogue, writes } = setup();
  await dialogue.message(body, "followUp");
  assert.equal(JSON.parse(writes[0]).text, body);
});

test("provider errors stay failed without a reply and allow an explicit same-process retry", async () => {
  const { dialogue } = setup();
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "fixture provider failed", content: [{ type: "text", text: "not an answer" }] } })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  assert.equal(dialogue.snapshot().status, "failed");
  assert.equal(dialogue.snapshot().retryable, true);
  assert.equal(dialogue.snapshot().replies.length, 0);
  assert.match(dialogue.snapshot().failure ?? "", /fixture provider failed/);
  const retry = await dialogue.message("retry explicitly", "followUp");
  assert.equal(retry.disposition, "queued");
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  assert.equal(dialogue.snapshot().status, "idle");
  assert.equal(dialogue.snapshot().replies[0].text, "recovered");
  assert.deepEqual(dialogue.snapshot().replies[0].requestIds, [retry.requestId]);
});

test("null, array, malformed, and partial protocol records fail closed", () => {
  for (const [wire, partial] of [
    ["null\n", false],
    ["[]\n", false],
    ["{bad}\n", false],
    ['{"type":"agent_settled"}\n', false],
    ['{"type":"agent_settled"', true],
  ] as const) {
    const { dialogue } = setup();
    dialogue.data("stdout", Buffer.from(wire));
    if (partial)
      dialogue.complete({
        id: "run",
        owner: "subagent",
        label: "fixture",
        mode: "",
        status: "failed",
        exitCode: 1,
        signal: null,
        outputBytes: 1,
        retainedFrom: 0,
        executionExited: true,
        streamsClosed: true,
      });
    assert.equal(dialogue.snapshot().status, "failed");
    assert.equal(dialogue.snapshot().replies.length, 0);
  }
});

test("large answers carry explicit truncation and cursor loss metadata", async () => {
  const { dialogue } = setup();
  const text = "x".repeat(2 * 1024 * 1024 + 100);
  await dialogue.start("large answer");
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  const result = dialogue.snapshot();
  assert.equal(result.replies[0].truncated, true);
  assert.equal(Buffer.byteLength(result.replies[0].text), 2 * 1024 * 1024);
  assert.equal(result.retainedFrom, 1);
});

test("aggregate reply retention evicts whole oldest replies and advances the cursor", async () => {
  const { dialogue } = setup();
  const text = "y".repeat(2 * 1024 * 1024);
  await dialogue.start("reply 1");
  for (let i = 0; i < 17; i++) {
    if (i > 0) await dialogue.message(`reply ${i + 1}`, "followUp");
    dialogue.data(
      "stdout",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n{"type":"agent_settled","aborted":false}\n`,
      ),
    );
  }
  const result = dialogue.snapshot();
  assert.equal(result.replies.length, 16);
  assert.equal(result.lostReplies, 1);
  assert.equal(result.retainedFrom, 2);
  assert.equal(result.replyCursor, 17);
});

test("settlement reconciliation refreshes pending reply and current usage summaries", async () => {
  let dialogue!: RpcDialogue;
  const replies: any[] = [];
  const service = {
    async write(id: string, bytes: Uint8Array) {
      assert.equal(id, "run");
      const request = JSON.parse(Buffer.from(bytes).toString());
      const data =
        request.type === "get_session_stats"
          ? {
              sessionId: "child-session",
              tokens: { input: 12, output: 3, cacheRead: 4, cacheWrite: 1, total: 20 },
              cost: 0.25,
            }
          : { disposition: "queued" };
      queueMicrotask(() =>
        dialogue.data(
          "stdout",
          Buffer.from(
            JSON.stringify({ type: "response", id: request.id, success: true, data }) + "\n",
          ),
        ),
      );
    },
  } as unknown as BackgroundService;
  dialogue = new RpcDialogue(
    service,
    "run",
    (reply) => replies.push(reply),
    undefined,
    () => true,
    true,
    () => {},
  );
  await dialogue.start("task");
  dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(replies[0].usageSummary.usage.input, 12);
  assert.equal(replies[0].usageSummary.usage.cacheRead, 4);
  assert.equal(replies[0].usageSummary.usage.cost.total, 0.25);
  assert.deepEqual(dialogue.snapshot().usageSummary, replies[0].usageSummary);
});

test("later per-message usage refreshes earlier replies and missing counts", async () => {
  let dialogue!: RpcDialogue;
  const service = {
    async write(id: string, bytes: Uint8Array) {
      const request = JSON.parse(Buffer.from(bytes).toString());
      queueMicrotask(() =>
        dialogue.data(
          "stdout",
          Buffer.from(JSON.stringify({ type: "response", id: request.id, success: true }) + "\n"),
        ),
      );
    },
  } as unknown as BackgroundService;
  dialogue = new RpcDialogue(
    service,
    "run",
    undefined,
    undefined,
    () => true,
    false,
    () => {},
  );
  const usage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const finish = (text: string, currentUsage?: ReturnType<typeof usage>) => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      ...(currentUsage ? { usage: currentUsage } : {}),
    };
    dialogue.data(
      "stdout",
      Buffer.from(
        `${JSON.stringify({ type: "message_end", message })}\n{"type":"agent_settled","aborted":false}\n`,
      ),
    );
  };

  await dialogue.start("first");
  finish("first", usage(4, 6));
  await dialogue.message("second", "followUp");
  finish("second", usage(10, 10));
  await dialogue.message("third", "followUp");
  finish("third");

  const replies = dialogue.snapshot().replies;
  assert.equal(replies.length, 3);
  assert.equal(replies[0].usageSummary?.usage.totalTokens, 30);
  assert.equal(replies[1].usageSummary?.usage.totalTokens, 30);
  assert.equal(replies[0].usageSummary?.missing, 1);
  assert.equal(replies[1].usageSummary?.missing, 1);
  assert.equal(replies[2].usageSummary?.missing, 1);
});

test("source request observations exclude queued follow-ups and disappear after settle/close", async () => {
  const { dialogue } = setup();
  const first = await dialogue.start("work");
  const steer = await dialogue.message("correction", "steer");
  await dialogue.message("next assignment", "followUp");
  assert.deepEqual(dialogue.activeRequestIds(), [first.requestId, steer.requestId]);
  dialogue.data(
    "stdout",
    Buffer.from(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }) + '\n{"type":"agent_settled","aborted":false}\n',
    ),
  );
  assert.deepEqual(dialogue.activeRequestIds(), []);
  dialogue.close();
  assert.deepEqual(dialogue.activeRequestIds(), []);
});
