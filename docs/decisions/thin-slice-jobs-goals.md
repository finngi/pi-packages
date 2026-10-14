# Keep jobs and goals independently usable on stock Pi

Status: accepted for this refactor. No installed runtime or running session is changed by this source work.

## Decision

Keep `pi-bg` and `pi-goal` as separate native Pi packages. Both already have working native entrypoints; rewriting their process manager, evaluator or goal state machine would add risk without removing a dependency.

`pi-bg` owns job lifetime, bounded output, cancellation and completion delivery. Its managed Bash implementation retains the native SDK schema and the existing ability to yield a foreground command when a person steers the conversation. Its own shell calls use its local session capability directly; the optional event service remains for other extensions. It does not need goals, child agents or security to load or run. Loading a package for discovery does not install process-exit listeners; session start/shutdown own that lifecycle.

`pi-goal` owns the saved objective, evaluator and continuation decision. Native session entries persist its state, and `agent_before_settle` is the point where it can request another worker turn. Child-result waits, background yielding and permission wrappers remain optional integrations. Removing those integrations would break useful existing workflows; making them compulsory would break independent use.

Use explicit shared-library subpath imports for timers, identifiers and accounting. The runtime root barrel also exports resource selection code, so importing it eagerly pulled the resource browser into otherwise noninteractive job/goal execution. Granular imports remove that module coupling while retaining tested shared code.

The pure subprocess manager is shared library code. Other packages may reuse it without loading the `pi-bg` extension. That prevents a child agent from requiring a background extension merely to start its own process.

## Security boundary

With no security selected, host permissions are normal. `pi-bg` neither invents authorization nor restricts commands. If the existing secured transport was explicitly selected but its provider is absent, it continues to refuse execution. Absence of an optional integration is different from an explicitly requested integration failing.

The older secured transport adapters are retained for callers already using them; the new thin permission extension can observe native tool calls without requiring this transport. These adapters are not a dependency of plain job/goal operation.

## Evidence

- `npm run test:standalone --workspace=pi-bg`: stock Pi loads only the job extension, runs host Bash, starts a real job, reads and cancels it, checks native tool selection, and rejects stale handles after shutdown.
- `npm run test:standalone --workspace=pi-goal`: stock Pi loads only the goal extension, drives deterministic worker/evaluator responses, handles malformed verdicts, continuation and steering, and reopens a real session file with goal state and usage receipts preserved.
- Package unit tests and typechecks cover the optional integrations as well. Deterministic providers verify lifecycle behavior; they are not evidence of live model quality.

Each check uses temporary directories and never activates a release or alters existing Pi processes.

## Deliberately omitted

No new job scheduler, goal daemon, package resolver or permission control plane. No new transport for communicating with children. Job processes are session-owned and are not resurrected on resume; only goal state and accounting are persisted.
