# pi-security

Policy, approvals, and confined replacement file/shell tools for Pi. The supported macOS host uses Seatbelt with a reviewed trusted policy. Security is optional for delegation/search, but active or selected security is mandatory for their execution: initialization or launch failure never falls back to unrestricted operation.

- [Configure security](../../docs/guides/security.md): policy review, explicit launch, approvals, diagnostics, and confinement limits.
- [Security policy](../../docs/reference/security-policy.md): policy fields, automatic classification and per-call write scope.
- [Configuration reference](../../docs/reference/configuration.md): supported host settings and research interfaces.
- [Services and audit](../../docs/reference/events.md): prepared capabilities, RPC approvals, and stored records.
- [Testing](../../docs/testing.md): Pi 1.1.0, macOS, Linux kernel, and consumer checks.

Source entrypoint: [src/extension.ts](src/extension.ts). The [CLI](src/cli.ts) explains policy decisions without execution or classification. The [host template](src/host-policy.json) must be reviewed for the installation; runtime policy validation remains authoritative.

For the independent permission-only thin slice, use [pi-permissions](../pi-permissions/README.md). Its native package loads the explicit `pi-security/permissions` library entry, reusing the parser and classifier without starting the sandbox, proxy, child transport or replacement tools. This package's default extension remains the full sandbox; the two are not silently substituted.

From the repository root, run `npm run test --workspace=pi-security`, `npm run typecheck --workspace=pi-security`, `npm run test:i --workspace=pi-security`, and `npm run test:resources --workspace=pi-security`. Run the combined `npm run test:e2e` on supported macOS. Linux kernel checks need a namespace-capable environment and do not establish container release closure.

A trusted macOS launcher can include GPU access in its baseline. A trusted launcher can also enable classifier-reviewed host execution for nested harness commands. Policy and tool requests use independent file and network permissions; see [host capabilities](../../docs/reference/security-policy.md#children-and-host-capabilities).
