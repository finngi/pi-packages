# pi-delegation

Named-agent delegation for Pi. It discovers trusted definitions, previews effective capabilities, launches native child Pi sessions over RPC, and routes messages and correlated results. Without `pi-background`, the extension owns its child-process transport; it reuses a loaded background service when present.

The default child workspace is scratch. `workspace: "project"` uses the parent project directly. Both run with ordinary host permissions. Closing/cancelling retains ordinary scratch files before cleanup; direct project references are never deleted by `discard`. Receipts label `scope` as `scratch-collection` or `project-reference` and `externalEffects` as `untracked`; they do not list all worker effects.

`agent_message` accepts `kind: "progress" | "question" | "message"` (default `message`). Routine `progress` can only target the parent and never starts an idle parent turn; actionable questions/messages and completed results retain wakeups. A receipt confirms broker/RPC acceptance, not reading or acceptance of a revised task.

Agents can be flat definitions or directory bundles with private skills and relative resources.
Children use saved personal/project guidance plus their bundle, never temporary parent guidance
selections. Omitted skills or `skills: "*"` includes saved skills and all bundle skills; a named list
selects native/bundle matches, `[]` selects none, and missing names warn and are omitted. Children also receive the parent's eager static context files, with source origins; their workspace remains a separate setting. They disable their own `AGENTS.md` and `CLAUDE.md` discovery, so workspace and ancestor files do not silently add instructions. See [Delegate work](../../docs/guides/delegation.md) for discovery, skill precedence, and context inheritance.

- [Delegate work](../../docs/guides/delegation.md): definitions, trust, conversation, messaging, and retained files.
- [Tool reference](../../docs/reference/tools.md#delegation-tools) and [events](../../docs/reference/events.md): exact calls and delivery contracts.
- [Prompt context](../../docs/guides/prompts.md): capability summaries, optional skills, and conversation-based running state.
- [Architecture](../../docs/architecture.md): parent/child processes and imported library code.
- [Accounting](../../docs/accounting.md): all-call usage and estimates.

Use `/agents` to search available definitions with BM25, inspect the side panel,
and toggle choices for this session. Ctrl+S saves this category as project defaults;
Ctrl+Shift+S saves personal defaults for new sessions across projects. Project defaults take
precedence over personal defaults, including an empty selection. Existing sessions retain their
recorded choices on resume. `inherit` resets only that category to saved defaults; it does not
remove project settings. Selection does not reload Pi or stop children. The optional
[`pi-resources`](../pi-resources/README.md) extension owns `/skills`, `/packages` and parent skill
filtering. Child skill defaults use saved personal/project choices, independently of the parent
session selection, whether or not the picker extension is loaded. See
[Browse project resources](../../docs/guides/delegation.md#browse-project-resources).

Source entrypoint: [extensions/subagent.ts](extensions/subagent.ts). From the repository root, run `npm run test --workspace=pi-delegation` and `npm run typecheck --workspace=pi-delegation`. See [testing](../../docs/testing.md) for Pi 1.2.0 integration.

Parents can select an authenticated worker with `subagent({agent: "general-purpose", task: "…", model: "openai-codex/gpt-6-luna:low"})` when the definition omits `model` or sets it to `inherit`. An explicit definition model is a user pin; conflicting requests fail before launch. Worker-model selection does not change the optional permission classifier. See [configuration](../../docs/reference/configuration.md#agent-definitions) and [permission review](../../docs/guides/delegation.md#permission-review-in-child-sessions).

Native [resource packages](../pi-resources/README.md) add opt-in public skills and agents to the same
pickers. Package agents are inactive when selection is omitted; their bundle-owned skills and scripts
remain child-private. Selection does not grant tools or permissions. Existing native skill package
loading is unchanged.

For package and skill selection, load [`pi-resources`](../pi-resources/README.md) explicitly.
Delegation contributes its available agent definitions to the shared setup service; it does not
own package installation, package browsing or parent skill filtering.

For a task-specific selection, the parent can use
`session_setup({op: "list", query: "evidence"})`, then `session_setup({op: "apply", ...})`.
This writes only a native session entry: resume restores it, while new sessions use saved defaults.
`session_setup({op: "reset"})` removes the override. Tools change immediately; selected instruction
and skill prompt sections change on the next run. See [session setup](../../docs/reference/tools.md#session-setup)
for package expansion, exact IDs, validation and the distinction between selection and permissions.

Children inherit selected native package tools through their registered source paths.
An explicit agent tool list narrows that selection. Native Pi still loads extensions, filters tools,
resolves authentication and owns RPC; children do not install packages or save defaults. See
[child tool selection](../../docs/guides/delegation.md#use-private-skills-and-scripts) and the
[launch decision](../../docs/decisions/native-child-tools.md) for the boundaries.

Children resolve credentials through Pi's native auth/models/store files, including OAuth refresh and file locking. A private launch file carries native provider/model configuration needed to preserve parent-only models and headers; it carries no resolved credential fallback or replacement stream adapter. Executable provider callbacks require their trusted native extension entrypoint through `PI_SUBAGENT_PROVIDER_EXTENSION`.

The optional `pi-permissions` package contributes its own native entrypoint, initialized policy and genuine root-user messages to a child launch. Child task text stays separate from user authorization. Manual child selections use native RPC and are shown through the parent's approval UI with the child name; a headless parent, cancellation or stale session refuses the request. The package gates visible tool calls and provides no OS confinement.

Live MCP connections are not transferred to children. The capability preview states this limit; requesting an unavailable MCP tool fails before launch. Native child extension entrypoints are supported.

Child bootstrap, native provider configuration, bundle/skill staging and artifact retention are
owned here. `pi-delegation/child-rpc` is the prepared child entrypoint;
`pi-delegation/child-resources` exports resource preparation without activating delegation.
Resource selection imports use `pi-resources` library subpaths; importing them does not enable
the resources extension. Shared `pi-runtime` helpers are limited to processes and accounting.
