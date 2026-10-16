# Working on Pi packages

This repository contains independent Pi extensions and shared libraries under `packages/`.
Use [the package reference](docs/reference/packages.md) to find their responsibilities and
entrypoints. Package READMEs describe usage and limits; `docs/decisions/` records architectural
choices. Published packages are experimental alpha releases.

## Principles

- Solve a concrete need with the smallest complete workflow. Reuse repository code, native Pi,
  standard libraries and installed dependencies before adding another mechanism.
- Keep capabilities independently useful and dependencies explicit. Importing a library must
  not activate another extension, start a process or change permissions.
- Keep model context deliberate and inspectable. Load skill bodies on demand; preserve project
  context and recorded session data. Reuse Pi's resource loading, sessions and accounting.
- Make effects, failures, cancellation and persistence understandable. An optional permission gate
  reviews calls; commands otherwise use ordinary host permissions.
- Keep personal policies, credentials and presentation preferences outside reusable packages.
  Resolve package resources from their package root, not a particular checkout or home directory.
- Verify observable behaviour on stock Pi. Test installed packages when distribution changes;
  workspace imports alone do not prove that consumers work. Inspect real captures for UI changes.

These principles adapt [Pi's approach](https://github.com/earendil-works/pi/tree/v1.2.0)
and apply to the personal packages developed alongside this repository.

## Development

Use Node 24 and the Pi SDK versions pinned in the root lockfile. Host Pi modules are peers with
`*` ranges; the development pin defines the tested version. Preserve the subprocess RPC boundary.

Use [package-development](.pi/skills/package-development/SKILL.md) when implementing a package
change and [package-review](.pi/skills/package-review/SKILL.md) when reviewing one. Both are native
project skills; they are contributor guidance, not resources shipped by the packages.

Run affected workspace tests and `npm run check`. See [testing](docs/testing.md) for stock-Pi,
subprocess and packed-consumer checks. `npm run check:docs` checks links;
`npm run check:boundary` checks public source boundaries.

Review the diff and stage specific files, preserving unrelated work. Source updates and staged
builds may proceed while Pi runs; leave active processes and runtime/cache bindings unchanged.
Activate only after affected processes exit and activation is requested. Keep source manifests
`private: true`; publishing npm packages requires explicit user authorization.
