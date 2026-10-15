# Package reference

Ten workspaces share one lockfile: seven extensions and three libraries. Each extension can load
independently on stock Pi 1.2.0. Packages are experimental and have not been published to npm.

| Package | Purpose | Optional integration |
|---|---|---|
| `pi-delegation` | Agent definitions, child RPC, messages and retained results | Background transport; permission launch contribution |
| `pi-resources` | `/skills`, `/packages` and session resource selection | Context/delegation contribute instructions/agents |
| `pi-context` | Selected behavior instructions and `AGENTS.local.md` overlays | Shared session setup |
| `pi-background` | Managed Bash jobs, output and cancellation | Goal wait delivery |
| `pi-goal` | Goals, separate evaluation, deadlines, budgets and continuation | Agent/job waits |
| `pi-codex-search` | Search using Pi's native Codex authentication | Selected native tool in children |
| `pi-permissions` | Tool-call approval by rule, by asking you, or by a classifier model | Passes settings to child agents |
| `pi-contracts` | Shared interfaces and event constants | Library only |
| `pi-runtime` | Child setup, process lifecycle, resources, accounting and artifacts | Library only |
| `pi-resource-browser` | Searchable native TUI resource browser | Library only |

Extension entrypoints are declared by each `package.json.pi.extensions`. Shared libraries are
ordinary npm dependencies and do not activate sibling extensions.

The tested baseline is Node 24, Pi coding-agent/AI/TUI/MCP 1.2.0, TypeScript 5.9.3 and Biome 2.3.5.
Host Pi modules are peers with `*` ranges; this does not promise compatibility with every release.
Manifests and the root lockfile are the version source of truth. Run the installed-package checks
when changing entrypoints or dependencies.

`pi-codex-search` derives from Leechael/pi-codex-search v0.1.6 baseline
`14e24ce6b593b865576d816cea0d1fc78aab3daa`; its upstream MIT notice is retained.
