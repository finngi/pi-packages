# Package design

A Pi package is the unit you install and load. A resource package is an ordinary Pi package that
holds skills, agents and instructions, with one `package.json`. The `pi.agents` and
`pi.instructions` fields are ours; stock Pi ignores them.

## Use Pi's packaging

Pi already resolves npm, Git and local sources, applies personal and project precedence and
resource filters, installs dependencies and reloads extensions. We use that instead of a second
manifest, catalogue or installer. The list of public skills comes from what Pi actually loaded,
so package filters and CLI exclusions still apply.

Agents and instruction snippets need custom code because Pi has no matching resource types. That
code is a small reader for the two extra fields. If Pi adds equivalent types, we should switch.

Configured packages and `-e` packages can contain only agents or instructions. For `-e` sources,
Pi's own argument parser and installed-path lookup give us the package roots, so we never rebuild
cache paths or source identities. Only skills Pi loaded are grouped, so Pi's exclusions win. If an
`-e` copy and a configured copy share a package name, the `-e` copy wins. Discovery never installs
code or changes settings.

Pi 1.2's code accepts the temporary lookup scope even though its exported TypeScript type leaves
it out. Stock-Pi tests cover this call.

## How packages are found

Pi reads `packages` from personal `~/.pi/agent/settings.json` and, in a trusted project,
`.pi/settings.json`. A source can be npm, Git or a local path. Relative paths resolve from the
settings file that declares them. A project entry overrides a personal entry for the same package;
with `autoload: false` it applies the project's filters to the personal entry instead. Pi handles
identity, installation and filters. We read the resolved roots and never search other directories
or install missing packages.

`/packages` lists packages that provide skills, agents or instructions. A package with only
extensions still loads, but has nothing to select there. Packages passed with `pi -e SOURCE` are
grouped too, with no project registration or extra profile needed.

## Package layout

Pi supports `extensions/`, `skills/`, `prompts/` and `themes/` directories, or explicit path
arrays under `package.json` `pi`. Pi's arrays accept globs and exclusions. Include only the
directories you need. Our `pi.agents` and `pi.instructions` fields take arrays of relative
directories, without globs.

```text
research/
├── package.json
├── skills/check-evidence/SKILL.md
├── agents/evidence-verifier/evidence-verifier.md
├── agents/evidence-verifier/skills/verify-claims/SKILL.md
└── instructions/evidence-attribution.md
```

The `agents/` layout is our bundle convention, not a Pi resource type. Skills inside a bundle are
private to that agent and are not added to the parent's skills.

```json
{
  "name": "@example/research",
  "version": "0.1.0",
  "description": "Research and independent verification",
  "pi": {
    "extensions": [],
    "skills": ["skills"],
    "agents": ["agents"],
    "instructions": ["instructions"]
  }
}
```

This example has no extension code. A package with `pi.extensions` runs JavaScript or TypeScript
when Pi loads it, and that code can register tools, commands and event handlers. npm libraries it
imports are ordinary dependencies. Selecting a package's guidance does not turn its code on or off.

MCP is separate. Pi has no `pi.mcp` field: you configure servers in personal or project `mcp.json`
and manage them with `/mcp`. An extension could add its own integration, but a manifest never
installs MCP servers. The picker shows guidance separately from code loading and permissions.

## Selecting guidance is not loading code

`session_setup` runs only in the parent. Its `packages` option selects the public resources of
packages already loaded in that process. It saves the choice in the session history, not in
project settings. Tools are chosen separately through Pi's active-tool API, and permissions do not
change. Running children keep what they started with. New children use saved personal and
project guidance plus their own bundle, narrowed by their agent definition; the parent's
session-only choices do not carry over.

`pi-resources` owns `/packages` and `/skills`. Delegation owns `/agents` and context owns
`/instructions`. Each adds its resources to one shared setup service without loading the others.
Shared discovery, saving and session selection live in `pi-resources` library subpaths, which
never import its extension entrypoint. Pi still owns installation, code loading and reload.

### The `/packages` picker

Enter or Space turns the highlighted package's public skills, agents and instructions on or off
for this session. Other individual choices stay as they are. A partial marker means only some of
the package's resources are on. Changes are saved in the session history, like `session_setup`,
and survive resume. The model's `session_setup` `packages` option works differently: it replaces
all three categories with the listed packages plus any individual choices in the same call.

Ctrl+S saves the current selections from loaded extensions as project defaults in the trusted
project's `.pi/settings.json`. It saves each resource ID as an explicit On or Off, not a package
name, so new resources added to a package later are not turned on silently. Package registrations,
tools and permission settings are left alone. Session choices still win; reset one to use the
saved default. Ctrl+Shift+S saves personal defaults for new sessions in any project, leaving out
project-only resources. Explicit project choices still win over personal ones.

Saving never reloads code or changes running children.

| Change | How | Takes effect |
|---|---|---|
| Turn package guidance on or off | `/packages` | Lookups now; prompt sections at the next parent run |
| Reuse the current selection in new project sessions | Ctrl+S in `/packages` | Saved project defaults; this session is unchanged |
| Select or remove loaded guidance from the model | `session_setup` apply or reset | Lookups now; prompt sections at the next parent run |
| Try a package once | `pi -e SOURCE` | That invocation only; nothing saved |
| Install or remove a package | `pi install SOURCE` / `pi remove SOURCE`, `--local` for the project | Next start or idle `/reload` |
| Change extension code | Idle `/reload` | Replaces the extension runtime |
| Replace code while children run | Stage and test it; let running processes exit first | Restart or resume |

We never install or unload code during a tool call. Pi's reload shuts down extensions and
invalidates their contexts, including the tool doing the setup, and can stop owned children. When
a package is missing, the reply tells you which Pi command to run instead.

## Keep code with its owner

Child start-up, bundle preparation and file collection belong to delegation. Resource discovery
and selection belong to resources, exposed as library subpaths for context and delegation.
Processes, accounting, IDs, timers and provider-transfer code stay shared in `pi-runtime` because
several features use them. Do not turn `pi-runtime` back into a catch-all import. The browser and
search components stay a separate UI library.

This keeps the accounting and usage interfaces stable and means jobs, goals and permissions no
longer pull in the browser. No new package, registry or runtime mode was needed.

## Dependencies

Permissions, background jobs and delegation are separate extension packages. Shared libraries are
ordinary npm dependencies, and importing one does not load another extension. Pi's own libraries
are peer dependencies (`*`); the repository pins the tested versions. Policies, credentials and
personal preferences stay out of package manifests.

Pi 1.2.0 references: [packages](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md),
[extensions](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md),
[package resolver](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/package-manager.ts)
and [session reload](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts).

## Planned: separate standalone and package resources

This design is agreed but only exists as a TUI preview. Standalone instructions, skills and agents
would stay separate from package resources in the pickers and in saved selections. You would
select a package as a whole and inspect its members inside the package view. Package changes would
not touch standalone choices, and standalone changes would not leave a package partly selected.
Authors can share or copy content on purpose; the extensions do not guess links between resources.

Today the planner and saved selections still expand packages into individual members, as
described above. Those parts, and their resume and default tests, must change before this design
ships.
