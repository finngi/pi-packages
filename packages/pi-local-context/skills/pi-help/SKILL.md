---
name: pi-help
description: Use when configuring Pi or working on its SDK, extensions, skills, model providers, MCP integration, or TUI.
---

# Pi harness help

Run `node scripts/paths.mjs`, resolving the script relative to this skill directory. It returns the
installed Pi package's README, documentation directory, and examples directory.

Read the documentation for the feature you are changing and follow relevant references. Resolve
`docs/` and `examples/` links against the returned directories. Use the installed SDK's public APIs
and examples as the reference for signatures and formats.
