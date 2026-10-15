# Package reference

Ten workspaces share one lockfile: seven extensions and three libraries. Each extension can load
independently on stock Pi 1.2.0. Packages are experimental and have not been published to npm.

| Package | Purpose | Optional integration |
|---|---|---|
| `pi-delegation` | Agent definitions, child bootstrap/resources, messages and artifacts | Background transport; permission launch contribution |
| `pi-resources` | `/skills`, `/packages`; library APIs for discovery and selection | Context/delegation contribute instructions/agents |
| `pi-context` | Selected behavior instructions and `AGENTS.local.md` overlays | Shared session setup |
| `pi-background` | Managed Bash jobs, output and cancellation | Goal wait delivery |
| `pi-goal` | Goals, separate evaluation, deadlines, budgets and continuation | Agent/job waits |
| `pi-codex-search` | Search using Pi's native Codex authentication | Selected native tool in children |
| `pi-permissions` | Tool-call approval by rule, by asking you, or by a classifier model | Passes settings to child agents |
| `pi-contracts` | Shared interfaces and event constants | Library only |
| `pi-runtime` | Shared process lifecycle, accounting, IDs, timers and provider helpers | Library only |
| `pi-resource-browser` | Searchable native TUI resource browser | Library only |

Extension entrypoints are declared by each `package.json.pi.extensions`. Shared libraries are
ordinary npm dependencies and do not activate sibling extensions.

The tested baseline is Node 24, Pi coding-agent/AI/TUI/MCP 1.2.0, TypeScript 5.9.3 and Biome 2.3.5.
Host Pi modules are peers with `*` ranges; this does not promise compatibility with every release.
Manifests and the root lockfile are the version source of truth. Run the installed-package checks
when changing entrypoints or dependencies.

`pi-codex-search` derives from Leechael/pi-codex-search v0.1.6 baseline
`14e24ce6b593b865576d816cea0d1fc78aab3daa`; its upstream MIT notice is retained.

## Ownership and installation

`pi-runtime` depends only on `pi-contracts`; jobs, goals and permissions do not acquire resource
selection or the browser through it. Child setup and artifacts live in delegation. Resource
discovery, persistence and session selection live in `pi-resources` library subpaths, separate
from its extension entrypoint. `pi-resource-browser` supplies shared search/TUI rendering.

Local extension tarballs bundle their declared unpublished workspace dependencies with npm's
`bundleDependencies`. Install one extension artifact alongside the stock Pi host; no sibling
extension registration is required. Only the chosen native entrypoint activates. Installed
proof uses a separate fresh consumer per extension and exercises its actual behavior.
