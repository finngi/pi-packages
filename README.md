# Pi packages

Experimental development packages. They are not released or ready to use as a supported harness.
Passing isolated checks establishes only the behaviour covered by those checks.
See [the development layout and package loading guide](docs/guides/development-packages.md).

Extensions for [Pi](https://github.com/earendil-works/pi), with separate packages for delegation, background processes, security, goals, local instructions, and Codex search. Select the features a session needs; shared libraries provide contracts and common implementations without activating extensions.

A parent Pi session can delegate to child Pi processes, exchange messages, and retain their results. Children normally work in scratch directories, where they can prepare files for the parent to review and integrate. A child can also work in the project directory, where changes are immediately shared; the [workspace table](docs/architecture.md#workspaces-and-private-configuration) lists the configuration each mode supports. Optional security confines model file and shell tools through policy and kernel profiles; without it, tools have ordinary host permissions.

The development baseline is **Node 24 and Pi 1.2.0**. Use the Git checkout or build local package tarballs; see [installation and distribution](docs/guides/distribution.md) for the available paths.

- [Get started](docs/getting-started.md): build the checkout and launch a session.
- [Documentation](docs/index.md): task guides, architecture, and technical reference.
- [Package reference](docs/reference/packages.md): choose extensions and understand their dependencies.
- [Thin-slice decisions](docs/decisions/native-thin-slices.md): independent capabilities, native resource discovery and the small opt-in permission gate.
- [Contributing checks](docs/testing.md): test source, subprocess integration, and packed consumers.

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

For a complete integration check on macOS, also run `npm run test:e2e`. See [testing](docs/testing.md) for platform requirements and the limits of fixture evidence.

Each capability has its own package under `packages/`; this monorepo shares development tools and checks. The packages have not been published to npm.

Personal models, security rules, agent bundles and presentation preferences belong in a
[local profile](docs/guides/local-profiles.md). The goal evaluator has no provider-specific default;
configure an authenticated evaluator explicitly when using goals. Security is a selected feature,
not a prerequisite for delegation or background processes.

The code is covered by [MIT](LICENSE), with retained upstream notices in the relevant packages.
[Publication preparation](docs/publication.md) explains clean snapshots and private-history handling.
