# Goal reference

This page defines goal authorization, assessment, provider accounting, persisted state, and owned response waits. See the [goal guide](../guides/goals.md) for the user workflow and [goal tools](tools.md#goal-tools) for tool parameters.

Here, the host is Pi's user interface or trusted code embedding Pi. A goal scope is its goal ID, revision, and selected branch—the path through Pi's conversation tree. Editing or resuming changes the revision. Creation grants and provider requests are also bound to their session.

## Authorization

| Caller | Route | Authorization |
| --- | --- | --- |
| User | Type `/goal <objective>` | The exact typed objective authorizes a new goal or edits the unfinished goal. The objective becomes its single criterion. |
| Main coding model | `create_goal({objective, criteria?, budget?, deadline?})` | Pi asks the user to confirm the exact objective, criteria, budget, and deadline, or trusted embedding code supplies matching preauthorization. A scope change before persistence revokes it. |
| Trusted embedding code | Emit `goal:create_authorization` | Supplies one-use authorization for the exact objective, optional criteria, budget, and deadline expression. |

Goal authorization belongs to `pi-goal`. If the optional permission gate is loaded, its call review is an additional requirement; it does not replace goal authorization. See the [authorization checks](../../packages/pi-goal/lib/authorization.test.ts).

The exact lower-case first words `start`, `edit`, `pause`, `resume`, `clear`, and `status` are controls. Other first words begin the shorthand objective. Explicit `/goal start` or `/goal edit` consumes the command and one separator, then preserves the rest as objective text; control commands reject extra arguments. Use `/goal start <objective>` when the objective begins with a reserved word. See the [command parser](../../packages/pi-goal/lib/command.ts).

`/goal clear` persists `{state: null}`, revokes creation grants and pending waits, and aborts the
current goal run and evaluator. A model-visible acknowledgement records the cleared authority
without starting a new turn. It clears only goal authority; it does not cancel unrelated background
processes, child agents, artifacts, conversation history, or usage records.

## Time limits

`/goal start` and `/goal edit` accept `--for <duration-or-timestamp>` before the objective;
`/goal resume --for ...` extends an expired goal. Durations such as `30m`, `2h`, or `1d` resolve
once to an absolute timestamp. Explicit timestamps require a timezone, and deadlines are limited to
3,650 days away. `--no-deadline` removes the deadline on edit or resume. Pausing does not stop the
clock.

Expiry is persisted as status `expired`, cancels an active goal-owned wait call, aborts an in-progress
goal evaluation, and disarms future automatic continuation. The absolute deadline continues elapsing
while Pi is closed; when the next session opens or goal state is synchronized, the extension records
an already-passed deadline as expired before further goal work. A worker turn already in progress
may finish; the canceled wait does not deliver a late result, while its child or background producer
continues independently. Once current work settles, the expired goal cannot request another
goal-driven turn. This is a continuation cutoff, not forced termination of already-running work.
Resume requires a new deadline or the explicit `--no-deadline` choice. The TUI shows a local due
time; model context contains an immutable ISO timestamp so prompt text does not change as time passes.

## Context and dispatch

`pi-goal` puts fixed goal instructions in the system prompt. When a worker run starts with a goal, a retained conversation message supplies its objective, criteria and current state. Tool results and evaluator feedback provide later updates. Saved goal text is user data. Request IDs and admission bookkeeping remain internal; requests preserve the previous conversation prefix, including when no goal is active.

Each main provider request has a private, non-serialized receipt for its request, goal ID, revision, branch, and session. The provider admission check runs immediately before every main-model dispatch, including follow-up calls in a tool loop. A run keeps its captured authority through goal completion or blocking; the next internal call is stopped before the provider and surfaced as an aborted continuation reason. That stop produces no provider call, usage receipt, or retry. A separate user run while a goal is paused or completed has no goal receipt and is allowed without a goal charge. Child, permission-classifier, goal-evaluator, direct-summary, and cache-warming calls are outside worker goal admission.

Starting with `/goal <objective>` or `/goal start <objective>`, editing with `/goal edit`, and
resuming with `/goal resume` queues the authorized objective as a normal user message with prompt
template expansion disabled. `create_goal` authorizes a goal inside the current run and does not
queue a second message.

At a completed `agent_before_settle` boundary, `pi-goal` evaluates only a current, active, armed, in-budget worker scope with no outstanding owned response waits. It requests another worker turn for an accepted `incomplete` assessment or a blocker below the consecutive threshold. Aborted or failed worker runs do not trigger automatic assessment.

## Assessment and completion

A separate authenticated goal evaluator performs assessment. The working model has no `update_goal`
tool. Criteria remain fixed to the authorized objective: by default, the exact objective is the
single requirement; optional custom texts must be nonempty and distinct.

| Evaluator field | Contract |
| --- | --- |
| `verdict` | Exactly `finished`, `incomplete`, or `blocked` |
| `reason` | Nonempty explanation of at most 120 characters |
| `blockerKey` | Stable unresolved-condition identity of at most 80 characters for `blocked`; `null` otherwise |
| `requirements` | Every fixed criterion ID exactly once (up to 12), with evidence of at most 96 characters and `met`, `unmet`, or `uncertain` |

The TypeBox schema uses literal unions and the runtime validates the complete result. Goals allow up
to 12 criteria with bounded text fields so a full assessment fits the 2,048-token response limit.
The objective and each criterion are limited to 12,000 characters, with the combined objective and
criteria limited to 24,000 characters and 4,096 tokens estimated by Pi's tokenizer. This keeps the
complete authorized scope within the evaluator's bounded initial context.
The evaluator requests strict JSON-schema sampling with a preference that the SDK can negotiate against provider
support. Providers or compatibility profiles that do not support strict sampling may use ordinary
tool-schema guidance instead. Host validation remains mandatory in either case. Missing fields,
unknown criteria, malformed output, or `finished` with an unmet or uncertain criterion refuse the
assessment. After a completed response fails validation, the evaluator records the raw response and
error, then makes one corrective attempt. That prompt contains the exact advertised schema and
criterion IDs, the validation error, and a JSON excerpt of the invalid response bounded to 1,000
characters. Both attempts share one timeout and authority signal, and each has its own usage receipt.
Provider, authentication, abort, timeout, or response-length failures do not retry. A second invalid
response disarms automatic continuation. Failure records are inspectable in the session log and are
excluded from later evaluator prompts. The evaluator judges reported evidence; the runtime does not
prove that the evidence is true.

Three fresh consecutive `blocked` assessments for the same condition key record `blocked` and stop
automatic work. `incomplete` resets the count, and a different blocker starts a new count. Waiting
for an owned result creates no evaluator call and no blocker assessment.

## Evaluator model and history

`--goal-evaluator-model` selects a provider/model ID. No evaluator is selected by default.
The model must be authenticated and available in Pi's
registry. `--goal-evaluator-timeout` is a positive timeout in seconds, defaulting to 30 and capped
at 2,147,483.647 seconds, Node.js's maximum single timer delay.

The evaluator receives stable assessment instructions and an immutable initial message containing
the objective, fixed criteria, and initial request context. At each stop, the extension appends new
worker messages and tool results since the previous assessment, followed by the evaluator's response
and acknowledgement. Source evidence is truncated with an explicit omission notice if it exceeds its
per-entry bound. The request keeps whole recent cycles up to a bounded input estimate or the selected
model's capacity; it may omit older cycles with a notice that missing evidence cannot establish
completion. Full evaluator records remain in the session log, even when older cycles are omitted from
a request. Provider caching and measured hit rates still depend on the selected provider.

Evaluator session entries are scoped to goal ID, revision, selected branch, and evaluator model.
Pause, edit, session replacement, or tree changes fence late responses. Edit and resume create a
new scoped history. Human resume also clears the blocker identity and consecutive count, so the
next blocked assessment starts a fresh streak. A token estimate plus response and headroom reserves
is checked against the model context window. If the stable initial context alone does not fit,
evaluation reports an error and disarms continuation. Missing authentication, timeout, or invalid
output also disarm with a visible error. These outcomes leave the goal unresolved. After evaluator
failure, manual messages remain available without goal instructions; `/goal resume` reauthorizes
automatic continuation and starts a new scoped evaluator history.

## Usage and budget

An explicit budget sums parent-provider input, output, cache-read, and cache-write tokens for main-model requests dispatched under active goal authority, including repeated and cached input. Child, permission-classifier, goal-evaluator, direct-summary, and cache-warming calls are excluded. A later independent user run while the goal is paused or completed has no goal charge. One already-dispatched request can finish after a pause or scope change and overshoot by that request's usage; its response remains attributed to the authority that dispatched it.

Aborted and failed responses retain reported token categories and carry an incomplete marker. If an explicit budget has missing or incomplete usage, the remaining amount is unknown and automatic continuation stops. Without a budget, goal continuation has no token ceiling and model context omits usage totals; `/goal` still reports accounting. These limits are separate from provider response limits, context windows, and account limits. See [session accounting](../accounting.md).

## Provider registration lifecycle

Goal admission wraps Pi's registered provider methods so it can check each main-model dispatch:

| Existing registration | Admission wrapper | Constraint |
| --- | --- | --- |
| One API backed by a configured `streamSimple` handler | Wraps that configured stream and retains its provider config | Preserves configured stream merge behavior. |
| Multiple APIs on one provider registration | Registers a provider wrapper through Pi's model registry | The SDK's single-config accessor cannot describe the heterogeneous API registrations while the wrapper is active. |

On session shutdown, cleanup restores the captured provider only if the goal wrapper is still installed, preserving a later provider registration from another owner. Transparent-provider metadata keeps child authentication classification tied to the underlying provider. See [provider admission](../../packages/pi-goal/lib/continuation.ts) and the [provider lifecycle fixture](../../packages/pi-goal/lib/independent-provider-lifecycle.test.ts).

## Stored state

| Record | Kind and schema | Owner and purpose |
| --- | --- | --- |
| `pi-goal.state` | Custom session entry containing `{state: GoalState}`; `GoalState.version` is `3`. `{state: null}` clears the goal. | Objective, fixed criteria, optional absolute `deadlineAt`, assessments, status, and accounting. |
| `pi-goal.waiter-state.v1` | Custom session entry, `{version: 1, disarmed: boolean}` | Whether automatic continuation is disarmed. |
| `pi-goal.cleared` | Custom message | Records the human clear action in model-visible conversation without starting a new turn. |
| `pi-goal.continue` | Internal custom message | Requests another turn within the current run. |
| `pi-goal.delivery.v1` | Custom session entry, version 1 delivery key | Prevents an owned response from being delivered twice. |
| `pi-goal.request-usage.v1` | Custom session entry, version 1 request receipt and usage | Attributes worker provider usage to the dispatch authority. |
| `pi-goal.evaluator.v1` | Custom session entry, version 1, `initial`/`input`/`result`/`failure` | Persists scoped evaluator history, decisions, and failures. |

Failure records contain the error and, when a provider returned one, the raw response. They remain
inspectable in the session log but are excluded from later evaluator prompts.

Pi reconstructs a goal from these records on the selected branch in order. Unrelated extension records do not import or overwrite a goal. Malformed current goal or waiter-state records fail closed; a later `/goal clear` writes the explicit goal tombstone and rearmed waiter record needed to recover them. Malformed records after those recovery entries still fail closed. Pausing, resuming, and replaying a saved current goal preserve its fixed criteria and accounting. See [persistence](../../packages/pi-goal/lib/persistence.ts) and [persistence tests](../../packages/pi-goal/lib/persistence.test.ts).

## Owned response waits

`goal:waiter` accepts a producer-owned version-1 offer:

| Field | Contract |
| --- | --- |
| `id`, `owner`, `sessionId` | Offer identity, producer, and owning session. |
| `producerGeneration` | Opaque producer scope; the goal does not interpret it. |
| `promise` | Resolves `{deliveryKey, value}` for the completed response. |
| `isCurrent()` | Becomes false when producer scope or capability is revoked. |
| `respond(result)` | Synchronous, exactly-once acceptance or rejection callback. |

Acceptance returns `{accepted: true, scope: {goalId, revision, branchToken}, release()}`; rejection returns `{accepted: false}`. The offer is accepted only for a current, active, authorized, in-budget goal scope. If the callback throws, the retained waiter is removed. Session/branch changes, producer revocation, pause, completion, or scope edits fence delivery.

The `pi-delegation` producer offers before dispatch and correlates replies to the offer; another trusted producer can implement the same contract. Handles for one completed response share a delivery key. Accepted ownership suppresses the ordinary notification route, even after release, so a revoked wait cannot fall back to an unsolicited wake. The delivery key is persisted before exposing the result, preventing replay. A failed or stale wait disarms its accepted scope until human resume; a later scope is unaffected. A steering message or `/background` yields the current foreground wait without releasing its producer-owned pending response, so the same `wait_id` remains available for a later wait. `/background` also yields foreground secured-shell waits while their processes continue. See [wait delivery](../../packages/pi-goal/lib/wait-delivery.ts), [producer offers](../../packages/pi-delegation/lib/subagent/owned-waiter.ts), and [wait integration](../../packages/pi-goal/lib/waiter-integration.test.ts).

## Implementation and checks

- [Goal reducer and criterion validation](../../packages/pi-goal/lib/goal.ts)
- [Authorization fixture](../../packages/pi-goal/lib/authorization.test.ts)
- [Usage handling](../../packages/pi-goal/lib/usage.ts)
- [Serialized provider-context fixture](../../packages/pi-goal/lib/serialized-context.test.ts): tests stable outbound instructions, append-only serialized input and private receipts absent from provider text; it does not establish live cache or performance behavior.
- [Package test commands](../../packages/pi-goal/package.json) and the [contribution testing guide](../testing.md)
