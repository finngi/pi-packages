import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_GOAL_CRITERIA, MAX_GOAL_TEXT_FIELD_CHARS } from "./limits.ts";
import { reduceGoal } from "./goal.ts";
import { ENTRY, loadGoal, readGoalBranch, WAITER_STATE_ENTRY } from "./persistence.ts";

const goal = () =>
  reduceGoal(undefined, { type: "create", id: "goal-saved", objective: "Exact saved scope" })!;
const record = (customType: string, data: unknown) => ({ type: "custom", customType, data });
const read = (branch: any[]) =>
  readGoalBranch({ sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext);

test("current fixed criteria, budget and accounting survive pause/resume replay", () => {
  const saved = goal();
  const paused = reduceGoal(saved, { type: "pause" })!;
  const resumed = reduceGoal(paused, { type: "resume" })!;
  const current = read([
    record(ENTRY, { state: saved }),
    record(WAITER_STATE_ENTRY, { version: 1, disarmed: true }),
    record(ENTRY, { state: resumed }),
    record(WAITER_STATE_ENTRY, { version: 1, disarmed: false }),
  ]);
  assert.equal(current.goal?.status, "active");
  assert.equal(current.goal?.revision, 1);
  assert.deepEqual(current.goal?.criteria, saved.criteria);
  assert.deepEqual(current.goal?.usage, saved.usage);
  assert.equal(current.disarmed, false);
});

test("automatic stop reason survives branch replay and explicit resume clears it", () => {
  const branch = [
    record(ENTRY, { state: goal() }),
    record(WAITER_STATE_ENTRY, {
      version: 1,
      disarmed: true,
      stopReason: "evaluator error: model unavailable",
    }),
  ];
  assert.equal(read(branch).stopReason, "evaluator error: model unavailable");
  branch.push(record(WAITER_STATE_ENTRY, { version: 1, disarmed: false }));
  assert.equal(read(branch).stopReason, undefined);
  assert.equal(read(branch).disarmed, false);
  assert.throws(
    () =>
      read([
        record(WAITER_STATE_ENTRY, { version: 1, disarmed: true, stopReason: "invalid\nreason" }),
      ]),
    /malformed goal waiter state/,
  );
});

test("unrelated records neither import a goal nor overwrite current state or disarm controls", () => {
  const unrelated = [
    record("other-extension.state", { state: goal() }),
    record("other-extension.waiter-state.v1", { version: 1, disarmed: true }),
  ];
  assert.deepEqual(read(unrelated), { goal: undefined, disarmed: false });
  const current = read([
    record(ENTRY, { state: goal() }),
    record(WAITER_STATE_ENTRY, { version: 1, disarmed: false }),
    ...unrelated,
  ]);
  assert.equal(current.goal?.objective, "Exact saved scope");
  assert.equal(current.disarmed, false);
});

test("current clear is authoritative and unrelated records cannot resurrect a goal", () => {
  assert.equal(
    read([
      record(ENTRY, { state: goal() }),
      record(ENTRY, { state: null }),
      record("other-extension.state", { state: goal() }),
    ]).goal,
    undefined,
  );
});

test("changing current state retains its disarm control until explicitly rearmed", () => {
  const saved = goal();
  const branch = [
    record(ENTRY, { state: saved }),
    record(WAITER_STATE_ENTRY, { version: 1, disarmed: true }),
    record(ENTRY, { state: { ...saved, revision: 1 } }),
  ];
  assert.equal(read(branch).disarmed, true);
  branch.push(
    record(WAITER_STATE_ENTRY, { version: 1, disarmed: false }),
    record(ENTRY, { state: { ...saved, revision: 2 } }),
  );
  assert.equal(read(branch).disarmed, false);
  assert.equal(read(branch).goal?.revision, 2);
});

test("malformed current state or controls fail closed rather than silently arm", () => {
  for (const data of [{ version: 1, disarmed: "false" }, { version: 0, disarmed: false }, null])
    assert.throws(() => read([record(WAITER_STATE_ENTRY, data)]), /malformed goal waiter state/);
  for (const state of [
    { ...goal(), version: 999 },
    { ...goal(), criteria: [] },
    { ...goal(), objective: "x".repeat(MAX_GOAL_TEXT_FIELD_CHARS + 1) },
    {
      ...goal(),
      criteria: Array.from({ length: MAX_GOAL_CRITERIA + 1 }, (_unused, index) => ({
        id: `task-${index}`,
        requirement: `Requirement ${index}`,
      })),
    },
    { ...goal(), status: "invented" },
    { ...goal(), usage: { input: -1 } },
  ])
    assert.throws(() => loadGoal(state), /malformed or unsupported goal state/);
  assert.throws(
    () => loadGoal({ ...goal(), status: "expired" }),
    /malformed or unsupported goal state/,
    "expired state must retain the timestamp that caused expiry",
  );
});

test("an explicit cleared-state tombstone recovers earlier malformed goal state only", () => {
  const malformed = record(ENTRY, { state: { ...goal(), version: 999 } });
  assert.deepEqual(read([malformed, record(ENTRY, { state: null })]), {
    goal: undefined,
    disarmed: false,
  });
  assert.throws(
    () => read([malformed, record(ENTRY, { state: null }), malformed]),
    /malformed or unsupported goal state/,
    "a later corrupt entry remains fail-closed",
  );
});

test("only a valid rearmed waiter record resets an earlier malformed waiter state", () => {
  const malformed = record(WAITER_STATE_ENTRY, { version: 1, disarmed: "false" });
  assert.deepEqual(read([malformed, record(WAITER_STATE_ENTRY, { version: 1, disarmed: false })]), {
    goal: undefined,
    disarmed: false,
  });
  assert.throws(
    () => read([malformed, record(WAITER_STATE_ENTRY, { version: 1, disarmed: true })]),
    /malformed goal waiter state/,
    "a disarmed record does not silently repair corrupt control state",
  );
});

test("current state entry requires its own explicit state envelope", () => {
  for (const data of [undefined, null, {}, goal(), { state: undefined }])
    assert.throws(() => read([record(ENTRY, data)]), /malformed/);
  assert.equal(read([record(ENTRY, { state: null })]).goal, undefined);
});
