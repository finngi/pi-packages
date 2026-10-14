import assert from "node:assert/strict";
import test from "node:test";
import { deadlineRemaining, deadlineSummary, resolveGoalDeadline } from "./deadline.ts";

test("resolves bounded relative durations once from the supplied clock", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(resolveGoalDeadline("30m", now), now + 30 * 60_000);
  assert.equal(resolveGoalDeadline("2h", now), now + 2 * 3_600_000);
  assert.equal(resolveGoalDeadline("1d", now), now + 86_400_000);
  assert.equal(deadlineRemaining(now + 61_000, now), "2m");
  assert.equal(deadlineRemaining(now + 3_600_000, now), "1h");
  assert.equal(deadlineRemaining(now + 86_400_000, now), "1d");
  assert.equal(deadlineRemaining(now, now), "expired");
  assert.match(deadlineSummary(now, now), /; Remaining: expired\.$/);
  assert.doesNotMatch(deadlineSummary(now, now), /expired remaining/);
  assert.equal(resolveGoalDeadline("3650d", now), now + 3650 * 86_400_000);
  assert.throws(() => resolveGoalDeadline("3651d", now), /3650 days/);
});

test("accepts strict RFC 3339 times and applies their timezone offset", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(
    resolveGoalDeadline("2026-10-10T14:00:00+01:00", now),
    Date.parse("2026-10-10T13:00:00Z"),
  );
  assert.equal(
    resolveGoalDeadline("2026-10-10T13:00:00.250Z", now),
    Date.parse("2026-10-10T13:00:00.250Z"),
  );
  assert.equal(
    resolveGoalDeadline("2026-10-10T13:00:00.2509Z", now),
    Date.parse("2026-10-10T13:00:00.250Z"),
    "sub-millisecond precision is truncated to the stored millisecond clock",
  );
});

test("calendar parsing handles four-digit years below 0100", () => {
  const nowDate = new Date(0);
  nowDate.setUTCFullYear(98, 0, 1);
  const deadlineDate = new Date(0);
  deadlineDate.setUTCFullYear(99, 0, 1);
  assert.equal(
    resolveGoalDeadline("0099-01-01T00:00:00Z", nowDate.getTime()),
    deadlineDate.getTime(),
  );
});

test("rejects malformed, past, and excessively long deadlines", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  for (const value of [
    "0m",
    "-1h",
    "tomorrow",
    "1.5h",
    "2026-02-30T12:00:00Z",
    "2026-10-10T13:00:00",
    "2026-10-10T13:00:00+15:00",
    "3651d",
  ])
    assert.throws(() => resolveGoalDeadline(value, now));
  assert.throws(() => resolveGoalDeadline("2026-10-10T11:59:59Z", now), /future/);
});
