# Goal reference

This page covers how goals are approved, assessed, budgeted, saved and waited on. For everyday
use, see the [goal guide](../guides/goals.md). Tool parameters are in
[goal tools](tools.md#goal-tools).

Terms used here:

- **Host**: Pi's user interface, or code that embeds Pi.
- **Goal scope**: the goal ID, its revision, and the selected branch of Pi's conversation tree.
  Editing or resuming creates a new revision. Approvals and provider requests also belong to one
  session.

## Approval

| Who | How | What approves the goal |
| --- | --- | --- |
| You | Type `/goal <objective>` | The exact text you typed. It starts a new goal or edits the unfinished one, and becomes its single criterion |
| The working model | `create_goal({objective, criteria?, budget?, deadline?})` | You confirm the exact objective, criteria, budget and deadline, or embedding code has approved them in advance. A scope change before the goal is saved cancels the approval |
| Embedding code | Emit `goal:create_authorization` | A one-use approval for the exact objective and optional criteria, budget and deadline |

`pi-goal` handles goal approval itself. If the permission package is loaded, its check is an extra
step and does not replace this one. See the [approval tests](../../packages/pi-goal/lib/authorization.test.ts).

The lower-case first words `start`, `edit`, `pause`, `resume`, `clear` and `status` are commands.
Any other first word begins an objective. `/goal start` and `/goal edit` take the command and one
separator and keep the rest as the objective. The other commands reject extra text. See the
[command parser](../../packages/pi-goal/lib/command.ts).

`/goal clear` saves `{state: null}`, cancels approvals and pending waits, and aborts the current
goal run and evaluator. It adds a note to the conversation without starting a turn. It does not
cancel background jobs or children, or remove files, conversation or usage records.

## Deadlines

`/goal start` and `/goal edit` accept `--for <duration-or-timestamp>` before the objective.
`/goal resume --for …` gives an expired goal a new deadline. Durations such as `30m`, `2h` or `1d`
become a fixed time when the command runs. Timestamps need a timezone. Deadlines can be at most
3,650 days away. `--no-deadline` removes the deadline on edit or resume. Pausing does not stop the
clock.

On expiry the goal's status becomes `expired`. An active goal wait is cancelled, a running
evaluation is aborted, and automatic continuation is turned off. The deadline keeps passing while
Pi is closed, and an already-passed deadline is recorded when the next session opens or goal state
syncs, before any further goal work.

A turn already running may finish. The cancelled wait never delivers a late result, but its child
or background job keeps going. Once current work settles, the goal cannot ask for another turn.
Expiry stops continuation; it does not kill running work. Resuming needs a new deadline or
`--no-deadline`.

The TUI shows the local due time. The model sees a fixed ISO timestamp, so the prompt text does not
change as time passes.

## Context and dispatch

`pi-goal` puts fixed goal instructions in the system prompt. When a working run starts with a goal,
a message in the conversation gives the objective, criteria and current state. Later updates come
from tool results and evaluator feedback. Saved goal text is treated as user data. Request IDs and
dispatch bookkeeping stay internal, and requests keep the earlier conversation unchanged, with or
without a goal.

Every main-model request gets a private receipt naming the request, goal ID, revision, branch and
session. The check runs just before every main-model call, including later calls in a tool loop. A
run keeps its goal until the goal completes or is blocked. After that, the next call in the loop is
stopped before reaching the provider and reported as an aborted continuation, with no provider
call, usage or retry.

A run you start while the goal is paused or complete has no goal receipt; it runs normally and is
not charged to the goal. Calls by children, the classifier, the evaluator, direct summaries and
cache warming are outside this check.

`/goal <objective>`, `/goal start`, `/goal edit` and `/goal resume` send the objective as a normal
user message with prompt-template expansion off. `create_goal` approves a goal inside the current
run and sends no extra message.

At a completed `agent_before_settle` point, `pi-goal` evaluates only if the goal scope is current,
active, enabled, within budget and has no pending waits. It asks for another turn after an
`incomplete` verdict, or a blocker seen fewer than three times in a row. Aborted or failed runs are
not assessed.

## Assessment

A separate, logged-in evaluator model does the assessment. The working model has no `update_goal`
tool. Criteria are fixed when the goal is approved. By default the objective is the only criterion;
custom criteria must be non-empty and distinct.

| Evaluator field | Rules |
| --- | --- |
| `verdict` | `finished`, `incomplete` or `blocked` |
| `reason` | Non-empty, at most 120 characters |
| `blockerKey` | For `blocked`: a stable name for the problem, at most 80 characters. Otherwise `null` |
| `requirements` | Every criterion ID exactly once (up to 12), each with evidence of at most 96 characters and `met`, `unmet` or `uncertain` |

The schema uses literal unions and the whole reply is validated. The limits keep a full assessment
within the 2,048-token response limit. The objective and each criterion are limited to 12,000
characters, and together to 24,000 characters and 4,096 tokens by Pi's estimate, so the whole goal
fits the evaluator's first message.

The evaluator asks for strict JSON-schema output where the provider supports it. Otherwise it falls
back to normal tool-schema guidance. The reply is always validated. Missing fields, unknown
criteria, malformed output, or `finished` with any criterion not `met` are rejected.

After a malformed reply, the raw reply and error are saved and the evaluator tries once more. The
retry prompt has the exact schema and criterion IDs, the error, and up to 1,000 characters of the
bad reply as JSON. Both tries share one timeout and cancel signal, and each records its own usage.
Provider, login, abort, timeout and response-length errors are not retried. A second bad reply
stops automatic work. Failure records stay in the session log and are left out of later evaluator
prompts. The evaluator judges the evidence it is given; nothing proves the evidence is true.

Three `blocked` verdicts in a row with the same `blockerKey` mark the goal `blocked` and stop
automatic work. `incomplete` resets the count, and a different key starts a new one. Waiting on a
child makes no evaluator call and counts as nothing.

## Evaluator model and history

`--goal-evaluator-model` picks a provider/model ID. There is no default. The model must be logged
in and in Pi's registry. `--goal-evaluator-timeout` is in seconds, defaults to 30, and is capped at
2,147,483.647 seconds, the longest single timer Node.js allows.

The evaluator gets fixed instructions and a first message with the objective, criteria and
original request. At each stop, the extension adds the worker's new messages and tool results,
then the evaluator's reply and an acknowledgement. Evidence longer than its per-entry limit is cut
with a notice. Each request keeps whole recent rounds up to a size limit or the model's capacity.
Older rounds may be dropped, with a notice that missing evidence cannot prove completion. The full
record stays in the session log. Caching depends on the provider.

Evaluator entries are tied to the goal ID, revision, branch and evaluator model. Pausing, editing,
replacing the session or moving in the tree blocks late replies. Editing and resuming start a new
history. Resuming also clears the blocker count.

Before each request, a token estimate plus room for the reply is checked against the model's
context window. If even the first message does not fit, evaluation fails and automatic work stops.
Missing login, a timeout or invalid output also stop it, with a visible error. The goal stays open.
You can still send messages, without goal instructions, and `/goal resume` turns automatic work
back on with a new history.

## Usage and budget

A budget adds up input, output, cache-read and cache-write tokens, including repeated and cached
input, for main-model requests sent under the active goal. Calls by children, the classifier, the
evaluator, direct summaries and cache warming are not counted. Nor are runs you start while the
goal is paused or complete. A request already sent can finish after a pause or scope change and go
over the budget by its own usage; it still counts against the goal that sent it.

Aborted and failed replies keep their reported tokens and are marked incomplete. With a budget,
missing or incomplete usage means the remaining amount is unknown, so automatic work stops. Without
a budget there is no token limit and the model is not shown totals; `/goal` still shows them.
Budgets are separate from response limits, context windows and account limits. See
[accounting](../accounting.md).

## Provider wrapping

To check every main-model request, `pi-goal` wraps Pi's registered provider methods:

| Existing registration | How it is wrapped | Note |
| --- | --- | --- |
| One API using a configured `streamSimple` handler | Wraps that stream and keeps its provider config | Keeps the configured stream's merge behaviour |
| Several APIs on one provider | Registers a wrapper through Pi's model registry | The SDK's single-config accessor cannot describe mixed APIs while the wrapper is active |

On shutdown, the original provider is restored only if the goal wrapper is still the one
installed, so a later registration by someone else is kept. The wrapper's metadata keeps child
login detection tied to the real provider. See [provider wrapping](../../packages/pi-goal/lib/continuation.ts)
and the [provider lifecycle test](../../packages/pi-goal/lib/independent-provider-lifecycle.test.ts).

## Stored state

| Record | Kind and schema | Purpose |
| --- | --- | --- |
| `pi-goal.state` | Custom entry `{state: GoalState}`, with `GoalState.version` `3`; `{state: null}` clears the goal | Objective, criteria, optional `deadlineAt`, assessments, status and usage |
| `pi-goal.waiter-state.v1` | Custom entry `{version: 1, disarmed: boolean}` | Whether automatic work is turned off |
| `pi-goal.cleared` | Custom message | Notes in the conversation that you cleared the goal, without starting a turn |
| `pi-goal.continue` | Internal custom message | Asks for another turn within the current run |
| `pi-goal.evaluation` | Displayed custom message | Shows the goal's status and the evaluator's reason |
| `pi-goal.evaluation-error` | Displayed custom message | Shows an evaluator error |
| `pi-goal.delivery.v1` | Custom entry, version 1 delivery key | Stops a waited-on answer being delivered twice |
| `pi-goal.request-usage.v1` | Custom entry, version 1 request receipt and usage | Charges worker usage to the goal that sent the request |
| `pi-goal.evaluator.v1` | Custom entry, version 1: `initial`, `input`, `result` or `failure` | Evaluator history, verdicts and failures |

Failure records hold the error and, if the provider returned one, the raw reply. They stay in the
session log but are left out of later evaluator prompts.

Pi rebuilds the goal from these records on the selected branch, in order. Records from other
extensions never create or overwrite a goal. If the current goal or waiter-state record is
malformed, goal work stops. `/goal clear` writes a clean goal record and re-enables the waiter, which
repairs it; malformed records after that point stop goal work again. Pausing, resuming and replay
keep a goal's criteria and usage. See [persistence](../../packages/pi-goal/lib/persistence.ts) and
[its tests](../../packages/pi-goal/lib/persistence.test.ts).

## Owned response waits

A producer, such as delegation, emits `goal:waiter` with a version 1 offer:

| Field | Meaning |
| --- | --- |
| `id`, `owner`, `sessionId` | The offer, its producer and its session |
| `producerGeneration` | The producer's own scope marker; the goal does not read it |
| `promise` | Resolves to `{deliveryKey, value}` with the finished answer |
| `isCurrent()` | Returns false once the producer's scope is gone |
| `respond(result)` | Called once, synchronously, to accept or reject |

Acceptance returns `{accepted: true, scope: {goalId, revision, branchToken}, release()}`;
rejection returns `{accepted: false}`. An offer is accepted only for a current, active, approved
goal within budget. If the callback throws, the wait is removed. Session or branch changes, the
producer going away, pausing, completion or edits all block delivery.

`pi-delegation` makes its offer before sending the task and matches answers to it. Other producers
can use the same contract. Handles for one answer share a delivery key. Once a goal accepts an
answer, the normal notification is suppressed, even after release, so a cancelled wait never turns
into a surprise wake-up. The delivery key is saved before the answer is shown, so it is never
replayed. A failed or stale wait turns off automatic work for that goal scope until you resume; a
later scope is unaffected.

A steering message or `/background` ends the current foreground wait without releasing the pending
answer, so the same `wait_id` works for a later wait. `/background` also ends foreground shell
waits while their jobs keep running. See [wait delivery](../../packages/pi-goal/lib/wait-delivery.ts),
[producer offers](../../packages/pi-delegation/lib/subagent/owned-waiter.ts) and
[wait tests](../../packages/pi-goal/lib/waiter-integration.test.ts).

## Source and tests

- [Goal reducer and criteria checks](../../packages/pi-goal/lib/goal.ts)
- [Approval tests](../../packages/pi-goal/lib/authorization.test.ts)
- [Usage handling](../../packages/pi-goal/lib/usage.ts)
- [Serialized provider-context test](../../packages/pi-goal/lib/serialized-context.test.ts): checks that outgoing instructions stay stable, input only grows, and private receipts never reach provider text. It does not measure live caching or speed.
- [Package test commands](../../packages/pi-goal/package.json) and the [testing guide](../testing.md)
