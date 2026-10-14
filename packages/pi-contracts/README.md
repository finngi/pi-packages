# pi-contracts

Shared TypeScript interfaces and event constants for the Pi extensions packages. This is an imported library, not an independently running service or automatically activated extension.

It exports child resource/launch contracts, prepared children, background transport interfaces, and versioned security/context/usage event names. Subprocess communication still uses RPC; sharing types does not share a process or event bus.

- [Package reference](../../docs/reference/packages.md): dependencies and tested SDK pins.
- [Events and service interfaces](../../docs/reference/events.md).
- [Architecture](../../docs/architecture.md): library and process boundaries.

Exports: [src/index.ts](src/index.ts). From the repository root, run `npm run typecheck --workspace=pi-contracts`. [Local tarballs](../../docs/guides/distribution.md#build-local-tarballs) export emitted JavaScript and declarations.
