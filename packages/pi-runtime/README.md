# pi-runtime

Shared process lifecycle, usage accounting, timers, semantic IDs and provider-transfer helpers.
Background jobs and delegation reuse the process implementation. Goals, permissions and delegation
reuse accounting and provider handling. This library has no resource browser, package discovery,
child bootstrap or extension entrypoint. Importing it starts no process and registers no tools.

Accounting is installed explicitly per Pi event bus. Child receipts cross RPC into the parent's
ledger. Existing usage event names, session entries and `pi-runtime/accounting` and
`pi-runtime/usage` exports stay stable.

- [Accounting](../../docs/accounting.md) and [semantic IDs](../../docs/semantic-ids.md).
- [Package responsibilities](../../docs/reference/packages.md) and [architecture](../../docs/architecture.md).

Exports: [src/index.ts](src/index.ts) and the explicit subpaths in [package.json](package.json).
Run `npm run test --workspace=pi-runtime` and `npm run typecheck --workspace=pi-runtime` from the
repository root. [Local tarballs](../../docs/guides/distribution.md#build-local-tarballs) contain
emitted JavaScript and declarations.
