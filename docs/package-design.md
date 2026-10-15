# Native package decisions

Pi packages are the distribution and loading unit. A resource package is an ordinary Pi package
that contains skills, agents and behavior instructions. It has one `package.json` manifest.
The additional fields `pi.agents` and `pi.instructions` are ours; stock Pi ignores them.

## Reuse native packaging

Pi already resolves npm, Git and local sources, applies personal/project precedence and resource
filters, installs dependencies and reloads extensions. Use those mechanisms rather than a second
plugin manifest, source catalogue or installer. Public skill membership comes from native enabled
resources and the loaded skill pool. This preserves both package filters and CLI exclusions.

Agent definitions/private bundles and selected eager instruction snippets remain custom because
Pi has no native resource types with those semantics. The cost is a small contained directory
reader for those two fields. Revisit it if stock Pi adds equivalent resource types.
Configured packages and explicit `-e` sources can contain only agents/instructions. For CLI sources,
Pi's exported argument parser supplies the requested sources and its installed-path lookup supplies
already-resolved temporary roots. No cache paths, hashes or source identities are reconstructed.
Only actual loaded skills are grouped; native exclusions stay authoritative. Explicit CLI copies
take precedence over configured copies with the same package name. Discovery never installs code
or changes package settings. Pi 1.2's implementation accepts the temporary lookup scope although
its exported TypeScript declaration omits it; the call is covered by stock-Pi checks.

## Discover packages through Pi

Pi reads `packages` in personal `~/.pi/agent/settings.json` and trusted project
`.pi/settings.json`. A source can be npm, Git or a local path. Relative local paths resolve from
the declaring settings file. Project entries take precedence for the same native package identity;
`autoload: false` instead applies project filters to the personal entry. Pi handles identity,
installation and native resource filters. Our discovery reads the resolved package roots and does
not search arbitrary directories or install missing packages.

The resource browser lists packages that contribute available skills, agents or instructions.
An extension-only package still loads through Pi, but has no guidance to select in that browser.
Temporary `pi -e SOURCE` resources use Pi's native loader and are grouped from those explicit
sources, without requiring a project registration or another profile.

## Use the native package shape

Stock Pi supports `extensions/`, `skills/`, `prompts/` and `themes/` directories, or explicit path
arrays under `package.json.pi`. Native arrays accept globs and exclusions. There is no required
all-four directory layout: include the resource types the package actually provides. Our custom
`pi.agents` and `pi.instructions` fields accept relative directory arrays, not globs.

```text
research/
├── package.json
├── skills/check-evidence/SKILL.md
├── agents/evidence-verifier/evidence-verifier.md
├── agents/evidence-verifier/skills/verify-claims/SKILL.md
└── instructions/evidence-attribution.md
```

The two `agents/` paths above are our bundle convention, not stock Pi resource types. Private
skills stay inside the agent bundle and do not need registration in the parent's skill pool.

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

In this example there is no extension code. A package with `pi.extensions` can execute JavaScript
or TypeScript when Pi loads it; those extensions can register tools, commands and event handlers.
Imported npm libraries are ordinary runtime dependencies. Selecting package guidance does not
enable or disable that executable code.

MCP is separate. Stock Pi has no `pi.mcp` package field: servers are configured through personal
or project `mcp.json` and the native `/mcp` manager. An extension could implement an integration,
but that is extension behavior, not automatic MCP installation by a package manifest. The picker
must present its guidance members separately from executable loading and permissions.

## Keep selection separate from code loading

`session_setup` is parent-only. Its `packages` array selects the public resources of packages
already loaded into that process. It stores a selection in the session history, not project
settings. Tools are selected independently through Pi's active-tool API; permission policy is
unchanged. Existing children retain their prepared resources; future children use the selected
public resources plus their own private bundle, narrowed by their agent definition.

The independent `pi-resources` extension owns `/packages` and `/skills`, using the existing
searchable resource browser. Delegation owns `/agents`; context owns `/instructions`.
They contribute to the shared setup service without activating one another. Generic persistence
lives in `pi-runtime`; native Pi still owns installation, executable loading and reload.

The `/packages` picker uses the existing searchable resource browser. Enter/Space toggles the
highlighted package's available public skills, agents and instructions for this session; unrelated
individual selections stay selected. A partial marker means only some of the package's members
are selected. Changes use the same session-history override as `session_setup` and survive resume.
The model tool's `packages` apply operation instead replaces those three categories with the
requested packages and same-call explicit choices.

Ctrl+S explicitly saves the current effective selections from loaded resource providers as project
defaults in trusted `.pi/settings.json`. It saves concrete resource IDs, including individual
choices as explicit On/Off entries, rather than a package name that could silently select future new members. Native package
registrations, tools and permission settings are preserved. Existing session overrides still take
precedence; reset one to use saved defaults. The picker does not reload code or change already
launched children. Ctrl+Shift+S saves personal defaults for new sessions across projects, excluding project-only members. Explicit project choices still take precedence; inherited choices follow personal defaults.

| Change | Mechanism | When it takes effect |
|---|---|---|
| Toggle package guidance interactively | `/packages` | Session lookup now; prompt sections at the next parent run |
| Reuse the current guidance selection in new project sessions | Ctrl+S in `/packages` | Saved project defaults; current session selection remains in effect |
| Select/remove loaded package guidance | `session_setup` apply/reset | Lookups now; skill/instruction prompt sections at the next parent run |
| Try another native package for one invocation | `pi -e SOURCE` | New invocation; no saved package declaration |
| Install/remove a saved native package | `pi install SOURCE` / `pi remove SOURCE`; choose scope with `--local` | Next start or idle `/reload` |
| Change ordinary extension code | Native idle `/reload`, where cleanup is safe | Replaces the extension runtime |
| Replace secured runtime code or affect running children | Stage a tested runtime; exit prior processes before activation | Restart/resume |

We do not install or unload executable packages inside a model tool call. Native reload shuts down
extensions and invalidates their contexts, including the tool performing setup. It can also stop
owned children. A missing package response names the native loading action instead of changing
settings, restarting work or constructing a parallel dynamic loader.

## Package security and dependencies normally

Security, background processes and delegation remain native extension packages. Shared libraries
are ordinary npm dependencies and importing one does not activate a sibling extension. Stock Pi
libraries remain peer dependencies (`*`); the repository pins the tested development versions.
Policy, credentials and personal preferences stay outside package manifests.

For the secured launcher, retain a tested immutable dependency set and stage updates together.
Pi gives packages separate module roots and does not guarantee one shared dependency instance.
Native packaging therefore does not replace ownership checks, capability bindings or controlled
runtime activation. Independent user packages and their native filters survive runtime upgrades.

Source of truth: the pinned stock Pi [package guide](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md),
[extension lifecycle](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md),
[package resolver](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/package-manager.ts)
and [session reload](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts).

## Independent resource selection — agreed design, preview only

Keep standalone instructions, skills and agents separate from package-owned resources in their
pickers and saved selections. A package is selected as a whole; its members are inspected inside
its package view. Package changes must not rewrite standalone choices, and standalone changes
must not produce a partially selected package. Curators can share or duplicate their authored
content deliberately; the extensions do not infer reusable content or cross-resource links.

The isolated TUI preview implements this interaction. The production planner and persistence still
flatten packages into member selections as described above; updating those mechanisms and their
resume/default tests is required before activating this policy in the harness.
