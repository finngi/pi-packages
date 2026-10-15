# Agents and instructions as package resources

Status: done.

## Decision

Pi owns package installation, versions, project trust, models and providers, sessions, skills,
prompts, themes, tools and extension lifecycle. Agent bundles and selected instruction snippets are
two extra resource types that these extensions read. Their files belong to the package that
declares them. No particular checkout, user name, `~/.config/agents` folder or symlink tree is
needed.

A package can live anywhere locally or be installed from Git or npm with `pi install`. Pi records
personal sources in `~/.pi/agent/settings.json` and project sources in `<cwd>/.pi/settings.json`,
and manages its own caches. Each path is relative to its package root, so the same package works
from a checkout or an install:

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

`agents` and `instructions` are ours; Pi loads the other four. A package with only agents or
instructions needs no placeholder extension or skill. Discovery asks Pi's package manager for
installed roots, skips sources Pi declined to load, and never installs anything. Project trust and
Pi's version checks still apply.

An agent bundle is `agents/<name>/<name>.md`, with its private `skills/`, scripts and references
inside. Only `pi.skills` paths are shown to the parent. Instruction files are Markdown in the
declared folders, and selected ones go in a separate `<instructions>` section. Project `AGENTS.md`
context stays separate.

## Who owns what

`pi-resources` owns skill selection and the package picker; putting them in delegation would need
child-process code just to pick guidance. `pi-delegation` owns agents, `/agents` and child
sessions. `pi-context` owns instructions and `/instructions`. They share the runtime setup service,
saving helpers and browser library.

Any loaded extension can supply package groups, so a session with only context can select package
instructions without the picker or delegation. Missing extensions do not turn into empty
selections, and package saves keep their existing defaults. Session entries and settings use one
sparse-map format. The local switch-over converted old saved choices once.

## Saved defaults per resource

A list per category cannot say "inherit this one, turn that one off". Saved choices are maps from
resource ID to `true` or `false`, and one resolver handles skills, agents, instructions and
packages. Missing IDs inherit from the next level; an empty map inherits everything.

Editing a row changes only that ID. A bulk save updates the eligible rows and removes stale unknown
entries, keeping other known values, including rows not part of the save. Session records still hold
concrete selections, so later defaults cannot change a resumed session. This uses the existing
settings files, atomic writer, session service and picker, with no extra override layer or store.

## Reused and removed

- Kept Pi's package discovery, the agent parser and private-skill loader, RPC dialogue, resource
  picker, instruction reader and saved session selection. No new installer, catalogue, model
  client or session store.
- Moved the bounded process manager into the `pi-runtime/processes` library. `pi-background` uses
  it. Without a background service, agents create their own session-owned manager with cleanup on
  shutdown and exit. Loading agents does not add background tools.
- Package selection only covers resource kinds whose extensions are loaded. Packages with only
  agents or skills need no instruction extension, and replies name the kinds involved.
- `session_setup` moved to the shared setup service, so instructions can be selected by the model
  without loading agents. When agents are loaded they add details to successful replies through
  Pi's tool-result hook.

The shared libraries are ordinary imports, not extensions or global services. No package needs a
custom launcher to find resource files.

## Known limits

Pi's resource list does not include a `-e` package with no Pi resources. Pi's argument parser and
installed-path lookup provide those roots without installing, scanning caches or saving settings.
Only skills Pi loaded join a package group. Loading a single extension file with `-e` does not scan
its folder.

Pi still supports standalone skill paths. Personal instruction libraries are packages, and project
snippets stay in their project. No second catalogue loader remains. Installing and loading code is
Pi's job; resource selection never unloads hooks, installs packages or changes permissions.

## Tests

- Stock Pi with only agents: a real RPC child runs commands, uses a private skill and relative
  script, sends progress, writes files and returns a file receipt, in scratch and project modes,
  without background jobs or permissions.
- Stock Pi with only instructions: selection changes the prompt, keeps project context, and survives
  resume, fork and tree navigation without changing settings.
- Package fixtures cover local and installed Git and npm packages with only custom resources, skill
  filtering, project precedence, stale npm versions and private-resource boundaries.

See Pi's [packages](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md)
and [extensions](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md) docs.
