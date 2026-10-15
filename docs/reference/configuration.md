# Configuration reference

Native settings select executable packages. Session choices select their loaded guidance and tools. Agent definitions can narrow inherited tools and skills; workspace placement is not confinement.

## Native loading and permissions

Pi reads package sources from personal `~/.pi/agent/settings.json` and trusted project
`.pi/settings.json`. Temporary `-e SOURCE` packages apply to one invocation. Native package
filters and CLI exclusions remain authoritative. No custom launcher flags or sandbox environment
variables are needed.

`pi-permissions` is optional. Its user policy chooses off/manual/auto, ordered deny and allow
rules, and the classifier. Approved tools use ordinary host access. See the
[permission policy](../../packages/pi-permissions/README.md).

## Agent and skill selection

Agent packages declare `pi.agents`; instruction packages declare `pi.instructions`. Public skills
come from Pi's loaded native skill pool. Native `--no-skills` and package exclusions cannot be
reversed by session setup. Agent-private skills are prepared only for that agent.

Agent metadata supports `name`, `description`, `model`, `thinking`, `tools`, `skills` and
`conversation`. Omitted tools inherit available parent tools; an explicit list narrows them.
Omitted `skills`, `skills: "*"` or `skills: ["*"]` includes saved personal/project selections
plus all bundle-private skills. The parent's temporary selection is ignored. An explicit list
selects names from the bundle or Pi's available native skill pool; `skills: []` includes none.
Missing names produce warnings and are omitted. Use `"*"` alone. Bundle skills win name
collisions; otherwise keep Pi's native resolved winner.
A user-pinned model cannot be overridden by a launch argument; otherwise the parent can choose
an available model/thinking level per launch. See [delegation](../guides/delegation.md).

Saved `subagents.agents`, `subagents.skills` and `localContext.instructions` are sparse maps from
resource IDs to booleans. No entry means inherit; `true` and `false` are explicit choices.
New sessions resolve project → personal → native defaults. Session selections are separate native
history entries; resume restores the recorded selection rather than today's saved defaults.

All four resource pickers use the same controls: session toggles apply now, saved project/global
controls choose Inherit/On/Off, Ctrl+S snapshots eligible selections to project defaults, and
Ctrl+Shift+S snapshots them to personal defaults. A saved project On enables that resource in the
current session; other saved-scope changes leave session choices alone. Saving one resource does
not modify siblings. Personal defaults affect future sessions, and project overrides still win.

`session_setup` inspects, applies or resets registered guidance and active tools. It never installs
or reloads executable packages. See [tools](tools.md#session-setup).

## Local context settings

`pi-context` keeps project context (`AGENTS.md`, `AGENTS.local.md`) separate from selected behavior
snippets. Snippets come from resolved native package `pi.instructions` directories or explicit
project-local `.agents/instructions` files. Personal/global snippet libraries belong in packages,
not another directory catalogue. Frontmatter stays out of the model-facing body.

`--no-context-files` suppresses the overlay. Optional `localContext.autoGitIgnore` allows adding
local context files to the trusted repository's exclude file; it is off by default. Children
receive a snapshot of the parent's static context files and freshly rendered saved personal/project
instruction choices, followed by the agent body. Temporary parent instruction selections do not
carry over. Children do not rediscover unrelated context from their scratch directory. Saved
instruction bodies refresh at child launch; static context files refresh on the next parent run.
Already launched children retain their prepared snapshot.

## Goal evaluator settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `goal.evaluator.model` / `--goal-evaluator-model` | Required when goal evaluation is used | Selects an authenticated provider/model for separate goal assessment. |
| `goal.evaluator.timeoutSec` / `--goal-evaluator-timeout` | `30` seconds | Positive evaluator request timeout, up to 2,147,483.647 seconds. Failure stops automatic continuation. |

The evaluator receives the objective, fixed criteria, initial context, and an accumulating history of
worker messages and tool results. Edit or resume starts a new scoped history. See [goal evaluation](goals.md#evaluator-model-and-history).

## SDK embedding

Use the native resource loader, settings and ModelRuntime. Select extension packages explicitly;
library imports do not activate them. Context overlay suppression uses Pi's CLI argument because
that flag is not exposed to extension hooks in this SDK. A host that supplies `noContextFiles`
should also supply `--no-context-files` when it wants the overlay disabled.
