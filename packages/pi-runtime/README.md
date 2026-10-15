# pi-runtime

Shared code for processes, usage accounting, timers, semantic IDs and passing provider settings to
children. Background jobs and delegation share the process code. Goals, permissions and delegation
share accounting and provider handling. There is no resource browser, package discovery, child
start-up or extension here. Importing it starts no process and registers no tools.

Accounting is installed on each Pi event bus by calling it. Child usage reaches the parent over
RPC. Usage event names, session entries and the `pi-runtime/accounting` and `pi-runtime/usage`
exports are unchanged.

- [Accounting](../../docs/accounting.md) and [semantic IDs](../../docs/semantic-ids.md).
- [Packages](../../docs/reference/packages.md) and [architecture](../../docs/architecture.md).

## Tests

```sh
npm run test --workspace=pi-runtime
npm run typecheck --workspace=pi-runtime
```

Exports: [src/index.ts](src/index.ts) and the subpaths listed in [package.json](package.json).
[Local tarballs](../../docs/guides/distribution.md#build-local-tarballs) contain the built
JavaScript and type declarations.
