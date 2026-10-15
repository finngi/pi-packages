# Usage and costs

Pi counts the parent model's calls. These packages also record provider usage from children, the
permission classifier and the goal evaluator, and add it to Pi's totals once.

One child task can make many model calls in its tool loop. The usage shown on its final answer is
one of those calls, not the task total. Usage is collected separately from answer delivery, so a
goal wait, a normal notification and `subagent_check` all see the same recorded work.

## How usage is collected

Each child `message_end` event travels over RPC, and each provider call adds one usage record. The
classifier and evaluator report each real call separately. A cached permission decision adds
nothing, because no provider call was made.

When a child settles, and again before it closes, the parent asks it for Pi's
`get_session_stats`. Only increases over what was already recorded are added. This picks up
compaction, summaries and other session usage without counting a running total twice. If the stats
request times out, the child keeps running.

If a child is interrupted, its known usage stays and the record is marked incomplete. Retries or
failed calls that the provider never reported cannot be rebuilt from elapsed time. Missing usage
is unknown, not zero.

## How usage is saved and forwarded

Records are saved as `pi-runtime.usage.v1` custom session entries. Each one names its kind
(`child`, `classifier` or `evaluator`), source, label and model, plus validated numbers when the
provider reported them. A late report can fill in a missing record for the same call. Duplicate
reports and repeated reads do not add another charge.

Unforwarded usage is attached once to a top-level tool result through Pi's `usage` field.
`details.piUsageIds` lists the records forwarded, so replaying the session does not forward them
again. Nested tool results do not forward the same records. Nothing fakes assistant messages or
writes around Pi's read-only session manager.

Native tools can attach usage to their own result. Codex search does this, so its usage is already
in Pi's totals and is not added again. Its warnings about missing usage or unknown prices are saved
with the tool result and shown in `/costs`, including when search runs inside a nested tool.

One accounting owner runs per Pi event bus, even if several copies of the library are installed.
Parent and child processes each have their own bus. Child reports cross RPC before they reach the
parent's records.

## Reading the totals

| Where | Shows |
| --- | --- |
| Child result panel | Known child session usage when the answer arrived |
| `/costs` | Session total, parent calls and summaries, children, classifier and evaluator, plus anything missing |
| Pi footer | Pi's normal totals, including usage forwarded through tool results |

Some usage, such as a final evaluator call, arrives after the last tool result. `/costs` includes
it straight away. A custom footer can add `replayUsageLedger(sessionEntries).pending().usage` to
Pi's totals to show it too. Add only the pending records, because Pi's totals already include the
forwarded ones. The records and forwarded IDs are rebuilt from the session on resume. There is no
separate status line for extension usage.

Pi 1.2.0 has no API for extensions to add usage on their own, and we do not fake a tool result to
force one. Input, output, cache-read and cache-write stay separate. Reasoning is part of output and
is not counted again. Costs are estimates from the provider or model catalogue, not invoices or an
extra subscription charge. When records are missing, the total is a lower bound. That says nothing
about whether a goal or task is complete.

## Goal budgets

A goal budget counts the parent's main-model requests made while the goal is active, including
every call in a tool loop. It includes cached and repeated input, output, cache reads and cache
writes. Calls by children, the classifier, the evaluator, summaries and cache warming are not
counted. Runs you start while a goal is paused or complete are not counted either.

A request belongs to the goal that sent it, even if the goal is paused or edited before the reply
arrives. A failed or aborted reply keeps its reported tokens and is marked incomplete. Incomplete
usage stops automatic continuation when a budget is set. With no budget, there is no limit. See
[goal budgets](guides/goals.md#understand-the-budget) and the
[goal reference](reference/goals.md#usage-and-budget).

## Source and tests

- [Record validation and deduplication](../packages/pi-runtime/src/usage.ts) and [tests](../packages/pi-runtime/test/usage.test.ts).
- [Accounting setup, replay and forwarding](../packages/pi-runtime/src/accounting.ts).
- [Child RPC reconciliation](../packages/pi-delegation/lib/subagent/rpc-dialogue.ts) and [tests](../packages/pi-delegation/lib/subagent/rpc-dialogue.test.ts).
- [Pi 1.2.0 parent and child test](../packages/pi-delegation/lib/subagent/native-delegation-stock.test.ts): four scripted child calls report 60 tokens and $0.12 of test cost, and the parent's tool results receive that usage once. This tests transport and accounting, not real models or prices.
