# Test a contribution

Use Node 24 and the root lockfile, which pins the Pi SDK to 1.2.0. From the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

`check` runs Biome formatting/lint and workspace TypeScript checks. `test` runs package suites. For a focused change, use `npm run test --workspace=pi-subagents` or the affected package name. For launch, accounting, or security changes, also run integration tests with unmodified Pi and relevant kernel checks. For distribution changes, test installed tarballs.

## Choose the integration check

| Change or claim | Check | Scope |
| --- | --- | --- |
| Combined macOS stack | `npm run test:e2e` | Context, search/security adapter, all-extension RPC integration, security integration, packed consumers |
| Delegation/accounting without security | `npm run test --workspace=pi-subagents` | Real Pi 1.2.0 parent/child with scripted provider, scratch/project, messages, selected tools, usage, results |
| Packed consumers | `npm run test:packages` | Builds/installs all nine tarballs in a fresh directory; checks manifests, licenses, emitted entrypoints, and compiled file helper |
| Security resources/auth/search | `npm run test:resources --workspace=pi-security` | Protected child resources, auth adapters, classifiers, search capability |
| Security host integration | `npm run test:i --workspace=pi-security` | Confined file/shell, protected ancestors, CLI/modes, ownership, offline Cargo/rustc |
| Linux kernel executor | `npm run test:linux --workspace=pi-security` | Read-only bubblewrap confinement and writable-mode refusal; requires namespaces permitted by host/container |
| Local prompt rendering | `npm run test:e2e --workspace=pi-local-context` | Pi 1.2.0 prompt/reload/lazy skills/personal excludes, no model calls |
| Search capability adapter | `npm run test:e2e --workspace=pi-codex-search` | Actual security extension, synthetic OAuth, scripted HTTP; monorepo sibling path resolves automatically |

The supported macOS host needs Node 24 and `/usr/bin/sandbox-exec`; the file client resolves `rg` and `fd`/`fdfind` from policy-selected executable directories. The offline toolchain fixture needs its Cargo/rustc prerequisites. Linux kernel tests require a host that permits bubblewrap namespaces; a successful typecheck or protocol fixture does not prove kernel confinement.

Protocol and consumer fixtures use disposable HOME/agent directories, scripted providers, synthetic credentials, or scripted HTTP. They do not make live model/search requests or establish real-model quality, live prices, or account behavior. They exercise the Pi 1.2.0 SDK entrypoints and subprocess boundaries rather than replacing the host with a mock.

## What the checks establish

The Pi 1.2.0 child fixtures cover parent messages, resource/model/thinking selection, all-call usage, session-footer forwarding, cancellation, and retained artifacts. The combined security fixture covers goal-owned single delivery, normal follow-ups, manual approvals, context/search integration, and actual kernel refusals. Consumer checks verify `node_modules` resolution; workspace resolution alone is insufficient.

Biome exceptions cover parser assignment expressions, policy placeholder strings, control-character regular expressions in security checks, and broad fixture function types. TypeScript strict mode remains enabled; production implicit-any declarations are checked by Biome.

[GitHub CI](../.github/workflows/ci.yml) configures build/check/unit suites on Node 24 for macOS and Linux, with `test:e2e` on macOS. Local results do not prove that a hosted run completed or that an installed harness changed. Record the commands, environment, and practical limits with any claimed result.

## Evidence and source

- [Integration runner](../scripts/e2e.mjs), [packed consumer](../tests/packages.test.ts), and package scripts are the command source of truth.


The security MCP adapter is built against `@earendil-works/pi-coding-agent` 1.2.0 and its resolved public transport peer `@earendil-works/pi-mcp` 1.2.0. `pi-security` declares the MCP package as a peer (`*`); runtime consumers must provide the tested compatible peer.
