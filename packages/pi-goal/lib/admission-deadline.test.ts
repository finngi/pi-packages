import assert from "node:assert/strict";
import test from "node:test";
import { admissionReason } from "./continuation.ts";
import { reduceGoal } from "./goal.ts";
import { GoalRequests } from "./usage.ts";

test("provider admission rejects a deadline that elapsed before the expiry timer runs", () => {
  const now = Date.now();
  const goal = reduceGoal(undefined, {
    type: "create",
    id: "goal-deadline",
    objective: "bounded work",
    deadlineAt: now - 1,
    now: now - 2,
  })!;
  assert.equal(
    admissionReason(
      { goal, sessionId: "session", branchToken: "branch", disarmed: false },
      {
        requestId: "request",
        sessionId: "session",
        branchToken: "branch",
        goal: { id: goal.id, revision: goal.revision },
        dispatched: false,
      },
    ),
    "goal deadline expired",
  );
});

test("an already-running goal turn can finish after expiry, but a later run has no goal authority", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  const deadlineAt = now + 60_000;
  let goal = reduceGoal(undefined, {
    type: "create",
    id: "goal-deadline",
    objective: "finish this turn",
    deadlineAt,
    now,
  })!;
  const requests = new GoalRequests();
  requests.startRun();
  requests.prepare(goal, "session", "branch");
  goal = reduceGoal(goal, { type: "expire", now: deadlineAt })!;
  const toolResult = { role: "toolResult", content: [] };
  const nextRequest = requests.prepare(goal, "session", "branch");
  const messages = requests.bind([toolResult], nextRequest);
  const sameRunAuthority = requests.find(messages, "session");
  assert.equal(sameRunAuthority, nextRequest);
  assert.equal(
    admissionReason(
      { goal, sessionId: "session", branchToken: "branch", disarmed: true },
      sameRunAuthority,
      deadlineAt,
    ),
    undefined,
    "expiry does not interrupt a run that was already authorized before the deadline",
  );

  requests.startRun();
  assert.equal(requests.prepare(goal, "session", "branch").goal, undefined);
});
