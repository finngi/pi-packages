import test from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, emptyUsage, readUsage } from "../src/usage.ts";

test("all calls, cache tokens and known failed-call usage count once independently of replies", () => {
  const ledger = new UsageLedger(),
    usage = { ...emptyUsage(), input: 10, output: 3, cacheRead: 20, totalTokens: 33 };
  usage.cost.total = 0.25;
  const record = {
    id: "call-1",
    kind: "child" as const,
    source: "child-1",
    label: "General Purpose",
    usage,
  };
  assert(ledger.record(record));
  assert(!ledger.record(record));
  ledger.record({ ...record, id: "call-2", incomplete: true });
  assert.equal(ledger.total().usage.totalTokens, 66);
  assert.equal(ledger.total().usage.cost.total, 0.5);
  assert.equal(ledger.total().missing, 1);
  const pending = ledger.pending();
  assert.equal(pending.ids.length, 2);
  for (const id of pending.ids) ledger.forwarded.add(id);
  assert.equal(ledger.pending().ids.length, 0);
});
test("missing or malformed usage remains unknown and replayed records retain deduplication", () => {
  const ledger = new UsageLedger();
  ledger.record({ id: "missing", kind: "classifier", source: "permission", label: "Classifier" });
  assert.equal(ledger.total().missing, 1);
  assert.equal(ledger.pending().ids.length, 0);
  assert.equal(readUsage({ input: -1 }), undefined);
  const resumed = new UsageLedger();
  for (const record of ledger.records.values()) resumed.record(record);
  assert(
    !resumed.record({
      id: "missing",
      kind: "classifier",
      source: "permission",
      label: "Classifier",
    }),
  );
  assert.equal(resumed.total().missing, 1);
  const usage = emptyUsage();
  usage.totalTokens = 4;
  usage.output = 4;
  assert(
    resumed.record({
      id: "missing",
      kind: "classifier",
      source: "permission",
      label: "Classifier",
      usage,
    }),
  );
  assert.equal(resumed.total().missing, 0);
  assert.equal(resumed.total().usage.totalTokens, 4);
});
