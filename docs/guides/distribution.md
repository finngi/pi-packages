# Install and distribute

Choose between loading the source checkout, selecting extensions from Git, and producing local package tarballs. All paths use the host Pi SDK; shared libraries do not install or activate Pi for you.

## Load source entrypoints

Run the pinned CLI as shown in [getting started](../getting-started.md), or pass absolute entrypoint paths to an existing Pi 1.2.0 installation. Explicit paths make the selected extension set visible. Security sessions must use the [security launch order](security.md).

Pi 1.2.0 accepts a Git package source with an extension filter in its package settings:

```json
{
  "source": "git:https://github.com/finngi/pi-packages@<reviewed-commit>",
  "extensions": [
    "packages/pi-bg/extensions/background-process.ts",
    "packages/pi-subagents/extensions/subagent.ts"
  ]
}
```

Replace `<reviewed-commit>` with the revision you intend to run. The root manifest declares six
extension entrypoints, including the sandbox, plus the optional
`pi-help` skill. Filters can select skills independently of extensions. Follow the
[security launch instructions](security.md) before enabling all six extensions.

## Build local tarballs

From the repository root:

```sh
npm ci --ignore-scripts
npm run pack
npm run test:packages
```

`pack` builds ten tarballs in `.artifacts/packages`: seven extension packages and three shared libraries. It does not publish anything. The source manifests are private; the packing script prepares distribution manifests with JavaScript entrypoints and declaration exports. Each tarball includes its README, license files, and provenance file when present. The set also includes security profiles, the optional Pi-help skill and its resource script. The consumer test installs all ten tarballs into a fresh directory and loads the entrypoints and compiled file helper from `node_modules`.

Install the required tarballs together into a consumer project, including the shared libraries declared in each extension's package dependencies. `pi-subagents` works independently of `pi-bg`; both reuse the shared process library. `pi-permissions` is separately packed and is not included in the repository-root aggregate manifest, which retains the existing sandbox entrypoint. Do not assume that a source-workspace import proves an installed consumer can resolve the same files.

Git checkouts can execute TypeScript helper sources with Node 24. Installed packages execute emitted JavaScript helpers from `node_modules`. See [package dependencies and SDK pins](../reference/packages.md).

## Embed with the Pi 1.2.0 SDK

Use `DefaultResourceLoader` with `noExtensions: true` and explicit `additionalExtensionPaths`, then reload it before `createAgentSession`. As on the CLI, this excludes discovered and built-in extensions; include a built-in explicitly only when required. A confined embedder must supply `noTools: "builtin"` and exclude `powershell`, load security first, and select a trusted reviewed policy before the extensions initialize.

When embedding, supply Pi's built-in extension factories through `extensionFactories` before using `builtin:` entrypoint aliases. The CLI supplies those factories automatically; a bare SDK resource loader does not. Use the factories from the pinned SDK's `dist/extensions/index.js`.

Peer dependency ranges are `*` because the running Pi host supplies its modules. This is not a compatibility claim for every SDK version: development and integration use Pi 1.2.0. Avoid installing an independent host copy inside each extension and creating conflicting tool or service owners.

Security reads trusted launch configuration from the process environment. Align `process.cwd()` with the SDK session's `cwd` before loading its tool factories: policy initialization uses the session directory, but effect-tool factories capture the process directory. Passing a different session `cwd` alone can therefore resolve relative tools inconsistently. `PI_SECURITY_POLICY` must identify a host-selected file, not a model- or project-controlled choice. The SDK's `noContextFiles` resource-loader setting does not reach local-context's argv check; an embedder disabling that overlay must also supply `--no-context-files` in the host arguments.

The SDK is a trusted host boundary. Custom extensions and serializable credential adapters need review; a callback provider cannot automatically be transferred into a child process. Children use per-launch credential snapshots, without automatic renewal. See [configuration](../reference/configuration.md) and [security limits](security.md).

Implementation: [root manifest](../../package.json), [packing script](../../scripts/pack.mjs), [build script](../../scripts/build.mjs), and [consumer tests](../../tests/packages.test.ts).
