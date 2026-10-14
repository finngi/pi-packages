# Usage and cost accounting

Accounting records provider-reported usage for child, permission-classifier, and goal-evaluator calls separately from the parent model's calls. A child task can involve many tool-loop responses: its final answer's usage is only one call, not the task total. Reply delivery and usage collection are separate, so a goal wait, ordinary notification, or explicit check observes the same recorded work.

## Collect and reconcile usage

Child assistant `message_end` events travel over RPC. Each provider call contributes a stable usage record. Permission-classifier and goal-evaluator adapters report each actual call separately; a cached permission decision contributes no new provider call.

The dialogue queries Pi's `get_session_stats` RPC at settlement and before closure. It adds only positive differences from usage already observed, covering compaction, summaries, and other session usage. A cumulative statistics snapshot is reconciled, not repeatedly summed. A stats timeout does not terminate the worker.

On interruption, known usage remains and an incomplete marker is recorded. Provider-internal retries or failed calls without reported usage cannot be reconstructed from elapsed time or an estimate. Missing usage is unknown, not zero.

## Persist and forward once

Usage records are saved as `pi-runtime.usage.v1` custom session entries. A record identifies its kind (`child`, `classifier`, or `evaluator`), source, label, model, and validated numeric usage when available. Late known usage can upgrade a missing record for the same call; duplicate receipts and reads do not add another charge.

Known unreported usage is attached once to a top-level tool result through Pi's `usage` field. `details.piUsageIds` records which entries were forwarded, so session replay does not forward them again. Nested tool results do not also drain those records. The extension neither fabricates assistant messages nor bypasses the read-only session manager.

Accounting installation is owned by the current Pi event bus. Separate installed library copies can share that one in-process owner. Parent and child Pi processes each have their own bus; child reports cross the RPC boundary before entering the parent's ledger.

## Read the displays

| Display | Meaning |
| --- | --- |
| Child result panel | Known cumulative child session usage at answer time |
| `/costs` | Combined session total, parent calls/summaries, child agents, classifiers and evaluators; missing receipts and estimation limits |
| Pi session footer | Normal session usage includes extension receipts forwarded through tool results |

Asynchronous usage, including a final evaluator call, can arrive after the last tool result.
`/costs` includes it immediately. Custom footers can add
`replayUsageLedger(sessionEntries).pending().usage` to Pi's native totals so those records appear
immediately too. Add only the pending receipts: native totals already include receipts attached to
tool results. Both the ledger and forwarded IDs replay from persisted entries on resume. There is
no separate extension-usage status line.

Pi 1.1.0 exposes no standalone usage-append API to extensions; accounting does not fabricate a tool
result to force an update. Input, output, cache-read and cache-write remain separate categories.
Reasoning is a subset of output and is not counted again. Costs are provider/catalog estimates,
not invoices or an extra subscription charge. Missing receipts make the displayed amount a known
lower bound; accounting incompleteness does not describe goal or task completion.

The goal budget counts parent-provider usage for main-model requests dispatched under the active goal authority, including each provider call in a tool loop. The run retains that authority through goal completion or blocking, so another tool-loop request is stopped before provider dispatch. Future independent user runs while a goal is paused or completed have no goal authority and are not charged to it. The counter includes cached and repeated input, output, cache reads, and cache writes; child, permission-classifier, goal-evaluator, summary, and cache-warming calls are excluded. A dispatched request remains attributed to the scope that authorized it if the goal is paused or edited before its response arrives. Aborted or failed responses retain reported token categories and are marked incomplete; incomplete usage stops continuation under an explicit budget. An omitted budget is unlimited. See [goal budgets](guides/goals.md#understand-the-budget) and the [request admission contract](reference/events.md#goal-services).

## Source and verification

- [Ledger validation and deduplication](../packages/pi-runtime/src/usage.ts) and [usage tests](../packages/pi-runtime/test/usage.test.ts).
- [Accounting installation, replay, and forwarding](../packages/pi-runtime/src/accounting.ts).
- [Child RPC reconciliation](../packages/pi-subagents/lib/subagent/rpc-dialogue.ts) and [dialogue tests](../packages/pi-subagents/lib/subagent/rpc-dialogue.test.ts).
- [Pi 1.1.0 parent/child integration](../packages/pi-subagents/lib/subagent/unrestricted-stock.test.ts): four scripted child calls report 60 tokens and $0.12 of fixture cost; known usage reaches parent tool results once. This checks transport/accounting, not live model performance or prices.
