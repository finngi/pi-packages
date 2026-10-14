# Publication and private history

This public repository starts from a reviewed reusable source snapshot with a fresh Git history.
Older development history, local installation reports, personal profiles and research material
remain outside it. Do not push private development refs, sessions or profile files here.

The monorepo contains independently selectable native Pi packages. Repository publication and
npm publication are separate actions. The source manifests remain private to prevent accidental
npm releases; local tarball checks prepare installable distribution manifests. Nothing in CI
publishes npm packages. Choose owned scoped names and review release artifacts before a future
registry release.

Run `npm run check:boundary` and inspect `npm pack` output before releasing. The boundary checker
rejects personal host paths and private research directories but is not a complete credential
scanner. The initial snapshot was also checked with Gitleaks before its public push.

The public repository includes its own DESIGN.md, AGENTS.md, lockfile and CI workflow. It does
not depend on the surrounding personal workspace. Private packages may follow the same design
principles while keeping their implementation and settings outside this repository.
