# Pi packages

Extensions for [Pi](https://github.com/earendil-works/pi). Each feature is its own package, so you
load only what a session needs:

- **Delegation**: run child Pi sessions, message them and keep their results.
- **Background jobs**: run shell commands in the background, read their output, cancel them.
- **Permissions**: check tool calls by rule, by asking you, or with a classifier model.
- **Goals**: keep Pi working on one objective until an evaluator says it is done.
- **Context**: add personal `AGENTS.local.md` files and selected instruction snippets.
- **Resources**: choose which skills, agents and instructions a session uses.
- **Codex search**: web search using your Pi Codex login.

Shared libraries hold common code. Importing one never turns on an extension.

Published versions are experimental alpha releases. Passing tests only shows what those tests
cover; it does not establish real-provider search quality or model judgement.

A parent session can hand work to child sessions. By default a child works in its own scratch
directory and the parent reviews what it produces. A child can also work directly in the project
([workspace modes](docs/guides/delegation.md#choose-where-files-go)). Either way, tools run with
your normal user permissions. The optional permission package can check calls before they run.

## Install

With Node 24 and Pi 1.2.0, install only the capabilities you need:

```sh
pi install npm:@finngi/pi-background@alpha
pi install npm:@finngi/pi-delegation@alpha
```

All seven extensions use the `@finngi` scope and `alpha` tag. Shared libraries are bundled;
you do not install them separately. See [packages](docs/reference/packages.md) for the full list.

## Develop from the checkout

You need Node 24. The repository pins Pi 1.2.0.

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

On macOS, `npm run test:e2e` runs the full integration check. See [testing](docs/testing.md).

- [Get started](docs/getting-started.md): build the checkout and launch a session.
- [Documentation](docs/index.md): guides, architecture and reference.
- [Packages](docs/reference/packages.md): what each package does and depends on.
- [Install and distribute](docs/guides/distribution.md): load from Git or build local tarballs.
- [Development layout](docs/guides/development-packages.md): how the repository is organised.
- [Design decisions](docs/decisions/native-thin-slices.md): why the packages are split this way.

## Personal settings

Keep your own models, permission rules, agents and themes in a
[local profile](docs/guides/local-profiles.md), not in these packages. Goals have no default
evaluator model, so choose one when you use goals.

## Licence

[MIT](LICENSE). Packages derived from other projects keep their upstream notices.
[Publication](docs/publication.md) explains how this repository was separated from private history.
