# One native package path

## Decision

Use stock Pi plus independently loadable packages. Remove the full OS sandbox, secured launcher,
credential snapshots, parallel skill catalogue loader and old-format settings readers. Retain the
small optional permission gate without any sandbox dependency.

The old design made agent launches, simple Bash and search depend on policy/resource transport
machinery. The thin package experiment still imported that machinery and duplicated native
resource/authentication behaviour. Renaming it did not remove those dependencies.

## Retained code and reason

| Code | Why it remains |
|---|---|
| `pi.agents` / `pi.instructions` metadata | Pi has no native types for these resources |
| Child RPC adapter and message broker | Named child workflows and correlated dialogue are additional behaviour |
| Selected tool/skill/model setup | A child needs an explicit launch configuration, including private skills |
| Shared process manager | Background output, cancellation and session-owned cleanup |
| Session selection records | Choices must survive resume without rewriting saved defaults |
| Goal state machine and evaluator | Objective, budgets, waits and continuation are additional behaviour |
| Usage receipts | Child/classifier/evaluator calls otherwise disappear from parent totals |
| Artifact collection | Scratch files must survive child cleanup |
| Optional gate | Deny/allow and automatic approval are useful without OS confinement |

Native package resolution governs discovery; excluded skills are never reconstructed by another
loader. Native authentication governs each process; selected model metadata can cross the RPC
boundary, executable provider callbacks require a trusted extension source. There is one launcher.

The permission extension contributes its own child initialization through a small trusted launch
event. This lets a hook-only package accompany delegated work without teaching delegation an OS
sandbox. Genuine root-user messages remain separate from the worker-authored child task.

Personal code lives in ordinary private packages. Core-class UI patches are removed; supported
native header/footer/tool rendering replaces them. Exact private viewport behaviour is not a
reason to retain another harness loader.

## Alternatives rejected

- Retaining the old sandbox as a library: imports still carry its dependency graph and policy types.
- A second package registry: duplicates native installation, filtering and identity.
- Serialized resolved login credentials: duplicates native refresh/locking and restricts providers.
- Runtime compatibility readers: keep old semantics alive indefinitely. Convert saved configuration
  once during local migration, preserve transcripts/artifacts, then use one current representation.

## Verification

Check each package on stock Pi, then pack/install into a fresh consumer. Exercise child tools,
private skills, model choice, permissions, accounting, goals and session resume. Local activation
must use the same agent directory and verify that no legacy package or loader remains active.
No npm publication is part of this migration.

See [package design](../package-design.md), [testing](../testing.md),
[permissions](../../packages/pi-permissions/README.md) and the
[upstream package contract](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md).
