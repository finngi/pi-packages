# Run shell jobs

Load `pi-bg` to manage session-owned processes. With `pi-security` off, `pi-bg` supplies ordinary
host Bash through Pi's `bash` tool schema and manages its process lifetime; it does not authorize
or constrain commands. With security enabled, `pi-security` owns the `bash` tool and command
authorization. Its default `internal` transport manages secured processes itself. Set
`PI_SECURITY_TRANSPORT=extensions` only when choosing the extension transport: security then sends
each secured command through `pi-bg` with a prepared one-use capability, which stays active for the
process lifetime. The [security guide](security.md#launch-from-the-checkout) shows how to select
that transport.

## Keep a command in the foreground

With the extension transport, a secured `bash` call waits for the command and returns its output,
exit code, elapsed time, and whether the output was truncated. If you send a steering message while
it is waiting, Pi returns the process ID and leaves the command running. You can also use
`/background` to hand off foreground shell waits without sending a new message. Either action ends
the wait, not the job.

For a command that should start and return immediately, use the shell tool's `background: true`
option where available. It returns a process ID while the job continues. The model-facing
`background_process` tool can inspect, read, or cancel jobs; it does not launch them. Under the
extension transport, its list includes secured shell jobs.

## Inspect or stop a job

Use `/jobs` to list `pi-bg` jobs, `/jobs read ID [CURSOR]` to read output, and `/jobs cancel ID` to
stop a job. The model can use `background_process` with `action: "list"`, `"status"`, `"read"`, or
`"cancel"`. Under the extension transport, this includes secured shell jobs. Reads use byte
cursors; a reported gap means older output has fallen outside the bounded buffer.

Natural exit, an explicit timeout, cancellation, or session shutdown ends the job. A foreground
wait can end while its job continues. For a secured shell, the prepared capability and its lease
remain owned until process finalization, including cleanup of ordinary descendants. See the
[background tool reference](../reference/tools.md#background-process-tool) for limits and the
[background service contract](../reference/events.md#background-service) for trusted extensions.
