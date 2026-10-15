# pi-goal

Keeps Pi working toward an objective until its criteria are met. The working model does the task.
When it stops, a separate evaluator model checks the evidence and returns `finished`, `incomplete`
or `blocked`. The extension then completes the goal, carries on, or stops after the same blocker
three times in a row.

It works on stock Pi without delegation, background jobs or permissions. State is saved in session
entries and continuation uses Pi's settle hook. The job, child-answer and permission integrations do
nothing unless those extensions are loaded. Shared accounting records evaluator usage without
loading any other extension.

## Use it

```text
/goal Build a CSV parser that passes the tests and has a usage README.
```

This sends the objective as your message and work starts at once; edits and resume do the same.

- `/goal` shows status.
- `/goal edit`, `/goal pause` and `/goal resume` control the goal.
- `/goal clear` drops the goal and its waits; children, files, history and costs stay.
- `/goal start --for 2h <objective>` or `--for 2026-10-11T15:00:00+01:00` sets a deadline.
  `/goal edit` can change it, `/goal resume --for 30m` extends an expired goal, and `--no-deadline`
  removes it. Pausing does not stop the clock. On expiry no new goal turns start; a running turn
  may finish and children or jobs keep going.

The working model can ask for a goal with `create_goal`, read it with `get_goal` and wait for a
child's answer with `wait_for_goal_event`. Only the evaluator decides when the goal is done, so
there is no `update_goal` tool. A steering message or `/background` ends a wait but keeps its
`wait_id`, so it can wait again later. The child keeps working and its answer is delivered once.

## Evaluator

There is no default evaluator. Choose one from Pi's registry with
`--goal-evaluator-model provider/model`, and set the timeout with `--goal-evaluator-timeout 30`
(seconds, at most 2,147,483.647, the longest timer Node.js allows). To set them once, use
`goal.evaluator.model` and `goal.evaluator.timeoutSec` in Pi's settings; the flags win when both
are given.

The evaluator's reply is validated. Strict output is requested when the provider supports it. A
malformed reply gets one retry within the same timeout. Missing login, a second bad reply or a
timeout stop automatic work with a visible error. You can still send messages. `/goal resume`
turns automatic work back on without starting a duplicate turn. Errors and bad replies are kept in
the session for inspection.

Goal state and evaluator history are saved with the session branch. Each evaluation keeps the goal
and recent evidence within a token limit; anything left out is noted and cannot prove completion.
Child and evaluator usage do not count toward the goal's budget. `/costs` shows evaluator usage
straight away; see [accounting](../../docs/accounting.md) for adding it to the footer without
counting it twice.

## Footer

The footer shows the saved `Goal` status separately from automatic work: `Auto: running`,
`waiting` or `stopped`, with a short reason. A goal can be active while automatic work is stopped.
Stop reasons survive reopening the session and clear on resume, edit or a new goal. `Deadline`
shows the due time and `Remaining` the time left. Paused, blocked, completed, expired and
over-budget goals say why they stopped.

## More

- [Goal guide](../../docs/guides/goals.md): commands and workflow.
- [Goal reference](../../docs/reference/goals.md): evaluator history, approval, budgets, saved
  state and waits.
- [Tools](../../docs/reference/tools.md#goal-tools) and
  [events](../../docs/reference/events.md#goal-services).

## Tests

```sh
npm run test --workspace=pi-goal
npm run typecheck --workspace=pi-goal
npm run test:standalone --workspace=pi-goal
```

The standalone test runs this extension alone on stock Pi with scripted worker and evaluator
replies. It covers continuation, bad assessments, cancellation, steering, usage records and
reopening a real session file. It calls no paid provider and touches no installed sessions, so it
tests the integration, not how well a model judges. Entrypoint: [goal.ts](extensions/goal.ts). See
[testing](../../docs/testing.md).
