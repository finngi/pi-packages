# Run shell jobs

Load `pi-background` to run Bash commands in the background, read their output and cancel them.
Commands run with your normal user permissions. Add the permission package if you want calls
checked first. Delegation can share the process service but does not need this extension.

## Run a command

A normal `bash` call waits for the command and returns its output, exit code, elapsed time and
whether the output was cut short. If you send a steering message while it waits, Pi returns the
process ID and leaves the command running. `/background` does the same without a message. Both
stop the wait, not the command.

To start a command and return straight away, set `background: true` on the `bash` call. It returns
a process ID and the job keeps running. The model's `background_process` tool can list, inspect,
read and cancel jobs, but cannot start them.

## Check or stop a job

- `/jobs` lists jobs.
- `/jobs read ID [CURSOR]` shows output.
- `/jobs cancel ID` stops a job.

The model uses `background_process` with `action` set to `"list"`, `"status"`, `"read"` or
`"cancel"`. Reads use byte cursors. A gap in the result means older output was dropped from the
bounded buffer.

A job ends when it exits, times out, is cancelled or the session shuts down. Ending a foreground
wait does not end the job. See the [tool reference](../reference/tools.md#background-process-tool)
for limits and the [background service](../reference/events.md#background-service) for use from
other extensions.
