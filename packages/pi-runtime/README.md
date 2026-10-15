# pi-runtime

Shared implementation code imported by Pi extensions. Functions execute in the parent or child Pi process that calls them; there is no separate daemon or child-only runtime.

The parent uses resource selection, auth resolution, launch-file installation, artifact collection, and usage accounting. Prepared children load the `pi-runtime/child-auth` entrypoint to register the selected provider. Accounting is installed per Pi event bus in both processes that use it; child reports cross RPC into the parent's ledger.

- [Architecture](../../docs/architecture.md): execution locations and workspace/configuration distinctions.
- [Accounting](../../docs/accounting.md), [semantic IDs](../../docs/semantic-ids.md), and [artifact retention](../../docs/guides/delegation.md#retain-and-integrate-artifacts).
- [Package reference](../../docs/reference/packages.md) and [event contracts](../../docs/reference/events.md).

Exports: [src/index.ts](src/index.ts) and [src/child-auth.ts](src/child-auth.ts). Importing the root library does not activate sibling extensions. From the repository root, run `npm run test --workspace=pi-runtime` and `npm run typecheck --workspace=pi-runtime`. [Local tarballs](../../docs/guides/distribution.md#build-local-tarballs) export emitted JavaScript and declarations.

## Native resource packages

Pi owns package installation, source identity, project trust and native resource filters through
`package.json.pi`. This library reads only two additional declarations: `pi.agents` and
`pi.instructions`, each a list of relative directories contained in the package. There is no
`plugin.json` loader, namespace directory or `resources.packCatalogues` registration.

Native skill candidates must be enabled by Pi and present in the loaded skill pool; CLI exclusions
remain effective. Configured packages and explicit `-e` packages can supply agents/instructions,
including packages with no native resource types. The shared reader uses Pi's argument parser and
native installed-path lookup for temporary sources. It does not install packages, scan caches or
execute their extensions. Temporary-only resources cannot become personal defaults implicitly.

Package name, description and keywords aid resource search. Agent/private-skill and selected
instruction behavior stays in the owning extensions. Public skill bodies remain lazy; selected
instruction bodies are read afresh at the next parent run. Custom metadata reads are bounded
regular-file reads inside their owning root; child bundle staging preserves its existing checks.

`session_setup` selects already-loaded native package resources and registered tools for this
session. It does not install or unload code. See [package decisions](../../docs/package-design.md)
and the [tool reference](../../docs/reference/tools.md#session-setup).
