# Configuration reference

Trusted host configuration selects the extension set and policy. Agent metadata selects resources within the current parent authority; it cannot enlarge a secured child's filesystem or network scope.

## Security selection and launch

| Setting | Values / default | Effect |
| --- | --- | --- |
| Load `pi-security` | Optional extension | Active presence requires security for delegation/search even if initialization fails |
| `PI_SECURITY_TRANSPORT` | `internal` default in security; `extensions` for `pi-background` | Selects security's shell transport; `extensions` routes secured bash through `pi-background` and also requires the security service for delegation/search |
| `--subagent-security` | `required` or `off`; defaults to required with selection/presence, otherwise off | `required` refuses unavailable/duplicate service; `off` refuses an already secured parent |
| `PI_SECURITY_POLICY` | Absolute host-selected path; otherwise agent directory `policy.json` | Reviewed trusted policy; missing/malformed/unknown keys refuse |
| `PI_CODING_AGENT_DIR` | Default `~/.pi/agent` | User agent resources, settings, auth, and retained results |
| `--permissions` | Supported parent overrides: `manual`, `auto`; otherwise policy mode | Session resolver selection, without widening child authority |
| `--auto-mode-model` | Authenticated classifier ID | Overrides configured classifier selection |
| `--security-codemode` | Explicit opt-in | Activates the owned Pi `builtin:codemode`; requires its entrypoint and preserves the unconfined `models.*` boundary. |
| `--security-mcp` | Explicit opt-in | Enables the security-composed HTTP(S) MCP configuration. |
| `--no-builtin-tools` | Pi 1.2.0 CLI option | Suppresses built-in tools by default; security registers replacement effect tools |
| `--exclude-tools powershell` | Pi 1.2.0 CLI option | Excludes unsupported unconfined PowerShell; security also blocks its execution |
| `--no-extensions` | Pi 1.2.0 CLI option | Disables discovery and built-in extensions; explicit `-e` paths still load |

Children launched without security have host permissions. The workspace selector defaults to scratch; project mode is allowed only when security is disabled. See [workspace semantics](../architecture.md#workspaces-and-private-configuration).

Source: [launch selection](../../packages/pi-delegation/extensions/subagent.ts), [security options](../../packages/pi-security/src/compatibility.ts), [initialization](../../packages/pi-security/src/extension.ts), and [search selection](../../packages/pi-codex-search/extensions/search.ts).

### Protected launch and research settings

| Setting | Scope |
| --- | --- |
| `PI_SECURITY_TMP` | Trusted session temp input, canonicalized and set to private permissions |
| `PI_SUBAGENT`, `PI_POLICY_LAUNCH`, `PI_SECURITY_CHILD_AUTH`, `PI_CHILD_AUTH` | Prepared child identity/policy/authentication inputs; not model parameters |
| `PI_SUBAGENT_CONTEXT`, `PI_SUBAGENT_SECURITY` | Bound security-off communication context |
| `PI_SECURITY_CHILD_FIXTURE_EXTENSION`, `PI_SUBAGENT_FIXTURE_EXTENSION` | Trusted host test hooks for scripted providers; never model input |
| `PI_SECURITY_ACTIVATION` | `active` default; `shadow` is a research interface |
| `PI_SECURITY_PLACEMENT` | `host` default; `wall` is a research/integration interface |
| `--no-sandbox` | Requires preselected wall placement; never an unrestricted host fallback |

Shell execution strips launch-control variables. Private child auth files are protected from secured model effects; security-off private paths do not override host privileges. Wall/shadow options and compatibility services do not establish released container enforcement.

## Agent definitions

Definitions are flat Markdown files in user `agents/` or trusted ancestor `.pi/agents/` and `.agents/agents/`, or directory bundles whose entrypoint is exactly `<name>/<name>.md`. The entrypoint `name` must match that directory. Nested Markdown files are resources, not agent definitions. Frontmatter is metadata; only the entrypoint body becomes child agent instructions.

| Field | Format / default | Validation and behavior |
| --- | --- | --- |
| `name` | Required nonempty string | Must match filename without `.md` |
| `description` | Required nonempty string | Shown in the launch catalogue |
| `targets` | Optional list/string of `pi`, `claude` | Only definitions targeting Pi are offered to Pi |
| `model` | Omitted/`inherit`, bare alias, or `provider/id[:thinking]` | Resolves against authenticated chat models; unavailable model refuses before spawn |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Inherits when omitted; explicit value overrides model suffix and must be supported |
| `tools` | Optional list or comma-separated string | Only `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`; must be active in parent |
| `skills` | Optional list or comma-separated string | For flat agents, names must exist uniquely in Pi's selected skill registry. For bundles, names may also select skills discovered under that bundle; a bundle skill wins same-name collisions |
| `permissionMode` | `auto`, `manual`, `full-access`, `dangerously-unrestricted` | Secured launch accepts `auto`/`manual`; off launch reports full host access |
| `conversation` | `none`, `all`, or positive integer | Default and ceiling for parent transcript sharing |

An omitted tools list inherits the parent's permitted tools. An omitted skills list inherits selected public skills and, for a bundle, adds all bundle skills; explicit `skills: []` selects none. An explicit skill list narrows across public and bundle skills. Private bundle skills are shown to the child only and are never added to the parent's skill catalogue. Communication tools are installed separately. Duplicate/invalid names, collisions, ignored trust levels, user overrides and bundle-resource warnings appear in `/agents`; a skill warning does not make its agent unavailable. A model alias is matched against authenticated models available to Pi; an explicit provider/ID pin requires an exact match. If `model` is omitted or set to `inherit`, the parent may select a child model through `subagent.model`; without a per-launch selection, the child uses the parent’s selected model. An explicit agent-definition model is a user choice: conflicting per-launch requests fail with the configured and requested models in the error. If an explicit model is unavailable or unauthenticated, launch is refused; there is no ordered fallback list or automatic fallback to the parent.

Bundle contents are staged as ordinary files with write bits removed, while source execute bits are retained so relative scripts continue to work. A child-only `<agent_bundle path="…" />` instruction gives the staged root for supporting paths in the agent body; skill-relative paths use the advertised `SKILL.md` directory. Selected skills expose metadata and locations through Pi's native catalogue, without inserting their bodies eagerly. Private resources need no parent registration; an explicit public export is independently selectable. Links that resolve within the bundle are copied as ordinary files; links escaping the bundle are refused, and `.git` metadata is omitted. File modes help prevent accidental edits but are not a security boundary when the child runs with the same user privileges. Resource staging does not change the child's writable workspace or expand filesystem/network permissions.

Conversation defaults to `none` when neither definition nor call chooses a setting. A definition of `none` forbids sharing; numeric N allows at most N user turns; `all` permits caller narrowing. A call can reduce the scope but cannot exceed its ceiling. Only user/assistant text is shared, including the triggering user turn in the count; image-only user messages count as turns without contributing text. Thinking, tools/results, and extension messages are excluded.

Sources and checks: [parser and discovery](../../packages/pi-delegation/lib/subagent/agents.ts), [setting resolution](../../packages/pi-delegation/lib/subagent/settings.ts), [conversation](../../packages/pi-delegation/lib/subagent/context.ts), and [resource validation](../../packages/pi-runtime/src/child-resources.ts).

### Resource selection

The parent can overlay these choices with [`session_setup`](tools.md#session-setup). That override
is stored in session history, not `.pi/settings.json` or user settings. It takes precedence for
selected skills, agents and instruction snippets until reset. Project `AGENTS.md` and local context
files still provide project context independently. Tool selection uses Pi's native session API;
it does not change tool registration, model pins or security policy.

| Setting or command | Behavior |
|---|---|
| Global `subagents.agents` | Saved agent choices: an ID-to-boolean map (`true` On, `false` Off); omitted IDs inherit native agent defaults. Legacy exact lists remain readable. |
| Project `subagents.agents` | Per-agent overrides in trusted `.pi/settings.json`; omitted map IDs inherit personal defaults. Legacy lists, including `[]`, remain exact selections. |
| Project `subagents.skills` | Per-skill On/Off overrides for parent visibility and child inheritance; omitted map IDs inherit personal defaults, then Pi's native selection. |
| Project `subagents.skillPaths` | Extension-maintained paths added to the native project skill list for selected catalogue skills. The `/skills` commands use this ownership list, plus a creation marker, to remove only paths and settings they added. |
| Global `resources.skillCatalogues` | Paths to skill directories offered by `/skills`; these are discovery roots and do not load skills into the model. |
| Global `subagents.skills` | Personal per-skill defaults as an ID-to-boolean map; omitted IDs inherit Pi's native selection. Legacy exact lists remain readable. |
| Ctrl+S in a resource picker | Saves project defaults; individual pickers save one category and `/packages` saves guidance categories whose providers are loaded; absent categories are preserved. |
| Ctrl+Shift+S in a resource picker | Saves personal defaults for new sessions across projects; project-only resources are excluded and project defaults still take precedence. |
| Project `skills` | Pi's native list of skill paths. pi-resources writes paths here when a selected standalone skill must be loaded; Pi can still auto-discover other project and user skills. |
| `/agents` and `/skills` | Interactive session selectors; `enable NAME`, `disable NAME`, `none`, `all`, and `inherit` are also accepted. Selection updates lookup immediately without reloading. |
| Global `resources.instructionCatalogues` | Trusted directories of Markdown instruction snippets offered in `/instructions`. |
| Global/project `localContext.instructions` | Personal and project instruction choices as ID-to-boolean maps. Omitted project IDs inherit personal choices; omitted personal IDs use native defaults (local snippets on, package/library snippets off). |
| `/instructions` | Search and select trusted global snippets and project `.agents/instructions` snippets. Changes apply to this session; saving defaults is explicit. |

Effective selection is the recorded session choice. New sessions resolve each resource through project override, personal override, then its native default. New sessions record their starting resource choices in native session history; resume and branch navigation restore those choices even if defaults changed later. Project context files remain independent. `inherit` resets one session category to saved defaults without deleting project settings. Agent selection filters the prompt catalogue and launch lookup. Skill selection filters the parent model's skill prompt, public skills inherited by children and manual `/skill:name` invocation. Private bundle skills remain child resources. Neither selection nor saving defaults reloads Pi or stops children.

Saved scope controls offer **Inherit**, **On** and **Off**. Project Inherit follows the personal
choice; Global Inherit follows the resource's native default. The Session control is the actual
ON/OFF membership. Clicking a saved scope (or pressing `p` / `g`) opens the same three-choice menu
in every picker. Project On also enables that item in this session; Project Off/Inherit and all
Global edits leave the session choice alone. Package controls apply only to the package's members;
MIXED means their saved choices differ.

A row edit changes only that resource's saved override. Ctrl+S and Ctrl+Shift+S deliberately
snapshot eligible known session choices to project or personal defaults. Snapshots can clear stale
choices, preserve known ineligible rows, and leave unloaded resource categories untouched.
Unavailable IDs in sparse maps stay stored but dormant; they cannot load or advertise resources.
Existing exact arrays remain readable. On the first saved edit, a legacy array becomes a map
preserving currently known On/Off choices; resources discovered later inherit their lower-scope
default. Resource selection stays separate from Pi's top-level `skills` path list.

For example, a user settings file can keep the default model catalogue small while allowing project opt-in:

```json
{
  "skills": [],
  "resources": { "skillCatalogues": ["~/.config/agents/skills"] },
  "subagents": {
    "agents": { "general-purpose": true, "reviewer": false },
    "skills": { "writing-instructions": true }
  }
}
```

`resources.skillCatalogues` is read from personal settings only. It exposes metadata in `/skills`; files are registered through Pi's resource-discovery hook and their bodies remain lazy. Only an explicit project save writes selection names and any necessary extension-owned native paths. Native package filters and unrelated paths are preserved.

## Local context settings

| Setting | Default | Effect |
| --- | --- | --- |
| `resources.instructionCatalogues` in global settings | `[]` | Catalogue directories offered by `/instructions`; `~` expands to the user home directory |
| `localContext.instructions` | Omitted | Selected snippet IDs; global defaults apply unless trusted project settings provide an override. `[]` selects none. |
| `localContext.autoGitIgnore` in agent directory `settings.json` | `false` | Allows validated personal Git exclude updates with saved repository and current project trust |
| `-nc`, `--no-context-files` | Overlay enabled when absent | Disables local/selected overlay by argv check |
| `-na`, `--no-approve` | Absent | Prevents the optional Git exclude write |
| `PI_SUBAGENT` | Unset in parent | Prevents the optional Git exclude write in children |

`/instructions` changes session choices without rewriting context files. Ctrl+S saves project defaults;
Ctrl+Shift+S saves personal defaults for new sessions. Project-only snippet choices are excluded
from personal saves. Recorded choices survive resume; source bodies refresh before each turn.
Project overlays require trust; personal selected snippets remain available when project settings
are untrusted. `--no-context-files` suppresses both.

The overlay follows Pi's context-file walk, worktree shadowing, and canonical deduplication. Native context and `AGENTS.local.md` stay in `<project_context>`; selected snippet bodies appear with source paths in the separate native `<instructions>` section, after any caller-supplied content in that section. The labels do not establish instruction precedence. Leading closed frontmatter is removed from eager prompt content; source/read output and lazy skills remain intact. A child receives the parent's final static project files with the original project path and the known `instructions` section separately; its writable workspace is disclosed separately. The combined snapshot is limited to 512 KiB. The child disables its own Pi context-file discovery, including files from its agent directory, workspace, and ancestors. Other parent sections are not copied, and conversation text still follows the explicit `conversation` setting. See [delegation](../guides/delegation.md) and the [local context guide](../guides/context.md).

An SDK `forceSystemPrompt` override stays opaque in the parent and suppresses structured rendering.
Child inheritance still snapshots configured static resources; it does not copy that opaque prompt.

## Goal evaluator settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `--goal-evaluator-model` | Required when goal evaluation is used | Selects an authenticated provider/model for separate goal assessment. |
| `--goal-evaluator-timeout` | `30` seconds | Positive evaluator request timeout, up to 2,147,483.647 seconds. Failure stops automatic continuation. |

The evaluator receives the objective, fixed criteria, initial context, and an accumulating history of
worker messages and tool results. Edit or resume starts a new scoped history. See [goal evaluation](goals.md#evaluator-model-and-history).

## Policy schema and SDK embedding

Policy files use `version: 2`, approval mode, resources, classifier settings, optional environment settings, and ordered deny/allow action rules. Each rule requires `tool`; `match` and diagnostic `id` are optional. Write and network permissions are independent; modes choose the approver without changing authority. Runtime validation is authoritative; TypeScript types alone do not admit effects. Use [host-policy.json](../../packages/pi-security/src/host-policy.json), [policy validation](../../packages/pi-security/src/policy.ts), and [types](../../packages/pi-security/src/types.ts) for exact keys. The [policy reference](security-policy.md) describes policy fields and enforcement; current source validation controls supported behavior.

An SDK host must select peers, extensions, tools, trusted policy, and resource-loader options explicitly. Align its process working directory with its session working directory before loading security tool factories. Policy initializes with `ctx.cwd`, while effect-tool factories capture `process.cwd()`; inconsistent directories can resolve relative tools differently. See [SDK embedding](../guides/distribution.md#embed-with-the-pi-120-sdk).
