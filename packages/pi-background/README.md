# pi-background

Background Bash jobs for stock Pi. It works on its own, without delegation, goals or a custom
launcher. Commands run with your normal user permissions; the optional permission package can check
them first.

- `bash` keeps Pi's usual schema and results, and adds `background: true` to return a job ID at
  once.
- `background_process` lets the model list, inspect, read and cancel this session's jobs.
- `/jobs` does the same for you. `/background`, or a steering message, ends a foreground wait while
  the command keeps running.

Output is kept up to a limit. Shell jobs and child agents have separate limits, four and sixteen
by default. Delegation can share this manager or use the process library directly. Children get the
selected Bash and background tools and own their jobs; they cannot see a sibling's jobs. Shutdown
stops jobs, old handles cannot touch a new session, and jobs are not restarted on resume. Process
groups clean up ordinary child processes, but not ones that deliberately detach.

## Tests

```sh
npm test --workspace=pi-background
npm run test:standalone --workspace=pi-background
```

The standalone test starts stock Pi with only this package, runs, reads and cancels jobs, and
checks cleanup on shutdown. It makes no provider requests and changes no installation.

See the [jobs guide](../../docs/guides/background-processes.md),
[tool reference](../../docs/reference/tools.md#background-process-tool),
[service](../../docs/reference/events.md#background-service) and [testing](../../docs/testing.md).
