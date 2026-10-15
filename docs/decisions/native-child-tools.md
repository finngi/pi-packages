# Native package tools in children

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
Resolved credential snapshots and fallback streaming adapters are removed. Native providers use
native configuration and auth; custom callback providers require their trusted extension entrypoint.
The optional permission package contributes its entrypoint, settings and the parent's user
messages through the trusted child-launch event, independently of selected tool provenance.

Each child owns its managed jobs. Reuse Bash's existing managed-process path for `background:true`
in headless sessions. Keep native tool usage and the existing RPC statistics reconciliation; do not
add a search-specific ledger or count tool receipts twice.

Tests exercise actual child processes: inherited and narrowed tools, independent provider login,
search, background launch/read/cancel, shutdown, native authentication refresh locking, package
settings ignored at startup and repeated usage reconciliation. No extra live model calls are needed
to establish these launch and accounting properties.

## Guidance scopes

Children resolve saved personal/project skill and instruction choices independently of the
parent's temporary session selections. The agent bundle supplies the child's specific behavior
and private skills. Copying the parent's rendered instruction section was simpler initially, but it made a
parent's temporary choice silently change specialist workers. Reuse native resolved skill paths
and saved selection helpers; the optional context provider renders only saved instructions.
Agent metadata may explicitly select available native skills, so shared skills remain reusable
without becoming an implicit dependency on the parent's current selection. Existing children
retain their launch snapshot; tools and permission hooks keep their separate launch rules.
