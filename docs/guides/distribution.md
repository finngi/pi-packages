# Install and distribute

You can load the packages from this checkout, from Git, or from local tarballs. In every case your
Pi provides the SDK. The shared libraries never install or start Pi for you.

## Load from the checkout

Run the pinned CLI as in [getting started](../getting-started.md), or pass absolute entrypoint
paths to an existing Pi 1.2.0. Listing paths explicitly makes clear which extensions are on.

## Load from Git

Pi 1.2.0 accepts a Git source with an extension filter in its package settings:

```json
{
  "source": "git:https://github.com/finngi/pi-packages@<reviewed-commit>",
  "extensions": [
    "packages/pi-background/extensions/background-process.ts",
    "packages/pi-delegation/extensions/subagent.ts"
  ]
}
```

Replace `<reviewed-commit>` with the commit you want to run. The root manifest offers six
extension entrypoints and the optional `pi-help` skill. Pick what you need with Pi's filters, or
load package directories. The permission package is separate and is not in the root manifest.

## Build local tarballs

From the repository root:

```sh
npm ci --ignore-scripts
npm run pack
npm run test:packages
```

`pack` builds ten tarballs in `.artifacts/packages`: seven extensions and three libraries. It does
not publish anything. Each tarball has the built JavaScript, type declarations, README and
licences. Each extension tarball bundles the unpublished workspace packages it depends on, using
npm's `bundleDependencies`. Install just that tarball next to stock Pi; npm fetches public
dependencies and Pi supplies the peers. You do not need to install sibling tarballs first. Bundled
libraries are still only libraries and load no other extension.

`test:packages` installs each extension tarball alone in a fresh project with stock Pi, checks that
only its entrypoint loads, and exercises what it does. A separate combined check runs the compiled
child tools across packages. The projects may share npm's download cache but never `node_modules`.
The three library tarballs are checked through their public APIs; they are not Pi extensions.
Nothing is published.

A Git checkout can run the TypeScript helpers directly with Node 24. Installed packages run the
built JavaScript from `node_modules`. See [packages](../reference/packages.md) for dependencies and
versions.

## Embed with the Pi 1.2.0 SDK

Create a `DefaultResourceLoader` with `noExtensions: true` and explicit
`additionalExtensionPaths`, and reload it before `createAgentSession`. As on the CLI, this skips
discovered and built-in extensions. Add a built-in explicitly if you need it.

To use `builtin:` entrypoint aliases, pass Pi's built-in extension factories through
`extensionFactories`. The CLI does this for you; a bare SDK loader does not. Use the factories
from the pinned SDK's `dist/extensions/index.js`.

Pi modules are peer dependencies with `*` ranges because the running Pi supplies them. That is not
a promise that every SDK version works; development and tests use Pi 1.2.0. Do not install a
separate copy of Pi inside each extension, or tools and services will clash.

Use Pi's settings and ModelRuntime for login and models. The permission package reads your
personal settings. To turn off `pi-context`'s local files, pass `--no-context-files` in the host
arguments as well as `noContextFiles`.

The embedding code runs with full trust. Custom provider callbacks only work in children if they
come from an extension children can load, because functions cannot be serialized. Built-in
providers use the same auth and model storage, with Pi's normal refresh and locking, and no
per-launch copy of credentials.

Source: [root manifest](../../package.json), [pack script](../../scripts/pack.mjs),
[build script](../../scripts/build.mjs) and [package tests](../../tests/packages.test.ts).
