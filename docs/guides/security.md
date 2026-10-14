# Configure security

`pi-security` confines model file and shell effects. The supported host configuration uses macOS Seatbelt, Pi 1.2.0, and Node 24. Delegation and search can run without this extension; when security is selected or actively loaded, failure must stop the operation. An unrestricted retry is not an automatic recovery path.

## Review a host policy

Copy [the host template](../../packages/pi-security/src/host-policy.json) to a trusted location outside model write authority, such as your Pi agent directory's `config/pi-security.json`. Review it before launch and set `PI_SECURITY_POLICY` to its absolute path. Without that setting, security reads `policy.json` in the selected agent directory. Project files do not select the policy.

The template starts in manual mode. It allows confined project toolchains, file tools, owned background and subagent controls, and goal tools. Search and other network integrations need explicit host grants. Set `resources.network` to `["*"]` to allow approval of arbitrary public hosts. Each sandboxed command receives its rule grants and approved additions; an explicit `"*"` grant covers public redirect destinations too. Unmatched effects ask the human UI; unavailable UI, cancellation, or timeout denies. Approval may grant extra write destinations for one call; explicit denials and child resource limits remain binding. Goal creation still requires its own explicit authorization.

Review these fields against the machine and project:

| Field | Review |
| --- | --- |
| `resources.write` | Default writable roots; `${project}` is the real starting directory; `${tmp}` is security's owned session temp |
| `resources.denyWrite` | Protect the agent directory, instruction stores, installed runtime, launcher, and extension/library sources, including custom state paths |
| `resources.denyRead` | Protect Pi/MCP auth files and credential directories; add nonstandard credential locations |
| `resources.network` | No network hosts are granted by default; enable integrations explicitly |
| `env.path` | Include trusted executable directories; the helper uses the host Node interpreter and resolves `rg` plus `fd`/`fdfind` only from these trusted directories |
| `classifier` | Authenticated model for automatic review |

The shell fetch proxy pins DNS answers to outbound sockets and rejects private, special-use, and unallocated addresses. IPv6 destinations must fall inside the reviewed [IANA global-unicast allocation snapshot](https://www.iana.org/assignments/ipv6-unicast-address-assignments); unlisted ranges remain denied until deliberately added.

`${agent}` is `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. The template contains generic credential and agent-directory protections; add installation-specific protected paths locally. The [example](../../packages/pi-security/src/example-policy.json) and [starter](../../packages/pi-security/src/starter-policy.json) policies are research fixtures with broader denials and classifier `none`; they are not a ready daily configuration.

## Launch from the checkout

Run from the repository root with the reviewed policy path:

```sh
PI_SECURITY_TRANSPORT=extensions \
PI_SECURITY_POLICY=/trusted/agent/config/pi-security.json \
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-extensions --no-builtin-tools --exclude-tools powershell \
  -e packages/pi-security/src/extension.ts \
  -e packages/pi-bg/extensions/background-process.ts \
  -e packages/pi-subagents/extensions/subagent.ts \
  -e packages/pi-local-context/extensions/context.ts \
  -e packages/pi-goal/extensions/goal.ts \
  -e packages/pi-codex-search/extensions/search.ts \
  -e builtin:tool-search \
  -e builtin:codemode \
  --security-mcp --security-codemode
```

Load security first. Omit optional extensions you do not need. `--no-builtin-tools` disables Pi's built-in default tools; excluding PowerShell also removes the unconfined executor from selection. Security registers `read`, `write`, `edit`, `ls`, `find`, `grep`, and `bash` as replacement tools; `ls`, `find`, and `grep` start inactive. In Pi 1.2.0, `--no-extensions` disables built-in extensions too, so this command explicitly loads `builtin:tool-search` for catalogue discovery and `builtin:codemode` for programmatic tool composition. `--security-codemode` activates the owned Pi codemode tool; a missing or substituted registration refuses initialization. Omit its entrypoint and flag if you do not want codemode.

Secured MCP is opt-in with `--security-mcp`; load it through the security adapter rather than a
second independent MCP extension. Without the flag, its configuration loader returns no servers.
With it, Pi's `/mcp` manager and tool catalogue remain in use. Servers must use HTTP(S), and each
endpoint must match `policy.resources.network`; a bare hostname allows ports 80 and 443, while
nonstandard ports require an exact `host:port` grant. Local stdio MCP is refused. Missing exposure
defaults to `deferred`, which requires `builtin:tool-search`. Explicit codemode exposure is supported
when codemode is selected; MCP configuration does not automatically activate codemode.

Security applies the regular per-tool manual/auto decision before issuing a one-use transport ticket.
A direct or codemode-nested MCP tool/resource operation must match the owned server, exact call ID,
method, and parameters. Redirects are refused.

Codemode runs JavaScript in Pi's QuickJS environment. Its `tools.*` calls use Pi's regular tool
pipeline, including security checks and confined file/shell helpers. Its `models.*` calls use Pi's
model machinery outside Seatbelt and do not have an individual permission-classifier gate. Enabling
codemode accepts that boundary; it does not make arbitrary model calls confined shell effects.


Pi's explicit OAuth challenge/helper fetches are limited to HTTP(S) hosts in `policy.resources.network`, the current admitted config generation, and `redirect: error`; embedded URL credentials are refused. The SDK's stored-token `token()` callback can still refresh against its saved issuer before the MCP transport ticket gate runs. That remains trusted Pi-owned authentication behavior, so this adapter does not claim complete OAuth-network confinement. Pi's CLI flag and MCP transport are pinned through the runtime dependency set documented in [testing](../testing.md).

## Choose resolver mode

The policy's `mode` applies unless the parent uses `--permissions manual` or `--permissions auto`. For automatic mode, configure an available classifier in `classifier.model` or select it with `--auto-mode-model`. `none` is not a usable classifier. Errors, missing credentials, timeout, invalid output, and uncertainty deny; they do not switch to human approval.

Hard deny decisions block without review. Allow rules skip the classifier unless the call requests
additional write destinations, network access or host execution; unmatched calls also need approval. Genuine user requests establish authority;
the worker's explanation and child task provide evidence for the exact call.

The classifier judges whether effects and targets match the request. A command that deletes the
exact directory the user requested can be allowed; the same deletion without a relevant request,
or a command that also deletes unrelated directories, is denied. Allowlisted reads may access
non-denied paths outside the project. For a write outside the default writable roots,
`write` and `edit` use their destination path; supply `permissions.write` for a shell command.
Approval grants the requested resources for that call or job. Network hosts must fit the configured ceiling: `"*"` allows approval of any public host, while an exact list limits approval to those hosts. See the [classification contract](../reference/security-policy.md#automatic-classification)
for evidence, output requirements and write-scope rules.

A child's resolver inherits or selects `auto`/`manual` independently of its write and network
limits. Manual requests reach the root human UI; automatic requests use the child classifier.
The worker model chosen through `subagent.model` does not change the security classifier. Headless execution does not itself select a different permission mode; an explicitly manual child forwards requests to the root UI.

## Run an approved command on the host

A nested CLI can need its normal authentication store, local IPC and state directories. Running
it inside another sandbox can prevent its own security controls from starting. A trusted launcher
can enable per-command host requests with `PI_SECURITY_HOST_CAPABILITIES=host-execution`.
Combine it with `gpu` as `gpu,host-execution` when both are needed on macOS.

The model requests this through the existing bash tool:

```json
{
  "command": "codex --no-daemon login status",
  "permissions": { "execution": "host" }
}
```

The request always goes through the selected manual or automatic approver, even when an allow
rule matches bash. Explicit action denials run first. Approval is bound to the exact arguments
and working directory. New genuine user input in the root session invalidates its pending approvals and unlaunched capabilities;
it does not stop an already running job. Already-launched automatic children retain their launch-time user-intent snapshot.

An approved host command runs with the current machine account's filesystem, network and IPC
access, outside Pi's per-command profile and fetch proxy. Any further confinement depends on the invoked program or harness. Ordinary authentication environment values and the machine PATH are retained (a configured `env.path` still takes precedence), while runtime injection and
Pi launch-control variables are removed. A nested Pi started from a child uses the default machine
agent directory rather than that child's isolated resource directory.

Do not combine `execution: "host"` with sandbox write or network grants: those grants would not
constrain the host command. File tools and ordinary bash calls remain sandboxed. Children inherit
the launch capability but cannot request host execution when their write or network limit is off.
A failed sandbox command is never automatically rerun on the host.

## Inspect decisions and failures

Use the checkout CLI to explain a command without executing it or calling a classifier:

```sh
PI_SECURITY_POLICY=/trusted/agent/config/pi-security.json \
  node packages/pi-security/src/cli.ts explain 'npm test'
```

It reports matching rule IDs, permissions, and profile. Fetch explanation uses diagnostic localhost port 65535 and does not start a proxy. Missing, malformed, or unknown-key policy blocks calls. Failed audit persistence also blocks subsequent effects. See [audit records](../reference/events.md#security-audit) for inspection through Pi session entries and RPC.

Runtime library and sibling extension directories are added to inherited write denials. macOS build profiles protect exact ancestors of existing instruction/configuration entries and explicitly denied paths, and deny protected-name creation. Unreadable or redirected directories fail compilation closed. Scanning large dependency/build trees can add launch latency.

Write-enabled sandbox profiles are prepared in a worker so filesystem inspection does not
block Pi's input or working indicator. Preparation uses the same profile compiler and checks
the filesystem on each launch; protected paths and their ancestor rules remain enforced.
Cancelling a shell request stops its pending preparation before execution.

On macOS, use `pgrep -fl 'PATTERN'` to inspect running processes. The profile permits
the system-monitor service used by `pgrep`; the command stays confined. macOS refuses
setuid executables such as `ps` and `top` inside Seatbelt even with an allow-all profile.
Signals to processes outside the command's sandbox remain restricted.

## Limits of confinement

- The internal background-process transport admits at most four active or starting jobs and keeps at most 32 job records. Starting a new job prunes the oldest completed records when needed; if no completed record can be pruned, admission fails. Optional command timeouts remain opt-in and are rejected above Node.js's maximum timer delay.
- Shutdown signals active jobs and waits for running work and pending launches to settle. If that
  bounded wait expires, related proxy and temporary-scope resources remain open until the work
  settles; a launch that never settles can retain them until Pi exits.
- File tools and sandbox-mode shell helpers are confined; explicitly approved host commands are outside those profiles; the Pi model client (including codemode `models.*`), trusted extension code, search HTTP adapter, SDK setup/output, and user `!` commands are outside those kernel profiles.
- Search revocation aborts the trusted HTTP transport and rejects stale results. This is an in-process capability boundary, not kernel network confinement.
- Child auth is a per-launch snapshot. Long-lived OAuth renewal and automatic transfer of custom provider callbacks are unavailable.
- Confined shell commands remove dynamic-loader override variables (`LD_*` and `DYLD_*`). Secured delegated Pi processes also remove those variables and Node bootstrap/module lookup overrides (`NODE_OPTIONS` and `NODE_PATH`) before Pi starts. Sandbox-mode shell commands filter common credential-shaped names, including API keys, tokens, secret keys, DSNs, database URLs, and credential-bearing Python package-index URLs. This name-based filter is not a complete secret scanner, so do not export project-specific secrets into the Pi process. GPU selectors and ordinary runtime settings remain available.
- Process groups clean up ordinary descendants, but do not contain deliberate daemon/session escapes.
- Linux currently supports read-only shell execution. Writable execution fails closed because Bubblewrap cannot safely enforce denials for paths created after launch beneath a writable project bind. Supporting writes while preserving those denials needs a copy-on-write workspace and trusted change integration. The Linux kernel tests verify read-only confinement and writable-mode refusal on a Linux host. The pinned Linux/container artifact still disables codemode; host activation does not update that artifact. Linux/container release closure and wall/shadow placement remain separate work. Compatibility stubs do not establish container enforcement or legacy reviewer-command parity. `--no-sandbox` requires preselected wall placement and never enables unconfined host execution.

For prerequisites and checks, see [testing](../testing.md). The [configuration reference](../reference/configuration.md) distinguishes supported host settings from research interfaces.

## Troubleshooting startup

Security initialization errors identify the failed check. Secured tools remain blocked until
initialization succeeds.

For registration errors, check whether another extension registers the named tools. Restart Pi
after changing installed extension code so the process loads the current version.

## GPU access

A trusted macOS development launcher can set `PI_SECURITY_HOST_CAPABILITIES=gpu` as its default.
No GPU policy field or model request is required. The backend grants the two measured Metal/MPS
permissions and retains file and network restrictions. Children inherit the capability snapshot.
See [host capabilities](../reference/security-policy.md#children-and-host-capabilities).
