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
extensions still loads, but has nothing to make available there. Packages passed with
`pi -e SOURCE` are grouped too, with no project registration or extra profile needed.

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

`session_setup` runs only in the parent. Its `packages` array controls which already-loaded
packages expose their resources. It never expands a package into selected skills, agents or
instructions. Select those IDs separately, in the same request if needed. Package resources
start off until chosen; standalone native skills keep Pi's defaults.

Turning a package off hides its resources and removes them from effective model context. Their
individual choices are retained: turning the package back on restores those choices. This is an
availability gate, not a code loader. Already-loaded extensions, tools and permissions do not
change; native executable changes require a new invocation or deliberate idle reload.

`pi-resources` owns `/packages` and `/skills`. Delegation owns `/agents` and context owns
`/instructions`. They use the same scope controls and session history. Each resource or package
has independent Session, Project and Global On/Off/Inherit choices. Saved Project and Global scopes also
offer Any session or Interactive only. Package choices save as `resourcePackages` and package session types as
`resourceSessionTypes.packages`; saving package defaults never writes member defaults or Pi's
native `packages` source list.

Global defaults apply across projects; explicit project choices override them. Session overrides
apply only to that conversation. Resume or native `/reload` refreshes inherited defaults while preserving
explicit session choices. Parent-only selections do not pass to children.

New children use saved project/personal resource and package choices plus their agent bundle.
They run headless, so a package saved as Interactive only stays out, like one that is off.
A package skill with no saved choice stays off in children too. An agent that names a skill from
a hidden package does not get it; the launch result warns that the package is off or
interactive-only.

## Why availability and selection are separate

A package is a distribution unit; its curator may include several unrelated-to-this-task skills
or instructions. Expanding it into On selections silently adds context and overwrites individual
choices. The former group-checkbox implementation did that and is removed. Availability uses
the existing scope/state machinery, with one package ID per row; no second installer, manifest
format or dependency resolver is introduced. Pi's native filters still bound discovery.

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
