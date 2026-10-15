# Pi API reuse

Tested against Pi 1.2.0. Pi modules are peer dependencies.

| Area | Taken from Pi | Added here |
|---|---|---|
| Packages | Resolver, trust, identity, filters and reload | Reading `pi.agents` and `pi.instructions` |
| Skills | Loaded skills, `SKILL.md` parsing, on-demand bodies | Session selection and private agent skills |
| Instructions | Prompt sections and context files | Selected snippets and local files |
| Login | ModelRuntime and Pi's credential and model stores | Child model setup, with no second login |
| Child sessions | Stock RPC protocol and session records | Agent IDs, messages, collected files and lifecycle |
| MCP and codemode | Pi's integration and nested tool calls | Nothing; no separate transport |
| Search | Model registry login | Fixed backend, bounded parsing and citations |
| Goals | Model calls and structured tool schemas | Separate assessment and goal-scoped continuation |
| Usage | Provider events, session stats and tool-result usage | De-duplicated child, classifier and evaluator records |
| UI | Pi components and renderer APIs | Shared resource browser and optional personal styling |

In this SDK version the public RPC client cannot attach to a process started elsewhere. Delegation
therefore speaks the documented JSONL protocol over the shared process manager, without patching
private `RpcClient` members. Children do not inherit MCP connections, but do inherit selected
extension tools that have a loadable source.
