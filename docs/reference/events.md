# Events and delivery

Extensions find each other's services through Pi's in-process event bus. An event is not a message
between processes: child processes talk over Pi RPC, with commands on stdin and events on stdout.
A service handle belongs to the session that created it.

## Background service

Emit `background:service` with `{respond(service)}` to get a `BackgroundService`. It has `launch`,
`status`, `read`, `write`, `cancel` and `close`. `launch(spec, options?)` takes the command or
argv, cwd and env, owner and label, an optional timeout, stdin choice, and data and completion
callbacks. It returns `{id, done}`. Only extension code can use this service; the model's
`background_process` tool cannot launch jobs or write to stdin.

- `options.notify: false` lets an owner, such as delegation, handle notifications itself.
- Ordinary notifications can wake the session three times. Any input not from an extension resets
  that count. After that, results are added for the next turn without waking it.
- Handles stop working after the session is replaced or shut down.

Jobs belong to their session. A job ends on timeout, cancellation, normal exit or session
shutdown. After the main process exits, output is drained for a short time, then remaining child
processes are stopped. By default four jobs run at once and up to 32 results are kept.

Foreground Bash handoff and `background: true` jobs use the same service. A job stays owned by the
session when a foreground wait ends.

## Child launch contributions

A loaded extension can add its own entrypoint and start-up data to every child launch through
`pi-child-launch:contribute:v1`. `pi-permissions` uses this to pass its settings and your messages.
Task text from the model cannot register a contribution.

## Goal services

| Event | Payload | Sent by | Purpose |
| --- | --- | --- | --- |
| `goal:create_authorization` | `{objective, budget?, criteria?, deadline?}` | Embedding code | Approves one `create_goal` call for exactly this objective, criteria, budget and deadline |
| `goal:waiter` | Version 1 offer from the producer | Producer extension | Offers a pending answer for a goal to wait on |
| `goal:yield-wait:v1` | `{respond(count: number)}` | `/background` | Ends current foreground goal waits, keeping their pending answers and IDs |

The [goal reference](goals.md) covers goal session entries and the approval, assessment,
continuation, accounting and wait contracts. The [tool reference](tools.md#goal-tools) lists tool
parameters, and the [goal guide](../guides/goals.md) covers everyday use.

## RPC channels

The transport tells apart Pi RPC `response` acknowledgements, assistant `message_end` and
`turn_end` content, and `agent_settled`. An acknowledgement means the request arrived, not that it
was answered. `agent_settled.aborted` tells cancellation apart from normal completion: a partial
answer from an aborted run is rejected, but answers finished before the cancel stay available. A
provider, protocol or process failure, or an empty turn, never becomes a fake successful answer.

`tool_execution_end.durationMs` measures the tool's `execute()` call. For `background_process`
that is the time to launch, read, check or cancel. A launched job keeps running after the tool
returns, so this is not the job's run time.

| Frame prefix | Carries | Rules |
| --- | --- | --- |
| `pi-subagents-message:v1:` | Agent list queries and messages | Sender identity is fixed; only the live parent and siblings are reachable |
| `pi-runtime-usage:v1:` | Classifier usage from a child | Validated, then recorded by the parent |

These frames travel as `extension_ui_request` and `extension_ui_response` and are handled by
extension code. They are never shown to you as approval questions. `message.delivered` means the
message was handed to Pi or acknowledged over RPC; Pi may still queue it. It does not mean a model
read it or accepted a changed task. Message receipts from the main agent do not wait for an
answer, so parent and child never wait on each other.

`pi-permissions` checks calls before they run. Messages between agents never count as your
instructions. Approval prompts need a client that can show them; otherwise the call is blocked. See
[permissions](../../packages/pi-permissions/README.md).

## Messages and answers

Agent names pick definition files; running [agent IDs](../semantic-ids.md) route messages. The
main agent's ID is saved as `pi-subagents.identity.v1` for resume, and each child gets a new one.
The main ID is in the system prompt. The live list of agents comes from `agent_list` and from
launch and close results, never from rewriting the system prompt. Cards show the agent name;
expanding a card shows routing IDs and request IDs.

Messages and answers arrive in XML-escaped envelopes:

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

- `from` is set by the sender's extension, not by the caller. `to` picks the recipient and is left
  out of the delivered envelope.
- `emitted_at` is stamped by the sender's extension when it sends, or by the parent tool when
  routing starts. If unknown, it is left out.
- `source_request_ids` lists the inputs that were active when the message arrived, not counting
  queued follow-ups. It is context, not the exact request that caused the message. An answer's
  `request_ids` are exact.
- All text is escaped, including closing tags and text that looks like instructions. It is
  conversation, not your approval.

Queued progress can arrive after a final answer or close. It is old conversation, not a new task.
New frames from a closed or revoked child are refused.

| Event | Meaning |
| --- | --- |
| Launch acknowledgement | The first prompt was accepted; says nothing about an answer |
| Message acknowledgement | The message was accepted for delivery; not read, accepted or answered |
| Message | `kind`: `progress` (to the parent only, quiet), `question` or `message` (default); `mode`: `steer` (default) or `followUp` |
| Answer | Text matched to request IDs; may report blocked or unchecked work |
| Failure | Provider, protocol or process failure; check state to see whether to retry |
| Cancel or close | The process stops and files are collected before cleanup |

`steer` waits for the next safe point after the current tool; `followUp` waits for the run to end.
Questions and messages can wake an idle recipient. Progress is accepted only for the parent and is
sent with `sendMessage` and `triggerTurn: false`, so it is kept in history without waking the
parent. Messages are separate from answer notifications and do not wait for the child to settle.
Unknown, self-addressed, closed or revoked recipients are refused, and other Pi sessions cannot be
reached.

Answers that arrive while the parent is busy wait until a successful `turn_end`, after tool
results are saved. The parent then adds them in one batch and continues. If the parent is idle, an
answer starts a turn, and `agent_settled` covers the race at the end of a run. Failed or aborted
parent runs keep answers without waking; a later prompt picks them up. Session or branch cleanup
closes children and blocks late delivery. Answers a goal is waiting on take the goal's route
instead. See [reading answers](../guides/delegation.md#reading-answers) for how `subagent_check`
clears pending answers.

Source and tests: [broker](../../packages/pi-delegation/extensions/subagent.ts), [dialogue](../../packages/pi-delegation/lib/subagent/rpc-dialogue.ts), [communication tests](../../packages/pi-delegation/lib/subagent/communications-extension.test.ts) and [live delivery](../../packages/pi-delegation/lib/subagent/live-delivery-stock.test.ts).

## Saved lifecycle records

`pi-subagents.event.v1` entries are records you can inspect; the model does not see them as
instructions. Every entry has `version: 1` and `type`.

| `type` | Fields | When |
| --- | --- | --- |
| `agent.started` | `agentId`, `name`, `parentId` | Before the first prompt is sent |
| `agent.failed` | `agentId` | Provider, protocol or process failure |
| `agent.cancelled` | `agentId` | Cancellation finishes |
| `agent.closed` | `agentId`, optional `reason` | Close or session/branch cleanup finishes |
| `message.accepted` | `from`, `to`, `messageId`, optional `requestId` | The broker or recipient accepts a message |
| `message.delivered` | `from`, `to`, `messageId`, optional `requestId` or `mode` | Child RPC accepts it, or parent text is queued; not proof it was read |
| `result.recorded` | `from`, `sequence`, `requestIds` | An answer joins the pending queue |
| `result.delivered` | `from`, `to`, `sequence` | A pending answer reaches the parent |
| `result.consumed` | `agentId`, `sequence`, `via` | A check or close clears a pending notification |
| `result.dropped` | `agentId`, `sequence`, `reason` | An answer is dropped from the bounded delivery queue |
| `result.delivery_gap` | `agentId`, `firstSequence`, `lastSequence`, `count` | The parent is told that delivery skipped answers |
| `result.delivery_gap_overflow` | `count` | More dropped answers than the gap summaries can list; may include answers later returned by close or cancel |

Goal entry names, schemas and replay are in the [goal reference](goals.md#stored-state).

## Usage events

`pi-runtime:usage:v1` carries a `UsageRecord`: `id`, kind (`child`, `classifier` or
`evaluator`), `source`, `label`, optional `ownerSessionId`, provider and model, usage and an
incomplete flag. Token counts must be whole numbers of zero or more and costs finite numbers of
zero or more. Records are saved as `pi-runtime.usage.v1` custom entries.

`pi-runtime:accounting:v1` finds the accounting owner in this process, so separate copies of the
library do not install competing handlers on one bus. Child processes have their own owner and
report over RPC. Forwarded top-level tool results keep `details.piUsageIds` so replay does not
count them twice. See [accounting](../accounting.md) and [usage validation](../../packages/pi-runtime/src/usage.ts).

## MCP

The parent uses Pi's own MCP integration, configuration, login and manager. There is no custom MCP
transport, and connections are not passed to children.

## Terminal status

Pi's interactive TUI sends OSC 7501 status reports once the terminal confirms it supports them:

| Status | When |
| --- | --- |
| `working` | An agent run or compaction |
| `blocked` | An extension dialog or login is open |
| `done` | A run has settled |
| `error` | A response error was not recovered |
| `idle` | Start-up or cancellation |

Reports include the session name, dialog title or first error line, so a terminal can show when
you need to act. Only the interactive parent sends them; RPC children use piped JSON events. `done`
means a run settled, not that a goal was met; that is the evaluator's call.

Leave support detection on unless your terminal is known to support the protocol.
`PI_PROGRAM_STATUS=0` turns reports off and `PI_PROGRAM_STATUS=1` forces them on. See Pi's
[program-status reference](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/terminal-setup.md#program-status).

## Saved child instructions

Delegation emits `pi-context:saved-instructions:v1` to get the saved personal and project
instruction text for a new child. `pi-context` renders it from the instruction sources it has
loaded and the saved settings, ignoring the parent's session choices. Delegation copies the static
context files separately. If `pi-context` is not loaded, the child gets no selected instructions;
it never falls back to the parent's rendered section. If rendering fails, launch stops with an
error. This is an in-process request, not a model tool or a new priority level.
