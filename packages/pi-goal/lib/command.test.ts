import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalCommand } from "./command.ts";

test("goal commands preserve objective text after an optional deadline", () => {
  assert.deepEqual(parseGoalCommand("start --for 45m build the parser"), {
    kind: "start",
    objective: "build the parser",
    deadline: "45m",
  });
  assert.deepEqual(parseGoalCommand("edit --no-deadline update the plan"), {
    kind: "edit",
    objective: "update the plan",
    clearDeadline: true,
  });
  assert.deepEqual(parseGoalCommand("resume --for 2026-10-11T15:00:00+01:00"), {
    kind: "resume",
    deadline: "2026-10-11T15:00:00+01:00",
  });
  assert.deepEqual(parseGoalCommand("resume --no-deadline"), {
    kind: "resume",
    clearDeadline: true,
  });
});

test("deadline options do not reinterpret plain shorthand objectives", () => {
  assert.deepEqual(parseGoalCommand("start a task with --for in its documentation"), {
    kind: "start",
    objective: "a task with --for in its documentation",
  });
});

test("deadline options require a value and resume rejects other arguments", () => {
  assert.throws(() => parseGoalCommand("start --for"), /Use --for/);
  assert.throws(
    () => parseGoalCommand("resume later"),
    /no arguments except --for or --no-deadline/,
  );
  assert.throws(() => parseGoalCommand("edit --for 30m --no-deadline update"), /only one deadline/);
  assert.throws(
    () => parseGoalCommand("resume --for 30m --for 1h"),
    /no arguments except --for or --no-deadline/,
  );
});
