# Package tools in children

The old launcher rebuilt a fixed set of seven tools and copied only the worker's login. So a
package tool the parent had selected was missing in children, and a search tool loaded by hand
could still lack its own Codex login.

## Decision

Find the entrypoints of the parent's selected tools from Pi's tool source data. The child's Pi
loader loads them, and its tool allowlist leaves out unselected tools. An agent's `tools` list can
only narrow the parent's set. Messaging is bound separately, and the parent's control tools stay
out of the child. Inline SDK tools need a loadable adapter. Passing MCP connections is out of
scope. We never guess executable paths.

Children start with Pi's public SDK and stock RPC host, using in-memory settings and transcripts.
This avoids Pi's CLI re-reading package settings that may have changed since the parent started.
It adds no RPC protocol, package resolver or credential store.

Children read the original auth and model files. The worker's model settings, such as a custom
endpoint or context limit, apply to that model; other models stay available. Using the same auth
path keeps Pi's file lock and OAuth refresh working. A symlink per child was rejected: the lock is
per path, so different links could race a token refresh. Copied credentials and fallback streaming
adapters are gone. Custom callback providers need their extension entrypoint.

The permission package sends its entrypoint, settings and your messages through the child-launch
event, separately from tool selection.

Each child owns its jobs, using Bash's existing `background: true` path in headless sessions.
Search usage stays in Pi's tool-result usage plus the existing session-stats reconciliation; there
is no search-specific ledger and nothing is counted twice.

Tests run real child processes: inherited and narrowed tools, separate provider login, search,
background launch, read and cancel, shutdown, auth refresh locking, package settings ignored at
start, and repeated usage reconciliation. No live model calls are needed for these.

## Guidance scopes

Children use saved personal and project skill and instruction choices, not the parent's session
choices, plus their agent bundle. Copying the parent's rendered instruction section was simpler at
first, but then a choice made for one parent session silently changed specialist workers. We reuse
Pi's resolved skill paths and the saved-selection helpers, and the context extension renders only
saved instructions. Agent files can name any loaded skill, so shared skills stay reusable without
depending on the parent's current selection. Running children keep their launch copy; tools and
permission hooks follow their own launch rules.
