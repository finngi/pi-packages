# Events and delivery reference

Extensions discover trusted in-process services through Pi's event bus. An emitted event is not an interprocess message: child processes communicate through Pi RPC, using stdin commands and stdout events. A service handle is bound to the session that created it.

## Background service

`background:service` accepts `{respond(service)}`. The returned trusted `BackgroundService` has `launch`, `status`, `read`, `write`, `cancel`, and `close`. `launch(spec, options?)` accepts command/argv, cwd/env, owner/label, optional timeout, stdin selection, and data/completion callbacks; it returns `{id, done}`. Only trusted clients supply this interface; the model's `background_process` tool cannot launch or write stdin.

`options.notify: false` lets a protocol owner such as subagents manage delivery itself. Generic notifications have a three-wake budget reset by non-extension input, then append for the next turn without repeatedly waking. Handles reject operations after session replacement or shutdown. `background:policy` accepts trusted admission and cancellation callbacks plus a reason and optional pending cleanup promises. Processes are session-owned: timeout, explicit cancellation, natural completion, and session shutdown finish a job. Natural process exit drains output for a bounded interval, then finalization stops remaining ordinary descendants. The default manager permits four active jobs and retains up to 32 results.

The same native process service manages foreground Bash handoff and explicit background jobs.
The process remains session-owned when a foreground wait yields.

## Child launch contributions

A trusted loaded extension can contribute its child entrypoint and initialization data through
`pi-child-launch:contribute:v1`. The optional permission gate uses this to carry its policy and
genuine root-user context. Model task text cannot register a contribution. There is one native
child launcher, not a separate secured transport.

## Goal services

| Event | Schema | Caller | Purpose |
| --- | --- | --- | --- |
| `goal:create_authorization` | `{objective, budget?, criteria?}` | Trusted embedding code | One-use authorization for the exact objective, optional fixed criteria, and optional budget. The goal extension enforces it with or without security. |
| `goal:waiter` | Version 1 producer-owned offer | Producer extension | Offers a pending response for goal-scoped ownership. |
| `goal:yield-wait:v1` | `{respond(count: number)}` | Background command | Yields current foreground goal waits while preserving their producer-owned pending responses and IDs. |

Goal session entries and detailed authorization, assessment, continuation, accounting, and wait contracts are in the [goal reference](goals.md). The [tool reference](tools.md#goal-tools) defines tool parameters; the [goal guide](../guides/goals.md) describes the user workflow.

## RPC channels

The transport distinguishes Pi RPC `response` acknowledgements, assistant `message_end`/`turn_end` content, and `agent_settled`. An acknowledgement confirms receipt, not an answer. On Pi 1.1, `agent_settled.aborted` distinguishes cancellation from normal completion; an aborted partial answer is rejected, while replies already completed before cancellation remain available. A provider/protocol/process failure or empty settled turn never fabricates a completed successful response.

Pi 1.1's `tool_execution_end.durationMs` measures the tool's `execute()` call. For `background_process`, that is launch/read/status/cancel handler time; a launched process can continue after the launch tool returns, so this field does not measure process lifetime.

| Frame prefix | Purpose | Authority |
| --- | --- | --- |
| `pi-subagents-message:v1:` | Roster queries and dialogue routing through trusted RPC extension requests | Bound sender identity; reachable live parent/siblings only |
| `pi-runtime-usage:v1:` | Child classifier usage report | Validated record; child/dialogue owner records it |

These use `extension_ui_request`/`extension_ui_response` as protocol frames handled by trusted code. Messaging and usage frames are not displayed as human approval questions. `message.delivered` records handoff to Pi or an RPC acknowledgement; Pi may still queue it. It does not establish that a model read the content or accepted a changed task. Root message receipts do not wait for a recipient's answer, avoiding a circular parent/child wait.

Permission review happens in the selected gate before tool execution. Agent dialogue is never
promoted into human authorization. Manual review requires an approval-capable client; automatic
mode uses the configured classifier. See [permissions](../../packages/pi-permissions/README.md).

## Message and response delivery

Definition names select files; running [agent IDs](../semantic-ids.md) route messages. The main identity is stored as `pi-subagents.identity.v1` for resume. Each child gets a new identity. The stable main identity is a system section; the live roster is returned by `agent_list` and launch/close tool results rather than rewritten into the system prompt. Cards show the formatted definition name; expansion exposes routing IDs and request correlations.

Messages and results use XML-escaped envelopes:

```xml
<agent_question from="agent-access-action-active" emitted_at="2026-10-13T10:00:00.000Z" source_request_ids="message-source-input">
Include a failing input for the parser finding.
</agent_question>
```

```xml
<agent_result from="agent-access-action-active">
Artifact: /absolute/workspace/review.md
Validation: inspected parser input checks; execution has not been tested.
</agent_result>
```

`emitted_at` is stamped by the bound sender extension when it emits the message (or by the parent tool when routing starts); absent origin metadata stays unknown. `source_request_ids` lists only source inputs observed active when the broker receives the frame, excludes queued follow-ups, and is contextual correlation rather than an exact originating request. Final `request_ids` remain the completed reply's exact correlation. Queued telemetry may arrive after a final reply or close and remains old dialogue history; closure does not turn it into a new assignment. New frames from a closed or revoked child are refused.

`from` comes from the bound sender, not caller-supplied input. `to` selects the recipient and is omitted from its received envelope. Text, including closing tags or instruction-like content, is escaped. This is dialogue data, not new user authorization.

| Event | Meaning |
| --- | --- |
| Launch acknowledgement | Initial prompt accepted; no answer/correctness claim |
| Message acknowledgement | Broker or child accepts delivery; not proof of reading, revised-task acceptance, or an answer |
| Explicit message | `kind: progress` (parent only, quiet), `question`, or default `message`; `steer` default or `followUp` |
| Completed result | Text answer correlated with request IDs; may report blocked/unverified work |
| Failure | Provider, protocol, or process failure; inspect state for retryability |
| Cancel/close | Process stops and artifacts collect before workspace cleanup |

`steer` queues for the next safe tool boundary; `followUp` waits for the current run to finish. Questions and messages can start an idle recipient. Routine `kind: progress` is accepted only to the parent and uses native `sendMessage` with `triggerTurn: false`, preserving history without starting an idle parent turn; progress to children/siblings is refused. Explicit messages are separate from completed response notification and do not wait for child settlement. Unknown, self-addressed, closed, or revoked recipients refuse; unrelated Pi sessions are unreachable.

Unowned completed responses arriving while the parent is busy stay pending until a successful `turn_end`, after tool results persist. The broker appends remaining responses in one context batch and requests continuation. `subagent_check` consumes a pending response only after contiguous pages from offset zero cover the complete retained reply and any longer queued delivery copy; reading retained history again does not create another notification. A closed JSON archive can be shorter than the queued copy, in which case the larger copy remains pending for ordinary delivery. Idle delivery starts a turn, and `agent_settled` closes the final-boundary race. Failed/aborted parent runs retain responses without automatically waking; a later prompt can consume them. Session/branch cleanup closes children and fences late delivery. Accepted goal waits use their owned route instead.

Source/tests: [broker](../../packages/pi-delegation/extensions/subagent.ts), [dialogue](../../packages/pi-delegation/lib/subagent/rpc-dialogue.ts), [communication integration](../../packages/pi-delegation/lib/subagent/communications-extension.test.ts), and [live delivery](../../packages/pi-delegation/lib/subagent/live-delivery-stock.test.ts).

## Stored lifecycle records

`pi-subagents.event.v1` entries are inspectable session records, not model prompt instructions. Common fields are `version: 1` and `type`.

| `type` | Fields | Trigger |
| --- | --- | --- |
| `agent.started` | `agentId`, `name`, `parentId` | Registered before initial dispatch |
| `agent.failed` | `agentId` | Provider/protocol/process failure |
| `agent.cancelled` | `agentId` | Explicit cancellation finishes |
| `agent.closed` | `agentId`, optional `reason` | Close or session/branch cleanup finishes |
| `message.accepted` | `from`, `to`, `messageId`, optional `requestId` | Broker/recipient acceptance |
| `message.delivered` | `from`, `to`, `messageId`, optional `requestId` or `mode` | Child RPC accepts or broker queues parent text; does not prove reading |
| `result.recorded` | `from`, `sequence`, `requestIds` | Unowned response enters pending queue |
| `result.delivered` | `from`, `to`, `sequence` | Pending response enters parent context/delivery |
| `result.consumed` | `agentId`, `sequence`, `via` | Check/close removes pending notification once |
| `result.dropped` | `agentId`, `sequence`, `reason` | Reply is evicted from the bounded automatic-delivery queue |
| `result.delivery_gap` | `agentId`, `firstSequence`, `lastSequence`, `count` | Parent receives an explicit notice that automatic delivery omitted replies |
| `result.delivery_gap_overflow` | `count` | Additional dropped replies whose per-agent gap details exceeded the summary bound; count may include replies later returned by close/cancel |

Goal entry names, schemas, and branch replay behavior are in the [goal reference](goals.md#stored-state).

## Usage events

`pi-runtime:usage:v1` carries `UsageRecord`: `id`, kind `child`/`classifier`/`evaluator`, `source`, `label`, optional `ownerSessionId`, provider/model, usage, and incomplete marker. Valid usage has nonnegative integer token fields and finite nonnegative cost fields. It is stored as `pi-runtime.usage.v1` custom entries.

`pi-runtime:accounting:v1` discovers the in-process accounting owner so separate library copies do not install competing handlers on one event bus. Child processes have separate owners and report over RPC. Forwarded top-level tool results retain `details.piUsageIds` for replay deduplication. See [accounting](../accounting.md) and [usage validation](../../packages/pi-runtime/src/usage.ts).

## MCP

The parent uses Pi's native MCP integration, configuration, auth and manager. There is no custom
MCP confinement transport. Existing connections are not transferred into child processes.

## Terminal program status

Pi emits OSC 7501 status reports from its interactive TUI after the terminal confirms support.
`working` covers an agent run or compaction; `blocked` covers an open extension dialog or login;
`done` covers a settled run; `error` covers an unrecovered response error; `idle` covers startup
or cancellation. Reports contain the session name, dialog title or first error line. A terminal
can use them to indicate when the user needs to act.

These reports describe the interactive parent process. RPC children use piped JSON events and do
not emit terminal status. Their communication and result delivery continue through the subagent
transport. A terminal `done` report describes run settlement; goal acceptance remains the goal
evaluator's responsibility.

Leave support negotiation enabled unless configuring a terminal that explicitly supports the
protocol. `PI_PROGRAM_STATUS=0` disables reports; `PI_PROGRAM_STATUS=1` forces them. See Pi's
[program-status reference](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/terminal-setup.md#program-status).

## Human command intent

`pi:human-input:v1` carries `{version: 1, sessionId, message}` from trusted extensions that submit a human slash command as a user message. Goal start, edit and resume send the authorized objective through this channel before dispatch. The optional permission gate uses it as classifier context and passes genuine intent to child review. It accepts only the current parent session; child messages and model tool inputs do not establish human intent.

## Saved child instructions

`pi-context:saved-instructions:v1` requests the saved personal/project instruction text for a
new child. `pi-context` resolves its already-loaded instruction sources against saved settings;
parent session overrides are not consulted. Delegation retains the static context file snapshot
separately. No provider means no inherited selected-instruction section; it never falls back to
the parent's rendered section. A provider error stops launch with a diagnostic. This in-process
request is not a model tool or a new instruction-priority level.
