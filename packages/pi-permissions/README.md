# pi-permissions

Opt-in permission rules and model approval for native Pi tools. Approved tools run with Pi's
ordinary host access. This package provides no OS confinement and registers no replacement tools.

## Use

```sh
pi -e ./packages/pi-permissions --permissions-policy /absolute/path/permissions.json
```

For persistent installation, use `pi install /absolute/path/to/package`. The trusted default policy
is `permissions.json` in Pi's user agent directory (normally `~/.pi/agent`). A missing or invalid
policy blocks calls. Policy changes take effect at session startup or native extension reload.

```json
{
  "mode": "auto",
  "classifier": { "model": "openai-codex/gpt-6-luna", "timeoutSec": 15 },
  "deny": [{ "tool": "bash", "match": { "program": "sudo" } }],
  "allow": [
    { "tool": "read" },
    { "tool": "bash", "match": { "program": ["pwd", "ls", "rg"] } }
  ]
}
```

`off` disables the gate. Otherwise deny rules take priority, then allow rules. Unmatched calls ask
the human in `manual` mode or the classifier in `auto` mode. Manual approval requires Pi's native
TUI or an RPC client handling approval requests; without a UI the action blocks. An unavailable
model, failed request, malformed response or ambiguous verdict also blocks. No approval cache or
lasting permission grant is created.

Rules name a Pi `tool`, or `*`. An optional `id` labels blocked calls. Omitting `match` covers all
inputs for that tool. Bash matches accept literal `program`, `subcommand`, `args-contain` and
`wrappers` strings or lists (`wrappers` requires a list). Every parsed command must match an allow
rule. A program allow does not include wrappers automatically. Allows check the first argument
for `subcommand`; denies check every argument, including `git -C repo push` and quoted tokens.

Expansions, unsupported syntax and output redirects go to approval when using command allow rules.
Known nested commands are inspected for denies. Opaque or oversized Bash also goes to approval
when command-specific denies exist, even with a blanket allow. Otherwise a blanket Bash allow
accepts opaque scripts. These checks inspect visible arguments; they cannot establish every
program a script or interpreter will later start.

The classifier receives genuine recorded user messages, the worker's preceding explanation and
available reasoning, the working directory and the exact call. It uses Pi's model registry and
authentication. Responses models receive a strict JSON schema with `reason` before `verdict`;
native classifier models use Pi's choice API. Context over 64 KiB blocks before a model request;
use manual approval or a fresh session with the current request. New user input invalidates an
approval in progress.

Children launched by `pi-delegation` inherit the loaded gate, validated policy and a snapshot of
genuine root user messages through the trusted native launch hook. Their own tasks remain worker
evidence. The same policy mode applies; manual child approval needs an RPC approval handler.
Root user changes after launch are not pushed into already-running children. Loading this package
does not install it into independently started Pi processes.

## Accounting and checks

Classifier usage persists in Pi session receipts, appears in `/costs`, and is added to native tool
usage once. Pi skips `tool_result` for blocked calls, so a final denial's usage reaches the native
footer on the next executed tool result. Missing provider usage is reported as incomplete.

```sh
npm test --workspace=pi-permissions
npm run test:stock --workspace=pi-permissions
```

Tests exercise literal rules, exact-call context, structured responses, cancellation, accounting
replay and native loading. The stock test uses an isolated agent directory and scripted model;
it verifies stock tools execute and blocked calls cannot write. It makes no provider request and
does not establish classifier judgment quality.
