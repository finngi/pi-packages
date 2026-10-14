# Get started

This walkthrough builds the checkout and starts a parent Pi session with background transport and delegation. It uses ordinary host permissions. To confine model file and shell tools, follow [configure security](guides/security.md) before working on a project.

## 1. Build the checkout

Use Node 24. From the repository root:

```sh
node --version
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

The root lockfile supplies Pi 1.2.0 and the development dependencies. `npm run build` emits package JavaScript and TypeScript declarations; Pi can also load the TypeScript entrypoints directly from the Git checkout.

## 2. Define one agent

In your Pi user agent directory, create `agents/reviewer.md`. The default directory is `~/.pi/agent`; `PI_CODING_AGENT_DIR` selects another location.

```markdown
---
name: reviewer
description: Use to review a proposed change for correctness.
tools: [read, bash]
conversation: none
---
Review the assigned change. Report actionable findings with file paths and evidence.
```

The filename and `name` must agree. This definition selects reading and shell tools; it does not provide a filesystem sandbox. The child receives its assignment separately from these instructions. `conversation: none` means the assignment must include the context it needs.

Project agent definitions need directory trust. Using a user-directory definition keeps this walkthrough independent of project discovery; see [delegate work](guides/delegation.md) for project agents and trust.

## 3. Start Pi explicitly

From the repository root:

```sh
env -u PI_SECURITY_TRANSPORT -u PI_SECURITY_POLICY \
  node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-extensions \
  -e packages/pi-bg/extensions/background-process.ts \
  -e packages/pi-subagents/extensions/subagent.ts \
  --subagent-security=off
```

This calls the pinned Pi 1.2.0 CLI in the checkout. It does not depend on how a global `pi` command was installed. In Pi 1.2.0, `--no-extensions` disables automatic extension discovery **and built-in extensions**; explicit `-e` paths still load. The parent retains its default tools and activates these explicitly loaded extension tools. A definition requesting an inactive parent tool is refused. A `--tools` allowlist would also need to include the custom delegation tools.

Authenticate and select an available chat model using Pi's normal setup. Delegation resolves that model through the parent's model registry. Missing credentials or an unavailable model refuse launch.

## 4. Browse and delegate

Run `/agents` to inspect discovery and effective settings. Then give the main agent a complete assignment, for example:

> Use reviewer to inspect the proposed parser change. Give it the project path and the files to review. Ask for findings with source evidence.

The model calls `subagent` with the definition name and task. The acknowledgement reports the running agent ID, workspace, effective tools, scope, and request ID. It confirms dispatch, not completion. The default workspace is scratch; a child launched without security can read host files using its selected tools.

A child can send progress or questions through `agent_message`. Its completed response is delivered to the parent, or can be read with `subagent_check`. Close it with `subagent_close` when the parent has reviewed the response. Closing retains ordinary scratch files and returns their artifact location.

Continue with [delegate work](guides/delegation.md) for project work and artifact collection, or [configure security](guides/security.md) for a confined session. Exact calls and limits are in the [tool reference](reference/tools.md).
