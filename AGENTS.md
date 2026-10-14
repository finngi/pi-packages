# Working in Pi extensions

Read [DESIGN.md](DESIGN.md) before changing architecture or introducing a dependency. This
repository is self-contained; a surrounding personal workspace is not required.

This repository contains independently selectable Pi extensions and shared libraries. Keep package
dependencies explicit. Shared libraries must not create global registries or automatically activate extensions.

Use Node 24 and the pinned stock Pi SDK. Host Pi modules belong in peerDependencies with the `*`
range; the development version is pinned at the root. Preserve the subprocess RPC boundary.

Run the affected package tests and typecheck. For launch, accounting or security changes, also run
the stock-Pi integration tests and relevant kernel checks. Test packed packages for distribution
changes: workspace resolution alone does not prove an installed consumer works.

Keep security selection explicit. If enabled security is unavailable or rejects a launch, return
an error; never fall back to an unrestricted launch. Without security, report host permissions.

Stage specific files and preserve unrelated changes. Repository updates, pushes, pulls, merges and
staged runtime installation may proceed while Pi is running. Leave running Pi processes and their
runtime/cache bindings unchanged. Activate a new release only after processes using the prior
runtime have exited. Publishing npm packages requires explicit user authorization.
