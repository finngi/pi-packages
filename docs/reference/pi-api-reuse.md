# Pi API reuse

The compatibility baseline is `@earendil-works/pi-coding-agent` 1.2.0, with
`@earendil-works/pi-mcp` 1.2.0. Extensions use the host's modules through peer dependencies.

## Shared behavior and extension responsibilities

| Area | Pi behavior reused | Responsibility retained here |
| --- | --- | --- |
| Agent definitions | Public `parseFrontmatter`; Markdown definitions follow Pi's subagent example | Directory-owned bundles, selected-source identity, project trust, capability previews and scoped resources |
| Skills | Public `loadSkillsFromDir`; ordinary `SKILL.md` files and explicit `--skill` loading | Child-only catalogues, private/public precedence and protected bundle staging |
| Instructions | Mutable `BuildSystemPromptOptions.contextFiles` and Pi context loading | Retaining the selected static context when the child's working directory changes; excluding parent conversation and dynamic state |
| Metadata removal | Pi's public `stripFrontmatter`, with explicit closed-block handling | Keeping eager instruction metadata out of model context while preserving unclosed blocks and source files |
| Child processes | Pi CLI in documented RPC mode | Session-owned process lifetime, stream limits, artifact retention and routed agent dialogue |
| MCP | Public `createMcpExtension` and `StreamableHttpTransport`; Pi's config, credentials, manager and assigned tool names | Binding a security approval to an owned connection, actual tool call and exact operation |
| Search | Pi's model-registry authentication | The fixed Codex search protocol, bounded result handling and search capability policy |
| Codemode | Pi's built-in QuickJS executor and ordinary nested tool pipeline | Trusted activation and retained security decisions for nested tools; `models.*` remains outside Seatbelt |
| Goal evaluation | Pi's model registry, structured tool schema, and provider completion | Independent assessment at worker settlement, append-only evaluator history, fixed criteria, blocker counting and scoped continuation |
| Usage | Pi's provider events, session statistics and supported tool-result usage | Reconciling separate child sessions and forwarding reported usage once |

The custom discovery and process code is not a replacement for the Pi runtime. It supplies the
ownership and security semantics needed by the extensions.

## RPC client boundary

Pi's exported `RpcClient` is suitable for integrations where it owns the child process. In 1.2.0,
it cannot attach to a process managed by another transport, and it exposes no public method for
sending extension-UI responses. Delegation therefore uses the documented JSONL RPC protocol through
`pi-background`, including the extension request/response frames required for approvals and routed messages.
No private `RpcClient` members are patched.

## Pinned internal helpers

The secured MCP adaptor uses Pi's shipped internal MCP configuration and header-resolution helpers
where the public factory does not expose the required policy lookup. These imports depend on the
pinned package layout. An SDK update needs the actual CLI/RPC and installed-package checks in
[testing](../testing.md); a matching function name alone does not establish equivalent behavior.

See [architecture](../architecture.md), [package pins](packages.md), [delegation](../guides/delegation.md),
and [security](../guides/security.md) for the operational contracts.
