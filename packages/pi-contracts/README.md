# pi-contracts

Shared TypeScript interfaces and event names for these Pi packages. It is a library: importing it
starts nothing and loads no extension.

It exports child resource and launch types, prepared-child types, background service interfaces and
versioned event names. Child processes still talk over RPC; sharing types does not share a process
or event bus.

- [Packages](../../docs/reference/packages.md): dependencies and tested versions.
- [Events and services](../../docs/reference/events.md).
- [Architecture](../../docs/architecture.md): library and process boundaries.

Exports: [src/index.ts](src/index.ts). Check with `npm run typecheck --workspace=pi-contracts`.
[Local tarballs](../../docs/guides/distribution.md#build-local-tarballs) contain the built
JavaScript and type declarations.
