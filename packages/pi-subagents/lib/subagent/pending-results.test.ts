import assert from "node:assert/strict";
import test from "node:test";
import { agentEnvelope } from "./messages.ts";
import {
  MAX_PENDING_GAP_SUMMARIES,
  MAX_PENDING_RESULT_BYTES,
  MAX_PENDING_RESULTS,
  PendingResults,
} from "./pending-results.ts";

const reply = (id: string, sequence: number, text = "reply", agent = "reviewer") => ({
  id,
  agent,
  sequence,
  text,
});

test("pending parent deliveries stay count-bounded and report dropped sequences", () => {
  const pending = new PendingResults();
  for (let sequence = 1; sequence <= MAX_PENDING_RESULTS + 1; sequence++)
    pending.add(`agent:${sequence}`, reply("agent-silver-moon", sequence));

  const taken = pending.take();
  assert.equal(taken.results.length, MAX_PENDING_RESULTS);
  assert.equal(taken.results[0].sequence, 2);
  assert.equal(taken.results.at(-1)?.sequence, MAX_PENDING_RESULTS + 1);
  assert.deepEqual(taken.omitted, [
    {
      id: "agent-silver-moon",
      agent: "reviewer",
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    },
  ]);
  assert.equal(pending.hasEntries, false);
});

test("pending parent deliveries stay byte-bounded and deleting a child releases capacity", () => {
  const pending = new PendingResults();
  const halfLimit = "x".repeat(MAX_PENDING_RESULT_BYTES / 2);
  pending.add("first:1", reply("agent-first-light", 1, halfLimit));
  pending.add("second:1", reply("agent-second-light", 1, halfLimit));
  pending.add("third:1", reply("agent-third-light", 1, halfLimit));

  const taken = pending.take();
  assert.equal(taken.results.length, 2);
  assert.deepEqual(
    taken.results.map((item) => item.id),
    ["agent-second-light", "agent-third-light"],
  );
  assert.deepEqual(taken.omitted, [
    {
      id: "agent-first-light",
      agent: "reviewer",
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    },
  ]);

  pending.add("child:1", reply("agent-calm-river", 1, halfLimit));
  pending.add("child:2", reply("agent-calm-river", 2, halfLimit));
  pending.deletePrefix("child:");
  assert.equal(pending.hasEntries, false);
});

test("escaped result envelopes stay within the automatic-delivery budget", () => {
  const pending = new PendingResults((item) =>
    Buffer.byteLength(agentEnvelope("result", item.id, item.text, { sequence: item.sequence })),
  );
  const value = reply("agent-calm-river", 1, "&".repeat(MAX_PENDING_RESULT_BYTES / 4));
  assert(Buffer.byteLength(value.text) < MAX_PENDING_RESULT_BYTES);
  assert(
    Buffer.byteLength(agentEnvelope("result", value.id, value.text, { sequence: 1 })) >
      MAX_PENDING_RESULT_BYTES,
  );
  assert.deepEqual(pending.add("child:1", value), [value]);
  assert.deepEqual(pending.take().omitted, [
    {
      id: value.id,
      agent: value.agent,
      firstSequence: value.sequence,
      lastSequence: value.sequence,
      count: 1,
    },
  ]);
  assert.equal(pending.has("child:1"), false);
});

test("gap summaries are bounded and repeated child closure releases their details", () => {
  const pending = new PendingResults();
  for (
    let sequence = 1;
    sequence <= MAX_PENDING_RESULTS + MAX_PENDING_GAP_SUMMARIES + 2;
    sequence++
  )
    pending.add(`${sequence}:1`, reply(`agent-${sequence}`, 1));

  const taken = pending.take();
  assert.equal(taken.omitted.length, MAX_PENDING_GAP_SUMMARIES);
  assert.equal(taken.unlistedOmittedReplies, 2);

  for (let child = 0; child < MAX_PENDING_GAP_SUMMARIES + 3; child++) {
    const id = `agent-closed-${child}`;
    for (let sequence = 1; sequence <= MAX_PENDING_RESULTS + 1; sequence++)
      pending.add(`${id}:${sequence}`, reply(id, sequence));
    pending.deletePrefix(`${id}:`);
    pending.deleteOmitted(id);
  }
  assert.equal(pending.hasEntries, false);
});

test("aggregate gap count does not claim per-child cleanup it cannot attribute", () => {
  const pending = new PendingResults();
  for (
    let sequence = 1;
    sequence <= MAX_PENDING_RESULTS + MAX_PENDING_GAP_SUMMARIES + 2;
    sequence++
  )
    pending.add(`${sequence}:1`, reply(`agent-${sequence}`, 1));

  pending.deleteOmitted("agent-65");

  assert.equal(pending.take().unlistedOmittedReplies, 2);
});

test("taking pending replies freezes their delivery-time snapshot", () => {
  const item = reply("agent-calm-river", 1) as ReturnType<typeof reply> & {
    usageSummary: { usage: { totalTokens: number }; missing: number };
  };
  item.usageSummary = { usage: { totalTokens: 10 }, missing: 0 };
  const pending = new PendingResults<typeof item>();
  pending.add("child:1", item);

  const taken = pending.take();
  item.usageSummary.usage.totalTokens = 30;

  assert.equal(taken.results[0].usageSummary.usage.totalTokens, 10);
});

test("reports the full pending text size independently of any shorter archive", () => {
  const pending = new PendingResults();
  pending.add("child:1", reply("agent-calm-river", 1, "\\".repeat(512 * 1024)));

  assert.equal(pending.textBytes("child:1"), 512 * 1024);
  assert.equal(pending.textBytes("missing"), undefined);
});
