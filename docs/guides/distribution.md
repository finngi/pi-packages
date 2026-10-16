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

## Prepare a public alpha

Only the seven capability packages receive gallery metadata. Their shared libraries stay bundled;
users do not install or register those separately. Source manifests remain private to prevent
accidentally publishing the TypeScript development layout.

See [develop and release](releases.md) for versioning, local trials and CI downloads.
After the ordinary package checks pass, prepare scoped npm artifacts:

```sh
node scripts/pack.mjs --scope YOUR_NPM_ACCOUNT
PI_PACKAGE_SCOPE=YOUR_NPM_ACCOUNT node --test --test-name-pattern="each artifact" tests/packages.test.ts
```

Use a lowercase npm account or organization name. This creates seven
`ACCOUNT-pi-NAME-VERSION.tgz` files in `.artifacts/public-packages`. `VERSION` is the root
manifest version. Each is a native Pi package
that points to its bundled extension, preserving the existing internal package names and imports.
The published README includes an exact installation command and links to the public documentation.
The `pi-package` keyword makes these packages eligible for Pi's gallery; the `alpha` tag and
prerelease version identify their status. No helper-library gallery entries are created.

The scoped check installs each artifact alone and exercises its actual stock-Pi behavior, including
launching a child. It does not measure real search quality or classifier/evaluator judgement.
Review the tarball contents and check npm authentication before publishing the tested files:

```sh
npm whoami
npm publish .artifacts/public-packages/ACCOUNT-pi-background-VERSION.tgz --access public --tag alpha
```

Repeat the publish command only for the capability artifacts selected for release. Packing and
testing do not publish, activate the local harness, or change running sessions. Publication requires
an authenticated npm account with permission to use that scope.

A Git checkout can run the TypeScript helpers directly with Node 24. Installed packages run the
built JavaScript from `node_modules`. See [packages](../reference/packages.md) for dependencies and
versions.

## Verify catalog discovery separately

An npm release and its Pi catalog listing are separate checks. Verify the public version and
download first, then npm name search and Pi's catalog filter. A working direct Pi detail page does
not establish that the package appears in catalog search.

The `pi-package` keyword establishes eligibility, not a listing guarantee. npm documents that new
packages [can take up to two weeks to appear in search](https://docs.npmjs.com/searching-for-and-choosing-packages-to-download/).
`searchScore` is a query-ranking value, not a code-quality verdict. If discovery remains missing,
collect package names, publish times, metadata and failing search queries for
[npm registry support](https://www.npmjs.com/support). A metadata-only version bump is not a
documented indexing fix; publish again when a concrete package change justifies it.

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
