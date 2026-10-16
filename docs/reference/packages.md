# Packages

Ten workspaces share one lockfile: seven extensions and three libraries. Each extension loads on
its own on stock Pi 1.2.0. The seven user-facing downloads are experimental npm alpha releases:
use `@finngi/<extension-name>@alpha`. Libraries stay bundled and are not separate gallery entries.

| Package | What it does | Works with |
|---|---|---|
| `pi-delegation` | Agents, child start-up and resources, messages and collected files | Uses background jobs if loaded; receives permission settings for children |
| `pi-resources` | `/skills` and `/packages`, plus library APIs for discovery and selection | Context and delegation add instructions and agents |
| `pi-context` | Selected instructions and `AGENTS.local.md` files | Shared session setup |
| `pi-background` | Background Bash jobs, output and cancellation | `/background` ends goal waits |
| `pi-goal` | Goals, separate evaluation, deadlines, budgets and continuation | Waits on child answers |
| `pi-codex-search` | Web search using Pi's Codex login | Can be passed to children |
| `pi-permissions` | Checks tool calls by rule, by asking you, or with a classifier | Passes its settings to children |
| `pi-contracts` | Shared interfaces and event names | Library only |
| `pi-runtime` | Shared processes, accounting, IDs, timers and provider helpers | Library only |
| `pi-resource-browser` | Searchable TUI resource picker | Library only |

Each extension's entrypoints are listed in its `package.json` `pi.extensions`. Libraries are
ordinary npm dependencies and never load other extensions.

## Who owns what

`pi-runtime` depends only on `pi-contracts`, so jobs, goals and permissions never pull in resource
selection or the browser through it. Child start-up and collected files live in delegation.
Resource discovery, saving and session selection live in `pi-resources` library subpaths, separate
from its extension. `pi-resource-browser` provides the shared search and TUI picker.

Each local extension tarball bundles the unpublished workspace packages it depends on, using npm's
`bundleDependencies`. Install one extension tarball next to stock Pi; no other extension needs
installing or registering, and only that extension's entrypoint loads. Tests install each one in
its own fresh project and exercise what it actually does.

## Versions

Tested with Node 24, Pi coding-agent, AI, TUI and MCP 1.2.0, TypeScript 7.0.2 and Biome 2.3.5. Pi
modules are peer dependencies with `*` ranges, which does not promise every Pi release works. The
manifests and root lockfile hold the exact versions. Run the installed-package checks when you
change entrypoints or dependencies.

## Provenance

`pi-codex-search` is based on Leechael/pi-codex-search v0.1.6, commit
`14e24ce6b593b865576d816cea0d1fc78aab3daa`, and keeps its MIT notice.
