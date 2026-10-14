# pi-bg

Session-owned subprocess transport for Pi. It owns process lifetime, bounded output, byte cursors, trusted protocol stdin, cancellation, and completion delivery. It has no mandatory security dependency and does not approve model commands.

Install this native Pi package on its own. It requires neither `pi-goal` nor `pi-subagents` nor a custom launcher. Shared process utilities are ordinary imported code; importing them does not load the background extension or register tools. The exit handler is installed only when a Pi session starts, and session shutdown closes its jobs. Process handles do not survive reopening a session.

The manager provides separate capacity for shell commands (four by default) and subagents (sixteen by default), so delegation leaves room for parent shell work.

The model's `background_process` tool lists, inspects, reads, or cancels session jobs. `/jobs list`, `/jobs read ID [CURSOR]`, and `/jobs cancel ID` provide the same controls in the UI. `/background` yields a foreground shell or goal wait so the conversation can continue while the work remains active.

When security is off, pi-bg overrides Pi's stock `bash` tool with the same SDK schema backed by the session process manager and ordinary host Bash access. In this mode, pi-bg manages process lifetime; it does not authorize commands or constrain host access. With security enabled, pi-security owns the `bash` tool and authorization. Its default `internal` transport manages secured processes without pi-bg. When `PI_SECURITY_TRANSPORT=extensions` selects the extension transport, pi-security launches secured commands through the session manager using a prepared one-use capability. The security lease remains held until the managed job completes or is cancelled, times out, or the session shuts down. On POSIX, process groups clean up ordinary descendants; on Windows, cancellation stops only the direct child. Deliberate daemon/session escapes remain a limitation.

- [Background tool and limits](../../docs/reference/tools.md#background-process-tool).
- [Trusted background service](../../docs/reference/events.md#background-service).
- [Launch configuration](../../docs/reference/configuration.md#security-selection-and-launch) and [architecture](../../docs/architecture.md).

Source entrypoint: [extensions/background-process.ts](extensions/background-process.ts). From the repository root, run `npm run test --workspace=pi-bg` and `npm run typecheck --workspace=pi-bg`.

`npm run test:standalone --workspace=pi-bg` loads this extension alone through stock Pi, runs a real host command and background job, reads/cancels it, and checks that shutdown invalidates its handles. It uses a temporary test directory and does not change the installed runtime or running sessions. The full `test:e2e` additionally checks optional legacy security transports.

See [provenance](PROVENANCE.md) for the extraction baseline and [testing](../../docs/testing.md) for integration checks.
