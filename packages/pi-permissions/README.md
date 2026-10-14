# pi-permissions

A small, opt-in permission gate for stock Pi. It checks model tool calls before execution and leaves Pi's tools unchanged. It does **not** provide OS confinement: an approved command runs with the Pi process's ordinary filesystem, process, GPU and network access.

This package reuses pi-security's Bash parser and classifier adapter as library code. Installing a library dependency does not activate its Pi extension. Loading the full `pi-security` sandbox extension alongside this alternative gate blocks calls with an instruction to select one package.

## Try it independently

From this repository, with dependencies installed:

```sh
pi -e ./packages/pi-permissions --permissions-policy /absolute/path/permissions.json
```

Use a policy such as:

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

The default policy location is `permissions.json` in Pi's user agent directory (normally `~/.pi/agent`). A missing or invalid policy blocks calls with a configuration error. A project file cannot silently replace this trusted user policy.

For persistent native installation use `pi install /absolute/path/to/package`, with the normal project/user scope options. The package contains one executable extension; changing its policy takes effect at the next session startup or native extension reload. This change does not install or activate it in any existing runtime.

## Decisions

1. `off` explicitly disables the gate.
2. Otherwise any matching deny rule blocks the tool; no classifier can override it.
3. A matching allow rule permits the tool without calling a model.
4. An unmatched action asks the human in `manual` mode or the configured classifier in `auto` mode. Manual approval requires an approval-capable client (the native TUI or an RPC client handling approval requests); without one it blocks with an instruction to configure auto mode.

`tool` is a Pi tool name, or `*` for any tool. Optional `id` only labels an error. A rule without `match` covers that tool's entire input. Bash matches support `program`, `subcommand`, `args-contain` and `wrappers`, using literal strings or lists. For allows, `subcommand` is the first argument. Denies conservatively match that token anywhere in the arguments, so options such as `git -C repo push` cannot hide a denied `push`; a quoted argument with that exact token can also match. Every parsed command must match an allow rule; expansions, unsupported shell syntax and writes through shell redirection go to approval. Known nested commands are also inspected for denies. A program-specific allow rule does not automatically include wrappers such as `env`.

These are checks on visible tool arguments, **not a promise to inspect every program a shell script or interpreter later starts**. If command-specific Bash denies exist, opaque/oversized Bash goes to approval even with a blanket allow; the gate cannot establish those denies from that syntax. With no command-specific denies, a blanket Bash allow permits opaque Bash too. Use the full sandbox package when OS enforcement is required; do not treat this gate as that boundary.

The classifier receives the user's recorded messages, the worker's explanation and available reasoning before the exact call, the working directory and that call. The existing Responses adapter enforces JSON output with `reason` before `verdict`; native classifier models use Pi's structured choice API. Only an explicit `allow` permits execution. Missing models, authentication/transport failures, malformed output and ambiguity block with a reason. New user input invalidates an approval still in progress. No response cache or growing permission grant is introduced.

Classification input is limited to 64 KiB, including recorded user messages. It is never silently truncated, since doing so could discard an earlier restriction. If a long session exceeds the limit, the error recommends manual approval or a new session with the current request. Preflight rejection makes no model call and records no billed request.

The initial child-session boundary is deliberately narrow: when `PI_SUBAGENT=1`, recorded child tasks are labelled as untrusted worker text, not genuine user authorization. This thin package does not yet transport root-user authorization into child sessions. Allow rules still work; unmatched actions may need a parent-side approval workflow. Selecting this package for a parent does not itself install it in another Pi process. Approving a child launch permits that host process; it does not claim to review every subsequent child tool call.

## Accounting and checks

The existing shared accounting helper records classifier usage, supplies `/costs`, and restores receipts on session resume. It adds each receipt to native tool usage once. Stock Pi skips `tool_result` hooks for a blocked call: if classification is the final denied action, its receipt stays visible in `/costs` and reaches the normal native footer on the next executed tool result. Missing provider usage is reported as incomplete accounting, not zero cost.

```sh
npm run test:permissions --workspace=pi-security
node packages/pi-security/test/permissions-stock.mjs
```

The stock test uses an isolated agent directory and a scripted model, loads only this native package, executes stock read/Bash tools, and verifies blocking before a file write. It does not contact a provider or alter a running session. Rule/schema tests cover model output, approvals and accounting replay; they do not establish classifier judgment quality or kernel containment.
