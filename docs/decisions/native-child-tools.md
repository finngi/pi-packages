# Native package tools in children

Status: candidate, verified on stock Pi 1.2 with security off. Secured-launcher changes are a
separate review-only patch pending approval. Existing sessions and installed runtimes are unchanged.

The previous launcher rebuilt a seven-tool subset and copied only worker authentication. This
made a selected package tool unavailable to children, and a search tool loaded manually could
still lack its independent Codex OAuth login. Those are launch-model mismatches.

Use native tool provenance to find the entrypoints for selected parent tools. The child's native
loader loads those entrypoints and its tool allowlist excludes unselected tools. Agent tool lists
only narrow the parent selection. Keep communication separately bound and parent session controls
out of the child. Inline SDK tools need a loadable adapter; native MCP connection transfer remains
out of scope. Guessing executable paths is not supported.

Use Pi's public SDK startup and stock RPC host with in-memory settings and transcripts. This small
bootstrap avoids native CLI package resolution of settings that may have changed since parent startup.
It does not implement another RPC protocol, package resolver or credential store.

Native model/authentication runtime reads the original auth and model paths. Selected worker
metadata, including a custom endpoint or context limit, remains authoritative for that model;
other native model types remain available. Using the identical auth path preserves Pi's file lock
and OAuth refresh. A symlink under each child directory was
rejected because the native lock is based on the path, so different links can race token rotation.
The existing resolved-model snapshot remains a fallback for supported SDK-only worker providers;
it does not replace working native provider authentication.

Each child owns its managed jobs. Reuse Bash's existing managed-process path for `background:true`
in headless sessions. Keep native tool usage and the existing RPC statistics reconciliation; do not
add a search-specific ledger or count tool receipts twice.

Tests exercise actual child processes: inherited and narrowed tools, independent provider login,
search, background launch/read/cancel, shutdown, native authentication refresh locking, package
settings ignored at startup and repeated usage reconciliation. No extra live model calls are needed
to establish these launch and accounting properties.
