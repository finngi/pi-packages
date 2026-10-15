# Publication

This public repository started from a reviewed snapshot of reusable code, with fresh Git history.
Older history, local install notes, personal profiles and research stay out of it. Do not push
private branches, sessions or profile files here.

Publishing this repository and publishing to npm are separate steps. Package manifests are marked
`private` so nothing reaches npm by accident. Local tarball builds create installable manifests,
and CI never publishes. Before any future npm release, choose scoped names you own and review the
packed files.

Before a release, run `npm run check:boundary` and look at the `npm pack` output. The boundary
check rejects personal host paths and private research directories, but it is not a full secret
scanner. The first snapshot was also scanned with Gitleaks before it was pushed.

The repository has its own AGENTS.md, project skills, lockfile and CI, and does not depend on the
surrounding personal workspace. Private packages can follow the same design while keeping their
code and settings elsewhere.
