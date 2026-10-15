# Independent agents and instruction resources

Status: implemented in the native thin-slice candidate; no live runtime activation.

## Decision

Pi owns package installation, source/version resolution, project trust, model/provider access,
sessions, native skills, prompts, themes, tools and extension lifecycle. Agent bundles and eagerly
selected behavioural instructions are additional resource types read by these extensions. Their
files belong to the package that declares them; no particular authored checkout, user name,
`~/.config/agents` directory or generated symlink tree is required.

A package may live anywhere locally, or be installed from Git/npm through native `pi install`.
Pi records personal sources in `~/.pi/agent/settings.json`, project sources in
`<cwd>/.pi/settings.json`, and controls its own caches. Each declaration is relative to its own
package root, so the same contents work from a checkout or an installed package:

```json
{
  "name": "@example/research-resources",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": [],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "agents": ["./agents"],
    "instructions": ["./instructions"]
  }
}
```

`agents` and `instructions` are our extension metadata; they are not stock Pi resource types.
Native Pi continues loading the other four fields. A package containing only agents/instructions
needs no dummy extension or placeholder skill. Discovery asks Pi's package manager for configured,
already installed roots, skips sources Pi declined to load, and never installs anything itself.
Project package trust and native version checks remain in force.

An agent bundle is `agents/<name>/<name>.md`. Its private `skills/`, scripts and references stay
inside that bundle. Only explicitly public `pi.skills` paths are advertised to the parent.
Instruction files are Markdown under the declared directories; selected bodies enter a separate
`<instructions>` system-prompt section. Project `AGENTS.md` context remains separate.

## Selection ownership

`pi-resources` owns skill selection and the package picker. Keeping those inside delegation
would require child-process machinery merely to select guidance. `pi-delegation` owns agent
definitions, `/agents` and child execution; `pi-context` owns instructions and `/instructions`.
They explicitly share the existing runtime setup service, persistence helpers and browser library.
Package groups can be derived from any loaded provider, so context-only sessions can select
package instructions without loading the picker or delegation. Missing providers do not become
empty selections and package saves preserve their existing defaults. Session entry IDs and
settings keys are unchanged; this is an ownership split, not a data-format migration.

## Per-resource saved defaults

Whole-category selection arrays cannot express one inherited item beside an explicit Off item.
Saved resource keys therefore also accept sparse ID-to-boolean maps. The same resolver drives
skills, agents, instructions and package aggregates; missing IDs inherit from the next scope.
An empty map inherits all entries, while legacy empty arrays still mean an exact empty selection.
A row edit patches only its target IDs; an explicit bulk snapshot updates the known eligible rows
and removes stale unknown entries. Legacy conversion preserves known sibling values, including
ineligible rows that are not part of the edit. Session records remain the existing concrete
selections, so later defaults cannot rewrite resumed sessions. This uses the current settings files,
atomic writer, session service and native picker components, with no second override layer or store.

## What was reused and removed

- Kept native package discovery, the existing agent parser/private-skill loader, RPC dialogue,
  resource picker, instruction reader and persisted session selection. No replacement installer,
  catalogue registry, model client or session store was added.
- Extracted the existing bounded process manager into the pure `pi-runtime/processes` library.
  `pi-background` reuses it. Agents lazily create their own session-owned manager when no background
  service is loaded, with shutdown/exit cleanup. Loading agents does not activate background tools.
- Package selection expands only resource kinds whose providers are loaded. Agent/skill-only
  packages need no instruction extension, and receipts name the participating kinds. Missing
  providers are not enabled and their content is not claimed as selected.
- Moved the existing `session_setup` registration to the shared, explicitly installed setup
  service. Instructions can expose model-driven selection without loading agents. When agents
  are present they enrich successful setup receipts through Pi's native tool-result hook.
- Kept security selection fail-closed: an explicitly selected security service that is missing
  or fails is still an error. An absent security extension means ordinary host permissions.

The remaining common libraries are ordinary imports, not extension activation or global services.
No package needs a launcher-controlled runtime to discover resource files.

## Limits kept explicit

The native resource list does not enumerate a temporary `-e` package with no native resource
records. Pi's exported argument parser and native installed-path lookup provide those roots
without installing, scanning caches or saving settings. Only native loaded skills enter the
package group. A direct `-e` extension file does not cause a scan of its containing directory.

Existing explicit standalone directories remain supported; this change does not migrate user
settings or remove authored files. Installing/loading executable extensions remains a native Pi
operation. Resource selection does not unload hooks, install packages or change permissions.

## Verification

- Stock Pi with only agents: a real RPC child executes commands, uses a private skill and relative
  script, sends progress, writes files and returns an artifact receipt. Scratch and project modes
  are exercised without background jobs or security extensions.
- Stock Pi with only instructions: setup selection changes the prompt, preserves project context,
  and restores choices across resume, fork and tree navigation without rewriting settings.
- Native package fixtures exercise local, installed Git/npm custom-only roots, native skill
  filtering, project precedence, stale npm versions and private-resource boundaries.

See [Pi packages](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md)
and [extensions](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md).
