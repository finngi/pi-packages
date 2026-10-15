# Get started

This walkthrough builds the checkout, defines one agent and starts a Pi session that can delegate
to it. Tools run with your normal user permissions. Add the
[permission package](../packages/pi-permissions/README.md) if you want calls checked first.

## 1. Build the checkout

Use Node 24. From the repository root:

```sh
node --version
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

The lockfile installs Pi 1.2.0 and the development tools. `npm run build` writes JavaScript and
type declarations for each package. Pi can also load the TypeScript entrypoints straight from the
checkout.

## 2. Define an agent

Create `agents/reviewer.md` in your Pi agent directory. That is `~/.pi/agent` unless you set
`PI_CODING_AGENT_DIR`.

```markdown
---
name: reviewer
description: Use to review a proposed change for correctness.
tools: [read, bash]
conversation: none
---
Review the assigned change. Report actionable findings with file paths and evidence.
```

The file name must match `name`. The `tools` list picks which tools the child gets; it is not a
sandbox. The child gets its task separately from these instructions. With `conversation: none` it
sees none of the parent's conversation, so the task must contain everything it needs.

Agents in a project directory only load once you trust that directory. Putting this one in your
user directory avoids that step. See [delegate work](guides/delegation.md) for project agents.

## 3. Start Pi

From the repository root:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-extensions \
  -e packages/pi-background/extensions/background-process.ts \
  -e packages/pi-delegation/extensions/subagent.ts
```

This runs the pinned Pi 1.2.0 from the checkout, whatever global `pi` you have installed.
`--no-extensions` turns off extension discovery and Pi's built-in extensions; the `-e` paths still
load. The parent keeps its default tools and gains the delegation tools.

An agent that asks for a tool the parent does not have is refused. If you pass `--tools` to limit
the parent's tools, include the delegation tools in that list.

Log in and choose a chat model the usual way. Children use the parent's model registry, so missing
credentials or an unavailable model stop the launch.

## 4. Delegate

Run `/agents` to see which agents were found and their settings. Then ask for something like:

> Use reviewer to inspect the proposed parser change. Give it the project path and the files to
> review. Ask for findings with source evidence.

The model calls `subagent` with the agent name and task. The reply gives the child's agent ID,
workspace, tools, skills, scope and request ID. It means the task was sent, not that it is done.
By default the child works in a scratch directory, but it can still read your files with the tools
it has.

The child can send progress or questions with `agent_message`. When it finishes, its answer is
delivered to the parent; you can also read it with `subagent_check`. Once you have reviewed the
answer, close the child with `subagent_close`. Closing keeps the files from its scratch directory
and tells you where they are.

Next, read [delegate work](guides/delegation.md) for project work and collected files. The
[tool reference](reference/tools.md) lists every parameter and limit.
