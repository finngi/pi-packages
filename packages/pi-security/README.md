# pi-security

Replaces Pi's file and shell tools with policy checks and OS confinement. On macOS it uses
Seatbelt and a host-selected policy. Loading this package enables the sandbox; startup or
launch failures block secured operations instead of running them with ordinary host access.

- [Configure security](../../docs/guides/security.md): policy review, explicit launch, approvals, diagnostics, and confinement limits.
- [Security policy](../../docs/reference/security-policy.md): policy fields, automatic classification and per-call write scope.
- [Configuration reference](../../docs/reference/configuration.md): supported host settings and research interfaces.
- [Services and audit](../../docs/reference/events.md): prepared capabilities, RPC approvals, and stored records.
- [Testing](../../docs/testing.md): Pi 1.2.0, macOS, Linux kernel, and consumer checks.

Source entrypoint: [src/extension.ts](src/extension.ts). The [CLI](src/cli.ts) explains policy decisions without execution or classification. The [host template](src/host-policy.json) must be reviewed for the installation; runtime policy validation remains authoritative.

For permission checks without OS confinement, use [pi-permissions](../pi-permissions/README.md).
It reuses the parser and classifier through `pi-security/permissions` without starting the
sandbox, proxy, child transport or replacement tools. Choose one extension; this package's
default entrypoint is the full sandbox.

From the repository root, run `npm run test --workspace=pi-security`, `npm run typecheck --workspace=pi-security`, `npm run test:i --workspace=pi-security`, and `npm run test:resources --workspace=pi-security`. Run the combined `npm run test:e2e` on supported macOS. Linux kernel checks require a host that allows Bubblewrap namespaces; they do not test the packaged container.

A trusted macOS launcher can include GPU access in its baseline. A trusted launcher can also enable classifier-reviewed host execution for nested harness commands. Policy and tool requests use independent file and network permissions; see [host capabilities](../../docs/reference/security-policy.md#children-and-host-capabilities).
