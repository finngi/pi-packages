# pi-delegation

Named-agent delegation for Pi. It discovers trusted definitions, previews effective capabilities, launches child Pi processes, and routes messages and correlated results. `pi-background` and security are optional. Without `pi-background`, the extension owns its child-process transport; it reuses an explicitly loaded background service when present. Selected or active security never falls back to host-permission execution after failure.

The default child workspace is scratch. Direct project work requires security disabled. Closing/cancelling retains ordinary scratch files before cleanup; direct project references are never deleted by `discard`. Receipts label `scope` as `scratch-collection` or `project-reference` and `externalEffects` as `untracked`; they do not list all worker effects.

`agent_message` accepts `kind: "progress" | "question" | "message"` (default `message`). Routine `progress` can only target the parent and never starts an idle parent turn; actionable questions/messages and completed results retain wakeups. A receipt confirms broker/RPC acceptance, not reading or acceptance of a revised task.

Agents can be flat definitions or directory bundles with private skills and relative resources. Children also receive the parent's eager static context files, with source origins; their workspace remains a separate setting. They disable their own `AGENTS.md` and `CLAUDE.md` discovery, so workspace and ancestor files do not silently add instructions. See [Delegate work](../../docs/guides/delegation.md) for discovery, skill precedence, and context inheritance.

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
filtering. Without it, native Pi skills remain available to children as usual. See
[Browse project resources](../../docs/guides/delegation.md#browse-project-resources).

Source entrypoint: [extensions/subagent.ts](extensions/subagent.ts). From the repository root, run `npm run test --workspace=pi-delegation` and `npm run typecheck --workspace=pi-delegation`. See [testing](../../docs/testing.md) for Pi 1.2.0 integration.

Parents can select an authenticated worker with `subagent({agent: "general-purpose", task: "…", model: "openai-codex/gpt-6-luna:low"})` when the definition omits `model` or sets it to `inherit`. An explicit definition model is a user pin; conflicting requests fail before launch. Worker-model selection does not change the security classifier. See [configuration](../../docs/reference/configuration.md#agent-definitions) and [permission review](../../docs/guides/delegation.md#permission-review-in-child-sessions).

Native [resource packages](../pi-runtime/README.md) add opt-in public skills and agents to the same
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
