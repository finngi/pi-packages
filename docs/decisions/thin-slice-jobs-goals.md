# Jobs and goals as separate packages

Status: done.

## Decision

Keep `pi-background` and `pi-goal` as separate Pi packages. Both already worked on their own.
Rewriting the process manager, evaluator or goal state machine would add risk and remove no
dependency.

`pi-background` owns job lifetime, bounded output, cancellation and completion notices. Its Bash
tool keeps the SDK schema and can still hand a foreground command to the background when you send
a steering message. Its own shell calls use its session service directly; the event service stays
for other extensions. It needs no goals, agents or permissions. Loading it for discovery adds no
process-exit listeners; session start and shutdown handle that.

`pi-goal` owns the objective, evaluator and continuation decision. Its state is saved in session
entries, and `agent_before_settle` is where it asks for another turn. Waiting on child answers,
`/background` and permission wrappers are optional. Removing them would break useful workflows;
requiring them would break standalone use.

Shared code for timers, IDs and accounting is imported by subpath. The `pi-runtime` root also
exports resource selection, so importing the root pulled the resource browser into jobs and goals.
Subpath imports fix that while keeping the tested shared code.

The subprocess manager is library code, so other packages can use it without loading
`pi-background`. That means a child agent does not need the background extension to run its own
process.

Commands run with your normal user permissions and can be checked first by `pi-permissions`. The
old sandboxed transport adapters are gone, and jobs and goals depend on no permission package or
sandbox.

## Tests

- `npm run test:standalone --workspace=pi-background`: stock Pi with only the jobs extension runs
  Bash, starts a real job, reads and cancels it, checks tool selection, and rejects stale handles
  after shutdown.
- `npm run test:standalone --workspace=pi-goal`: stock Pi with only the goal extension runs
  scripted worker and evaluator replies, handles bad verdicts, continuation and steering, and
  reopens a real session file with goal state and usage intact.
- Unit tests and type checks also cover the optional integrations. Scripted providers check
  lifecycles, not real model quality.

Every check uses temporary directories and never activates a release or touches running Pi
processes.

## Left out on purpose

No new job scheduler, goal daemon, package resolver or permission service, and no new transport
to children. Jobs belong to their session and are not restarted on resume; only goal state and
usage are saved.
