import type { DialogueReply } from "./rpc-dialogue.ts";

export const MAX_HISTORY_PAGE_REPLIES = 4;
export const MAX_HISTORY_PAGE_TEXT_BYTES = 32 * 1024;
export const MAX_HISTORY_PAGE_JSON_BYTES = 32 * 1024;
export const MAX_HISTORY_TOOL_JSON_BYTES = 32 * 1024;
export const MAX_HISTORY_REPLY_TEXT_BYTES = 8 * 1024;
export const MAX_CLOSED_HISTORY_BYTES = 2 * 1024 * 1024;
const CLOSED_HISTORY_METADATA_RESERVE_BYTES = 32 * 1024;

export interface HistoryPageRequest {
  after?: number;
  limit?: number;
  replySequence?: number;
  textOffset?: number;
}

export interface HistoryPage {
  replies: Array<{
    sequence: number;
    requestIds: string[];
    text: string;
    truncated?: boolean;
    model?: string;
    textBytes: number;
    textOffset: number;
    textTruncated: boolean;
    nextTextOffset?: number;
    requestIdsOmitted?: number;
    requestIdsTruncated?: boolean;
  }>;
  after: number;
  nextAfter: number;
  hasMore: boolean;
  nextReplySequence?: number;
  nextTextOffset?: number;
  requestedReplyMissing?: number;
}

interface TextChunk {
  text: string;
  start: number;
  end: number;
  total: number;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function textChunk(text: string, offset: number, maxBytes: number): TextChunk {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
    throw new Error(`textOffset must be between 0 and ${bytes.length}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("text page size must be a nonnegative integer");

  let start = offset;
  while (start < bytes.length && isContinuation(bytes[start])) start++;
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && end < bytes.length && isContinuation(bytes[end])) end--;
  return { text: bytes.subarray(start, end).toString("utf8"), start, end, total: bytes.length };
}

function boundedReply(reply: DialogueReply, offset: number, maxBytes: number) {
  const chunk = textChunk(reply.text, offset, maxBytes);
  const requestIds = reply.requestIds.slice(0, 8).map((id) => id.slice(0, 128));
  return {
    sequence: reply.sequence,
    requestIds,
    ...(reply.truncated ? { truncated: true } : {}),
    ...(typeof reply.model === "string" ? { model: reply.model.slice(0, 128) } : {}),
    ...(reply.requestIds.length > requestIds.length
      ? { requestIdsOmitted: reply.requestIds.length - requestIds.length }
      : {}),
    ...(reply.requestIds
      .slice(0, 8)
      .some((id, index) => id.length > (requestIds[index]?.length ?? 0))
      ? { requestIdsTruncated: true }
      : {}),
    text: chunk.text,
    textBytes: chunk.total,
    textOffset: chunk.start,
    textTruncated: chunk.end < chunk.total,
    ...(chunk.end < chunk.total ? { nextTextOffset: chunk.end } : {}),
  };
}

function largestJsonBoundedReply(
  reply: DialogueReply,
  offset: number,
  maxBytes: number,
  fits: (candidate: ReturnType<typeof boundedReply>) => boolean,
) {
  let low = 0;
  let high = maxBytes;
  let best: ReturnType<typeof boundedReply> | undefined;
  while (low <= high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = boundedReply(reply, offset, middle);
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Return a bounded, UTF-8-safe page of retained child replies. Offsets are byte offsets. */
export function pageDialogueReplies(
  replies: DialogueReply[],
  request: HistoryPageRequest = {},
  maxJsonBytes = MAX_HISTORY_PAGE_JSON_BYTES,
): HistoryPage {
  const after = request.after ?? 0;
  const limit = request.limit ?? MAX_HISTORY_PAGE_REPLIES;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("after must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_REPLIES)
    throw new Error(`limit must be between 1 and ${MAX_HISTORY_PAGE_REPLIES}`);
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 2_048)
    throw new Error("history page JSON budget is too small");

  if (request.replySequence !== undefined) {
    if (request.after !== undefined) throw new Error("after cannot be combined with replySequence");
    const target = request.replySequence;
    if (!Number.isSafeInteger(target) || target < 1)
      throw new Error("replySequence must be a positive integer");
    const reply = replies.find((item) => item.sequence === target);
    if (!reply)
      return {
        replies: [],
        after,
        nextAfter: after,
        hasMore: false,
        requestedReplyMissing: target,
      };
    const offset = request.textOffset ?? 0;
    const pageReply = largestJsonBoundedReply(
      reply,
      offset,
      MAX_HISTORY_REPLY_TEXT_BYTES,
      (candidate) =>
        Buffer.byteLength(JSON.stringify({ replies: [candidate] }), "utf8") <= maxJsonBytes - 2_048,
    );
    if (!pageReply) throw new Error("Reply metadata exceeds the page output limit");
    const incomplete = pageReply.textTruncated;
    return {
      replies: [pageReply],
      after,
      nextAfter: incomplete ? after : target,
      hasMore: incomplete || replies.some((item) => item.sequence > target),
      ...(incomplete
        ? { nextReplySequence: target, nextTextOffset: pageReply.nextTextOffset }
        : {}),
    };
  }
  if (request.textOffset !== undefined) throw new Error("textOffset requires replySequence");

  const candidates = replies.filter((reply) => reply.sequence > after);
  const pageReplies: HistoryPage["replies"] = [];
  let textBytesRemaining = MAX_HISTORY_PAGE_TEXT_BYTES;
  let nextAfter = after;
  let nextReplySequence: number | undefined;
  let nextTextOffset: number | undefined;

  for (const reply of candidates) {
    if (pageReplies.length >= limit || textBytesRemaining <= 0) break;
    const maxBytes = Math.min(MAX_HISTORY_REPLY_TEXT_BYTES, textBytesRemaining);
    const pageReply = largestJsonBoundedReply(
      reply,
      0,
      maxBytes,
      (candidate) =>
        Buffer.byteLength(JSON.stringify({ replies: [...pageReplies, candidate] }), "utf8") <=
        maxJsonBytes - 2_048,
    );
    if (!pageReply) break;
    // Do not return an empty partial chunk if the remaining aggregate budget is
    // smaller than the first UTF-8 code point; the next page starts with a full
    // budget and can then make progress.
    if (pageReply.text.length === 0 && pageReply.textTruncated) break;
    pageReplies.push(pageReply);
    textBytesRemaining -= Buffer.byteLength(pageReply.text, "utf8");
    if (pageReply.textTruncated) {
      nextReplySequence = reply.sequence;
      nextTextOffset = pageReply.nextTextOffset;
      break;
    }
    nextAfter = reply.sequence;
  }

  return {
    replies: pageReplies,
    after,
    nextAfter,
    hasMore:
      nextReplySequence !== undefined || candidates.some((reply) => reply.sequence > nextAfter),
    ...(nextReplySequence === undefined ? {} : { nextReplySequence, nextTextOffset }),
  };
}

/** Page replies while enforcing a byte limit on the complete tool response. */
export function pageDialogueResponse<T extends Record<string, unknown>>(
  replies: DialogueReply[],
  request: HistoryPageRequest,
  state: T,
  maxJsonBytes = MAX_HISTORY_TOOL_JSON_BYTES,
): T & HistoryPage {
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0)
    throw new Error("history response JSON budget must be a positive integer");

  let pageBudget = MAX_HISTORY_PAGE_JSON_BYTES;
  for (let attempt = 0; attempt < 32; attempt++) {
    if (pageBudget <= 2_048) break;
    const page = pageDialogueReplies(replies, request, pageBudget);
    const response = { ...state, ...page } as T & HistoryPage;
    const size = Buffer.byteLength(JSON.stringify(response), "utf8");
    if (size <= maxJsonBytes) return response;
    // Reserve for page cursors whose decimal width changes as the page shrinks.
    pageBudget -= size - maxJsonBytes + 256;
  }
  throw new Error("Subagent state exceeds the serialized history response limit");
}

/** Keep only the newest retained replies in a small, process-local archive after close. */
export function archiveDialogueReplies<
  T extends {
    replies: DialogueReply[];
    lostReplies: number;
    replyCursor: number;
    retainedFrom: number;
  },
>(snapshot: T, maxJsonBytes = MAX_CLOSED_HISTORY_BYTES - CLOSED_HISTORY_METADATA_RESERVE_BYTES): T {
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0)
    throw new Error("closed history JSON budget must be a positive integer");

  let omittedReplies = 0;
  const kept: DialogueReply[] = [];
  const archiveSnapshot = (replies: DialogueReply[], omitted: number) => ({
    ...snapshot,
    replies,
    lostReplies: snapshot.lostReplies + omitted,
    retainedFrom: replies[0]?.sequence ?? snapshot.replyCursor + 1,
  });
  const fits = (replies: DialogueReply[], omitted: number) =>
    Buffer.byteLength(JSON.stringify(archiveSnapshot(replies, omitted)), "utf8") <= maxJsonBytes;

  for (let index = snapshot.replies.length - 1; index >= 0; index--) {
    const reply = snapshot.replies[index];
    if (!reply) continue;
    const archivedReply: DialogueReply = {
      sequence: reply.sequence,
      requestIds: reply.requestIds.slice(0, 8).map((id) => id.slice(0, 128)),
      text: reply.text,
      ...(reply.truncated ? { truncated: true } : {}),
      ...(typeof reply.model === "string" ? { model: reply.model.slice(0, 128) } : {}),
    };
    const candidate = [archivedReply, ...kept];
    if (fits(candidate, omittedReplies)) {
      kept.unshift(archivedReply);
      continue;
    }
    let retainedPartial = false;
    if (kept.length === 0) {
      const sourceBytes = Buffer.byteLength(reply.text, "utf8");
      let low = 0;
      let high = sourceBytes;
      let best: DialogueReply | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const chunk = textChunk(reply.text, 0, middle);
        const clipped: DialogueReply = { ...archivedReply, text: chunk.text, truncated: true };
        if (fits([clipped], omittedReplies)) {
          best = clipped;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (best) {
        kept.unshift(best);
        retainedPartial = true;
      }
    }
    omittedReplies += retainedPartial ? index : index + 1;
    break;
  }
  return archiveSnapshot(kept, omittedReplies) as T;
}
