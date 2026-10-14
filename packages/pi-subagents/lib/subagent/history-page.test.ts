import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveDialogueReplies,
  MAX_CLOSED_HISTORY_BYTES,
  MAX_HISTORY_PAGE_REPLIES,
  MAX_HISTORY_PAGE_TEXT_BYTES,
  MAX_HISTORY_REPLY_TEXT_BYTES,
  MAX_HISTORY_TOOL_JSON_BYTES,
  pageDialogueReplies,
  pageDialogueResponse,
} from "./history-page.ts";
import type { DialogueReply } from "./rpc-dialogue.ts";

function reply(
  sequence: number,
  text: string,
  overrides: Partial<DialogueReply> = {},
): DialogueReply {
  return { sequence, requestIds: [`message-${sequence}`], text, ...overrides };
}

test("history page caps reply count and aggregate text bytes with a resumable sequence cursor", () => {
  const replies = Array.from({ length: MAX_HISTORY_PAGE_REPLIES + 2 }, (_, index) =>
    reply(index + 1, "x".repeat(7_000)),
  );
  const first = pageDialogueReplies(replies);
  assert.equal(first.replies.length, MAX_HISTORY_PAGE_REPLIES);
  assert.equal(
    first.replies.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
    28_000,
  );
  assert(Buffer.byteLength(JSON.stringify(first), "utf8") <= 32 * 1024);
  assert.equal(first.nextAfter, 4);
  assert.equal(first.hasMore, true);

  const second = pageDialogueReplies(replies, { after: first.nextAfter });
  assert.deepEqual(
    second.replies.map((item) => item.sequence),
    [5, 6],
  );
  assert.equal(second.hasMore, false);
  assert.equal(MAX_HISTORY_PAGE_TEXT_BYTES, 32 * 1024);
});

test("long replies are returned in bounded UTF-8-safe byte chunks", () => {
  const source = `${"a".repeat(MAX_HISTORY_REPLY_TEXT_BYTES - 1)}🙂tail`;
  const replies = [reply(7, source)];
  const first = pageDialogueReplies(replies);
  const firstReply = first.replies[0];
  assert.equal(Buffer.byteLength(firstReply.text), MAX_HISTORY_REPLY_TEXT_BYTES - 1);
  assert.equal(firstReply.textTruncated, true);
  assert.equal(first.nextReplySequence, 7);

  const second = pageDialogueReplies(replies, {
    replySequence: 7,
    textOffset: first.nextTextOffset,
  });
  assert.equal(second.replies[0].textOffset, first.nextTextOffset);
  assert.equal(second.replies[0].text, "🙂tail");
  assert.equal(second.replies[0].textTruncated, false);
  assert.equal(second.nextAfter, 7);
  assert.equal(second.hasMore, false);
});

test("source truncation and request-ID overflow remain explicit in bounded pages", () => {
  const value = reply(3, "retained", {
    truncated: true,
    requestIds: Array.from({ length: 12 }, (_, index) => `message-${index}`),
  });
  const page = pageDialogueReplies([value]);
  assert.equal(page.replies[0].truncated, true);
  assert.equal(page.replies[0].requestIds.length, 8);
  assert.equal(page.replies[0].requestIdsOmitted, 4);
});

test("missing sequence and invalid cursor combinations are reported", () => {
  assert.equal(
    pageDialogueReplies([reply(1, "ok")], { replySequence: 3 }).requestedReplyMissing,
    3,
  );
  assert.throws(
    () => pageDialogueReplies([], { after: 1, replySequence: 2 }),
    /cannot be combined/,
  );
  assert.throws(() => pageDialogueReplies([], { textOffset: 1 }), /requires replySequence/);
  assert.throws(() => pageDialogueReplies([], { limit: MAX_HISTORY_PAGE_REPLIES + 1 }), /limit/);
});

test("closed history retains the newest replies within its byte budget", () => {
  const archived = archiveDialogueReplies({
    replies: [reply(1, "a".repeat(MAX_CLOSED_HISTORY_BYTES)), reply(2, "newest")],
    lostReplies: 3,
    replyCursor: 2,
    retainedFrom: 1,
  });
  assert.deepEqual(
    archived.replies.map((item) => item.sequence),
    [2],
  );
  assert.equal(archived.lostReplies, 4);
  assert.equal(archived.retainedFrom, 2);
  assert.equal(archived.replyCursor, 2);
});

test("pages omit raw per-reply usage payloads and bound request correlation IDs", () => {
  const page = pageDialogueReplies([
    reply(1, "body", {
      requestIds: Array.from({ length: 20 }, (_, index) => `request-${index}`),
      usage: { arbitrary: "large raw provider data is not part of reply text" },
      usageSummary: { usage: {} as any, missing: 0 },
    }),
  ]);
  assert.equal(page.replies[0].requestIds.length, 8);
  assert.equal(page.replies[0].requestIdsOmitted, 12);
  assert(!("usage" in page.replies[0]));
  assert(!("usageSummary" in page.replies[0]));
  assert(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024);
});

test("JSON escaping cannot push a page past its serialized output limit", () => {
  const page = pageDialogueReplies([reply(1, "\u0001".repeat(MAX_HISTORY_REPLY_TEXT_BYTES))]);
  assert(Buffer.byteLength(JSON.stringify(page), "utf8") <= 32 * 1024);
  assert.equal(page.replies[0].textTruncated, true);
  assert(page.replies[0].nextTextOffset! > 0);
});

test("the complete tool response stays bounded when reply and state text need JSON escaping", () => {
  const response = pageDialogueResponse(
    [reply(1, "\u0001".repeat(20_000))],
    {},
    {
      status: "failed",
      failure: "\u0001".repeat(512),
      failureRequestIds: Array.from({ length: 8 }, () => "\u0001".repeat(64)),
    },
  );
  assert(Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_HISTORY_TOOL_JSON_BYTES);
  assert.equal(response.replies[0].textTruncated, true);
});

test("closed history archives are bounded by serialized JSON, including escaped text", () => {
  const maxJsonBytes = 8 * 1024;
  const archived = archiveDialogueReplies(
    {
      replies: [reply(1, "\u0001".repeat(8 * 1024))],
      lostReplies: 0,
      replyCursor: 1,
      retainedFrom: 1,
    },
    maxJsonBytes,
  );
  assert(Buffer.byteLength(JSON.stringify(archived), "utf8") <= maxJsonBytes);
  assert.equal(archived.replies[0].truncated, true);
});
