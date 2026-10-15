# Install and distribute

Choose between loading the source checkout, selecting extensions from Git, and producing local package tarballs. All paths use the host Pi SDK; shared libraries do not install or activate Pi for you.

## Load source entrypoints

Run the pinned CLI as shown in [getting started](../getting-started.md), or pass absolute entrypoint paths to an existing Pi 1.2.0 installation. Explicit paths make the selected extension set visible.

Pi 1.2.0 accepts a Git package source with an extension filter in its package settings:

```json
{
  "source": "git:https://github.com/finngi/pi-packages@<reviewed-commit>",
  "extensions": [
    "packages/pi-background/extensions/background-process.ts",
    "packages/pi-delegation/extensions/subagent.ts"
  ]
}
```

Replace `<reviewed-commit>` with the revision you intend to run. The aggregate manifest offers
six extension entrypoints and the optional Pi-help skill. Select individual capabilities through
native filters, or load their package directories. The permission gate is a separate opt-in package.

## Build local tarballs

From the repository root:

```sh
npm ci --ignore-scripts
npm run pack
npm run test:packages
```

`pack` builds ten tarballs in `.artifacts/packages`: seven extensions and three shared libraries.
It does not publish. Each includes emitted JavaScript, declarations, README and licenses. Each extension artifact bundles the unpublished workspace dependencies it declares using npm's
`bundleDependencies`. Install just that artifact alongside stock Pi; npm resolves ordinary public
dependencies and host peers. No sibling tarball preinstallation or custom package installer is
required. Bundled dependencies remain ordinary libraries and do not activate sibling extensions.

`test:packages` installs one extension artifact into each fresh stock-Pi consumer, verifies that
only its entrypoint activates, and exercises the package's actual behavior. A separate combined
integration check exercises compiled child tools across packages. Sharing a download cache is
allowed; sharing the consumers' `node_modules` is not. The three helper artifacts are ordinary
npm libraries, verified through their public APIs; they are not registered as Pi extensions.
Nothing is published by these checks.

Git checkouts can execute TypeScript helper sources with Node 24. Installed packages execute emitted JavaScript helpers from `node_modules`. See [package dependencies and SDK pins](../reference/packages.md).

## Embed with the Pi 1.2.0 SDK

Use `DefaultResourceLoader` with `noExtensions: true` and explicit `additionalExtensionPaths`, then reload it before `createAgentSession`. As on the CLI, this excludes discovered and built-in extensions; include a built-in explicitly only when required.

When embedding, supply Pi's built-in extension factories through `extensionFactories` before using `builtin:` entrypoint aliases. The CLI supplies those factories automatically; a bare SDK resource loader does not. Use the factories from the pinned SDK's `dist/extensions/index.js`.

Peer dependency ranges are `*` because the running Pi host supplies its modules. This is not a compatibility claim for every SDK version: development and integration use Pi 1.2.0. Avoid installing an independent host copy inside each extension and creating conflicting tool or service owners.

Use native settings and ModelRuntime for authentication and model access. The optional permission
gate reads its user-owned policy. Context overlay suppression is controlled by `--no-context-files`;
an SDK embedder wanting no overlay should supply that argument as well as `noContextFiles`.

The SDK is a trusted host. Custom provider callbacks need a trusted extension source to load in
children; executable functions cannot be serialized. Native providers use the same user auth/model
storage and its normal refresh/locking behaviour, without per-launch credential snapshots.

Implementation: [root manifest](../../package.json), [packing script](../../scripts/pack.mjs), [build script](../../scripts/build.mjs), and [consumer tests](../../tests/packages.test.ts).
