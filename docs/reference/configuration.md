# Configuration

Pi's settings decide which packages load. Session choices decide which of their resources and
tools are used. Agent files can narrow the tools and skills a child gets. Where a child works does
not limit what it can access.

## Package loading

Pi reads package sources from personal `~/.pi/agent/settings.json` and trusted project
`.pi/settings.json`. `-e SOURCE` adds a package for one run. Pi's package filters and CLI
exclusions always apply.

## Permissions

`pi-permissions` is optional. The `permissions` key in personal settings sets the mode (`off`,
`ask` or `auto`), allow and deny rules, and the classifier model. `/permissions` changes the mode
for one session. See [the package README](../../packages/pi-permissions/README.md).

## Agent and skill selection

Agent packages declare `pi.agents` and instruction packages declare `pi.instructions`. Public
skills come from the skills Pi loaded. Session setup cannot undo `--no-skills` or package
exclusions. Agent-private skills are prepared only for that agent.

Agent front-matter fields:

| Field | Meaning |
| --- | --- |
| `name` | Agent name; must match the file name |
| `description` | When to use the agent |
| `model` | A fixed model the parent cannot override. Without it, the parent can choose a model and thinking level per launch |
| `thinking` | Default thinking level |
| `tools` | Omitted: the parent's available tools. A list narrows them |
| `skills` | Omitted, `"*"` or `["*"]`: saved personal and project skills plus all bundle skills. A list picks names from the bundle or Pi's loaded skills. `[]`: none |
| `conversation` | Default and maximum share of the parent conversation: `none`, `all` or a number of turns. Omitted: a launch can ask for any amount and shares none by default |

For `skills`, the parent's session choices are ignored. Missing names are skipped with a warning.
Use `"*"` on its own. A bundle skill wins a name clash; otherwise Pi's choice stands. See
[delegation](../guides/delegation.md#choose-a-childs-skills).

## Saved defaults

`subagents.agents`, `subagents.skills` and `localContext.instructions` are maps from resource ID to
`true` or `false`. A missing ID inherits; `true` and `false` are explicit. New sessions look at
project settings, then personal settings, then Pi's default. Explicit session overrides are separate
entries in the session history. Resume retains those overrides and rereads today's
defaults for choices still set to Inherit. An active session does not poll for default changes.

All four pickers work the same way:

- Toggles change the session now.
- Each resource's Session, Project and Global controls can be Inherit, On or Off.
- Ctrl+S copies eligible On/Off selections to project defaults; Ctrl+Shift+S copies them to personal
  defaults. Bulk saves do not write session types.
- Editing a saved scope rereads this session's defaults, preserving its explicit session choices.
- Saving one resource does not change other rows or scopes. Other running sessions retain their
  defaults until resumed.
- `/skills` and `/agents` `enable NAME`, `disable NAME`, `all` and `none` set per-item session
  choices, so other rows keep inheriting.

Session type is independent of On/Off and is saved only at Project or Global scope. Choose
**Interactive only** to limit a resource to the TUI, **Any session** to include headless/RPC
sessions, or **Type: Inherit** to use the broader scope.
Saved types use `resourceSessionTypes.skills`, `.agents` and `.instructions`, with resource IDs
mapped to `"any"` or `"interactive"`. For example, in personal settings:

```json
{
  "subagents": { "skills": { "communication": true } },
  "resourceSessionTypes": { "skills": { "communication": "interactive" } }
}
```

This selects the skill globally for interactive sessions. If a saved value is invalid, only that
category falls back to Pi's defaults, with a warning. Delegated children use saved guidance
with the headless session-type filter; the parent's temporary overrides do not pass down.

`session_setup` inspects, applies or resets guidance and active tools. It never installs or reloads
packages. See [tools](tools.md#session-setup).

## Package availability

Native `packages` entries register sources in personal or project Pi settings. Registration loads
extensions and discovers allowed resources. It is separate from the picker choices:

```json
{
  "resourcePackages": { "personal-general": true, "personal-interactive": true },
  "resourceSessionTypes": { "packages": { "personal-interactive": "interactive" } }
}
```

An enabled package exposes resources for individual selection; it does not select all of them.
The setting above exposes the general package in every session type and interactive assets only
in TUI sessions. Interactive extension code should also use Pi's `ctx.mode === "tui"` guard;
resource session types do not unload JavaScript. Package availability never changes which
extension code loads.

Delegated children follow the saved package choices, treated as headless: the interactive package
above stays out of every child. Package skills with no saved choice stay off, as in the parent, and
an agent's `skills` list cannot bring in a skill from a hidden package; the launch warns instead.
Session-only package choices do not pass to children. If `resourcePackages` is invalid, every
package stays available and Pi shows a warning, like other invalid categories.

## Local context settings

`pi-context` keeps project context (`AGENTS.md`, `AGENTS.local.md`) apart from selected snippets.
Snippets come from package `pi.instructions` directories or the project's `.agents/instructions`
files. Personal snippet libraries should be packages, not another folder. Front-matter is removed
from what the model sees.

| Setting | Default | Effect |
| --- | --- | --- |
| `--no-context-files` | Off | Turns off local files and selected snippets |
| `localContext.autoGitIgnore` | `false` | Adds local context files to the trusted repository's personal exclude file |

Children get a copy of the parent's static context files and fresh saved instruction choices,
followed by the agent body. The parent's session-only choices are not passed on, and children do
not pick up context from their scratch directory. Saved snippet text is read at child launch;
static context files refresh on the next parent run. Running children keep their copy. See
[local context](../guides/context.md).

## Goal evaluator settings

| Setting | Default | Effect |
| --- | --- | --- |
| `goal.evaluator.model` / `--goal-evaluator-model` | None; required to use goals | Logged-in provider/model that assesses the goal |
| `goal.evaluator.timeoutSec` / `--goal-evaluator-timeout` | `30` seconds | Request timeout, up to 2,147,483.647 seconds. A timeout stops automatic work |

The command-line flag wins over the setting. The evaluator gets the objective, criteria, original
request and a growing history of the worker's messages and tool results. Editing or resuming starts
a new history. See [goal evaluation](goals.md#evaluator-model-and-history).

## SDK embedding

Use Pi's resource loader, settings and ModelRuntime. Load extension packages explicitly; importing
a library does not load them. To turn off `pi-context`'s local files, pass `--no-context-files` in
the host arguments too, because extensions cannot see the SDK's `noContextFiles` option.
