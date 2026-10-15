# Package reference

The root npm workspace has one lockfile for eleven packages: eight Pi extensions and three shared libraries. Extension packages declare their library dependencies; importing a library does not activate an extension. Distribution packs all eleven packages together with each package's README, license files, and provenance file when present.

## Responsibilities and entrypoints

| Package | Kind and responsibility | Source entrypoint | Runtime requirement |
| --- | --- | --- | --- |
| `pi-delegation` | Extension: definitions, delegation, dialogue, retained results | [subagent.ts](../../packages/pi-delegation/extensions/subagent.ts) | Pi 1.2.0; optional `pi-background` and `pi-security` |
| `pi-resources` | Extension: `/skills`, `/packages`, session skill selection and prompt filtering | [resources.ts](../../packages/pi-resources/extensions/resources.ts) | Pi 1.2.0; context/delegation contribute their own resource kinds when loaded |
| `pi-background` | Extension: session process lifetime, output, job controls, foreground handoff | [background-process.ts](../../packages/pi-background/extensions/background-process.ts) | Pi 1.2.0; required by security's `extensions` shell transport |
| `pi-permissions` | Extension: simple rules and manual/automatic tool approval, without OS confinement | [permissions.ts](../../packages/pi-permissions/extensions/permissions.ts) | Pi 1.2.0; explicit policy; choose instead of the full sandbox |
| `pi-security` | Extension: policy, approvals, confined effect tools | [extension.ts](../../packages/pi-security/src/extension.ts) | Pi 1.2.0 and supported kernel/toolchain prerequisites |
| `pi-goal` | Extension: authorized goals, fixed criteria, separate evaluation, worker usage, continuation, waits | [goal.ts](../../packages/pi-goal/extensions/goal.ts) | Pi 1.2.0; a trusted response producer for waits |
| `pi-context` | Extension: project context overlays, selected instructions, optional Pi-help skill | [context.ts](../../packages/pi-context/extensions/context.ts) | Pi 1.2.0 |
| `pi-codex-search` | Extension: fixed-backend search with authentication through Pi's model registry | [search.ts](../../packages/pi-codex-search/extensions/search.ts) | Pi 1.2.0; signed-in Codex provider; optional security |
| `pi-contracts` | Library: interfaces and event constants | [index.ts](../../packages/pi-contracts/src/index.ts) | Imported by consumers; no extension entrypoint |
| `pi-runtime` | Library: child resources/auth, accounting, artifacts, IDs | [index.ts](../../packages/pi-runtime/src/index.ts) | Imported in parent and child processes; `child-auth` also supplies an explicit child entrypoint |
| `pi-resource-browser` | Library: searchable, keyboard-driven resource picker shared by resource extensions | [resource-browser.ts](../../packages/pi-resource-browser/lib/resource-browser.ts) | Pi 1.2.0 TUI and coding-agent APIs; no extension entrypoint |

`pi-runtime/child-auth` is loaded by prepared child launches to register the selected provider. It is not a separate daemon or an extension to enable manually in the parent. See [architecture](../architecture.md) for execution locations.

## Dependencies

| Consumer | Declared shared package dependencies |
| --- | --- |
| `pi-background`, `pi-goal`, `pi-security` | `pi-contracts`, `pi-runtime` at `0.1.0` |
| `pi-delegation`, `pi-resources` | `pi-contracts`, `pi-runtime`, `pi-resource-browser` at `0.1.0` |
| `pi-context` | `pi-runtime`, `pi-resource-browser` at `0.1.0` |
| `pi-runtime` | `pi-contracts`, `pi-resource-browser` at `0.1.0`; `proper-lockfile` at `4.1.2` |
| `pi-codex-search` | `pi-contracts` at `0.1.0` |
| `pi-permissions` | `pi-security` at `0.1.0` (library only; no extension activation) |
| `pi-contracts`, `pi-resource-browser` | None |

`pi-delegation` reuses the pure `pi-runtime/processes` library for session-owned children. If `pi-background` is loaded it may share that transport through the event bus; the jobs extension is optional. `pi-permissions` imports the parser/classifier library through `pi-security/permissions`; this does not load the sandbox extension. Security selection also uses events rather than a mandatory concrete package dependency. `pi-security` additionally uses `tree-sitter-bash` `0.25.0` and `web-tree-sitter` `0.25.10`.

## Tested development versions

| Component | Pin or requirement |
| --- | --- |
| Node | 24; packages with engine declarations require `>=24` |
| `@earendil-works/pi-coding-agent` | `1.2.0` |
| `@earendil-works/pi-ai` | `1.2.0` |
| `@earendil-works/pi-tui` | `1.2.0` |
| TypeScript | `5.9.3` |
| Biome | `2.3.5` |
| `@types/node` | `24.19.1` |

Host Pi modules are peer dependencies with `*` ranges. The root pins their development versions; the peer range does not promise compatibility with every release. [Manifests](../../package.json) and the lockfile are the version source of truth.

## Distribution and provenance


`pi-codex-search` derives from [Leechael/pi-codex-search](https://github.com/Leechael/pi-codex-search), v0.1.6 baseline `14e24ce6b593b865576d816cea0d1fc78aab3daa`. Its [MIT licence](../../packages/pi-codex-search/LICENSE.pi-codex-search) is retained. It exposes the fixed Responses-only search feature set; experimental standalone page actions are not exposed.
