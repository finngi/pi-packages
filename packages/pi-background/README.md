# pi-background

Managed Bash jobs for stock Pi. Load this native package independently; it requires neither
delegation, goals nor a custom launcher. Commands use ordinary host permissions. An optional
before-tool gate can review them without changing the process transport.

`bash` retains Pi's SDK schema/result format and adds `background: true`. That option returns a
managed job ID immediately. `background_process` lists, reads, inspects and cancels this session's
jobs. `/jobs` provides human controls; `/background` or a steering message yields a foreground
wait while its command continues. Explicit cancellation stops the process.

The shared process library bounds retained output and separates shell capacity (four by default)
from child-agent capacity (sixteen). Delegation can share the manager or use the library alone.
Children inherit selected Bash/background tools and own their jobs; they cannot inspect sibling
jobs. Shutdown stops jobs, and stale handles cannot affect a replacement session. Jobs are not
resurrected on resume. POSIX process groups clean up ordinary descendants; deliberate daemon
escapes are not contained.

Run `npm test --workspace=pi-background` for process and lifecycle tests. `npm run test:standalone
--workspace=pi-background` starts stock Pi with this package, launches/read/cancels jobs, and checks
shutdown cleanup. No provider request or active installation change is involved.

See [tools](../../docs/reference/tools.md#background-process-tool),
[service](../../docs/reference/events.md#background-service) and [testing](../../docs/testing.md).
