# Pi API reuse

The tested SDK baseline is Pi 1.2.0. Host modules are peer dependencies.

| Area | Reused from Pi | Added here |
|---|---|---|
| Packages | Native resolver, trust, identity, filters and reload | Metadata for `pi.agents` and `pi.instructions` |
| Skills | Loaded native pool, `SKILL.md` parsing and lazy bodies | Session selection and child-private bundles |
| Instructions | Native prompt sections and context files | Selected behavior snippets and local overlays |
| Authentication | ModelRuntime and native credential/model stores | Selected child model configuration, no second login |
| Child sessions | Stock RPC protocol and session records | Agent identities, messages, retained results and lifecycle |
| MCP/codemode | Stock Pi integration and nested tool pipeline | No separate transport or confinement implementation |
| Search | Model registry authentication | Fixed backend, bounded protocol parsing and citations |
| Goals | Native model calls and structured tool schemas | Independent assessment and scoped continuation |
| Usage | Provider events, session stats and tool-result usage | Deduplicated child/classifier/evaluator receipts |
| UI | Native components and renderer APIs | Shared resource browser and optional personal presentation |

The public RPC client cannot attach to an externally managed process in this SDK version.
Delegation therefore uses the documented JSONL protocol on the shared process manager. No private
RpcClient members are patched. Native MCP connections are not inherited by child processes;
selected source-backed extension tools are.
