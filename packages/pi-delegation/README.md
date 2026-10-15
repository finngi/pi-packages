# pi-delegation

Hand tasks to named agents that run as child Pi sessions. The extension finds agent definitions,
shows what each one can do, launches children over RPC, and routes messages and answers. It uses
`pi-background`'s process service when that is loaded, and its own otherwise.

## Agents

An agent is a Markdown file, or a bundle folder with its own private skills and files. Use `/agents`
to search agents, see their details and turn them on or off for this session. Ctrl+S saves project
defaults; Ctrl+Shift+S saves personal defaults for new sessions. Project defaults win, even an empty
selection. Resumed sessions keep explicit choices and refresh inherited defaults; `inherit` resets this session to saved defaults,
and nothing reloads Pi or stops children. Agents from packages are off until selected.
Each scope can also limit a resource to interactive TUI sessions. `/refresh` rereads defaults
without closing children; new children exclude saved interactive-only skills and instructions.

## What a child gets

- **Tools**: the parent's selected tools, including package tools, narrowed by the agent's `tools`
  list. Selecting agents never grants tools or permissions.
- **Skills**: saved personal and project skills plus all bundle skills by default. A named list
  picks from the bundle and Pi's loaded skills, `[]` picks none, and missing names produce a
  warning. Bundle skills and scripts stay private to the child.
- **Instructions**: the parent's static context files, with their source paths, then saved
  instruction choices, then the agent body. The parent's session-only choices are not passed on.
  Children do not look for `AGENTS.md` or `CLAUDE.md` themselves.
- **Model**: the agent's fixed model, or one the parent picks, for example
  `subagent({agent: "general-purpose", task: "…", model: "openai-codex/gpt-6-luna:low"})` when
  the agent has no `model` or sets `inherit`. Asking for a different model than a fixed one fails
  before launch. This does not change the permission classifier's model.
- **Login**: Pi's own auth, model and store files, with normal OAuth refresh and file locking. A
  private launch file carries the provider and model settings needed for models only the parent
  knows about; it carries no credentials or replacement stream adapter. Custom provider callbacks
  need their extension entrypoint in `PI_SUBAGENT_PROVIDER_EXTENSION`.

MCP connections are not passed to children. The capability preview says so, and asking for an MCP
tool fails before launch. Children never install packages or save defaults.

## Workspaces and files

Children work in a scratch directory by default; `workspace: "project"` works in the parent's
project. Both run with your normal user permissions. Closing or cancelling a child keeps its
scratch files. `discard` never deletes project edits. Receipts mark `scope` as
`scratch-collection` or `project-reference`, and `externalEffects` as `untracked`, because they do
not list everything a child did.

## Messages

`agent_message` takes `kind: "progress" | "question" | "message"` (default `message`). `progress`
goes only to the parent and never wakes it. Questions, messages and finished answers can. A receipt
means the message was accepted for delivery, not read or acted on.

## Permissions

With `pi-permissions` loaded, each child gets the parent's settings and your messages. The
classifier sees the child's task as the parent agent's words, not yours. Approval prompts from a
child appear in the parent's UI with the child's name. With no UI, a cancelled call or a stale
session, the call is blocked. The permission package checks calls; it does not sandbox processes.

## What lives here

Child start-up, provider settings for children, bundle and skill staging, and file collection are
part of this package. `pi-delegation/child-rpc` is the child's entrypoint, and
`pi-delegation/child-resources` prepares child resources without loading delegation. Resource
selection comes from `pi-resources` library subpaths, which do not turn on the resources
extension. From `pi-runtime` it uses only the shared process and accounting code.

## Related

[`pi-resources`](../pi-resources/README.md) adds `/skills`, `/packages` and parent skill filtering.
Child skills follow saved choices whether or not it is loaded. The parent can also pick resources
for a task with `session_setup({op: "list", query: "evidence"})` and `session_setup({op: "apply", ...})`,
and undo it with `session_setup({op: "reset"})`. That writes only a session entry. Tools change at
once; instruction and skill sections change on the next run.

- [Delegate work](../../docs/guides/delegation.md): agents, trust, messages, answers and files.
- [Tools](../../docs/reference/tools.md#delegation-tools) and [events](../../docs/reference/events.md).
- [Configuration](../../docs/reference/configuration.md#agent-and-skill-selection): agent fields.
- [Prompt context](../../docs/guides/prompts.md): the agent list and on-demand skills.
- [Architecture](../../docs/architecture.md) and [accounting](../../docs/accounting.md).
- [Session setup](../../docs/reference/tools.md#session-setup) and the
  [child tools decision](../../docs/decisions/native-child-tools.md).

## Tests

```sh
npm run test --workspace=pi-delegation
npm run typecheck --workspace=pi-delegation
```

Entrypoint: [extensions/subagent.ts](extensions/subagent.ts). See [testing](../../docs/testing.md)
for the Pi 1.2.0 integration tests.
