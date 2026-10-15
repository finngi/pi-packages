# Native packages with independent capabilities

Status: candidate implementation and isolated stock-Pi checks. Not activated in the installed
personal runtime. Existing running sessions and their package/cache bindings are unchanged.

## Why this change

The useful capabilities are selectable behaviour, delegated agents, background work, goals and
permission decisions. Requiring all of them to share a security-controlled launcher makes a
small workflow depend on unrelated infrastructure. We retain working code and remove those
requirements instead of replacing Pi or rewriting the capability state machines.

Pi remains responsible for installation, source/version resolution, project trust, sessions,
model access, native tools and UI. Packages are ordinary directories with a manifest; they can
be installed from a local path, a Git repository or npm. No particular checkout location such as
`~/.config/agents` is part of the resource format.

## Packages and dependencies

| Package | Owns | Optional integration |
| --- | --- | --- |
| `pi-context` | Selected instructions and local project context | Agent/session setup contributions |
| `pi-delegation` | Agent definitions, child RPC lifecycle and communication | Jobs transport, selected security service |
| `pi-background` | Background shell jobs, output and cancellation | Selected security service, goal completion delivery |
| `pi-goal` | Objective, continuation and evaluation | Child/job waits |
| `pi-permissions` | Deny/allow rules and unmatched-action approval | Native model classifier or an approval-capable UI/client |
| `pi-security` | Existing kernel confinement and secured transports | Existing integrations, retained separately |

`pi-runtime`, `pi-contracts` and `pi-resource-browser` are library dependencies, not automatically
activated extensions. The process manager is shared code: child agents can reuse it without
loading the jobs extension. Granular imports keep plain process, accounting and goal modules
from eagerly importing resource-picker UI code. The current runtime manifest still installs the
browser library because other exports use it; this is not a claim of a minimal npm install graph.

`pi-permissions` uses the existing parser/classifier library through `pi-security/permissions`.
Its library dependency does not activate the sandbox extension. It is an alternative entrypoint,
not a second gate to load alongside the full sandbox. The repository-root package keeps its
existing aggregate manifest; the thin capabilities are selected through their individual package
directories or separately packed artifacts. Nothing here publishes them to npm.

## Resource location and cross-extension behaviour

Native package declarations go in personal `~/.pi/agent/settings.json` or the trusted project's
`.pi/settings.json`. A local package source resolves relative to that settings file; manifest
paths resolve relative to the package root. For example:

```json
{
  "name": "research-resources",
  "version": "0.1.0",
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

Only the first four resource types are native Pi types. The agent/instruction extensions read
the last two fields using Pi's already-resolved package roots. Thus user-level capability
extensions can discover content supplied by other user-level or trusted project packages.
Discovery makes content available for selection; it does not select it, register new tools,
activate executable dependencies or grant permissions. A plain Pi installation without those
capability extensions ignores the extra metadata.

Configured custom-only Git/npm packages are now discoverable through Pi's installed package
records. Explicit `-e` sources use Pi's argument parser and temporary installed-path lookup,
including custom-only packages. We do not infer cache paths or add a second resolver.

## Personal packaging

The personal migration is prepared separately from this reusable repository:

- `personal-interactive`: the existing public-API tool renderer and optional native themes.
- `personal-extensions`: model-facing timestamps, usable in interactive, print and RPC sessions.

These names express intended use; Pi itself has no special interactive-package category.
Rendering code affects interactive display. Context transformations work in all modes. Neither
package needs a special launcher or a required home-directory location. Other personal/vendor
capabilities stay separately packaged.

The current launcher preload patches private Pi UI classes. It is not copied into the thin
interactive package: pinned viewport layout, custom message clicking and accounting/startup
patches remain part of the existing installation pending an explicit cutover/API decision.
This candidate is not presented as full visual parity with that preload.

## Permission boundary

Permission decisions are before-tool hooks, not operating-system confinement. Allowed commands
run with the Pi process's normal host access. Explicit denies take precedence, explicit allows
skip model review, and unmatched actions require manual approval or an available classifier.
Missing policy/model, malformed response, cancellation and ambiguous verdicts block the action.
The model sees user context, worker reasoning/explanation and the exact action as evidence.

The gate is process-local. Children load selected tool entrypoints; hook-only permission packages
do not accompany those tools automatically, so a parent gate does not review each child action.
Reviewing a `subagent` launch grants that launch; it is not evidence of per-child tool review.
Child tasks are worker-authored, not root-user authorization. Do not claim sandbox confinement
or automatic descendant enforcement. Existing explicitly selected sandbox service failures still
refuse execution; they never fall back to ordinary host execution.

## Verification and retained scope

Use the standalone scripts and package tests listed in the component decision notes. Tests use
stock Pi 1.2, deterministic providers, temporary resources and actual child/job processes. They
verify module loading, state transitions and effects; they do not prove live classifier judgment
quality. Packed-consumer checks cover compiled export paths and native package entrypoints.

No new installer, scheduler, daemon, global permission registry, model client or session database
was added. No settings migration, package publication, runtime activation or restart is part of
this candidate.

See [resource decisions](thin-slice-resources.md), [job/goal decisions](thin-slice-jobs-goals.md),
[permissions](../../packages/pi-permissions/README.md), and the pinned upstream
[package contract](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md).
