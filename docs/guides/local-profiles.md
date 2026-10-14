# Configure a local profile

The packages supply mechanisms and minimal Pi-theme renderers. An installation supplies policy,
model choices, agent bundles, skills and optional display overrides. The library does not own the
user's credentials, personal directories or repository layout.

| Reusable package behavior | Local choice |
|---|---|
| Delegation, messaging, workspaces and retained results | Agent definitions, selected tools/skills and models |
| Process lifecycle and output buffering | Commands and display preferences |
| Policy validation, kernel execution and narrowed child authority | Hosts, directories, command rules, permission/classifier settings |
| Goal criteria, evaluation, budgets and waiting | Evaluator provider/model and timeout |
| Context discovery and metadata stripping | Personal and project instructions |
| Theme-aware semantic labels | Compact layout, colors, spacing and cost presentation |

For goal evaluation, pass `--goal-evaluator-model provider/model` from trusted launch configuration.
For security, set `PI_SECURITY_POLICY` to a reviewed local copy of the policy template. Configure
trusted executable directories for the host installation. MCP servers and credentials use Pi's
native configuration and authentication.

Use Pi's `registerToolRenderer` and message-renderer APIs for display overrides. Keep local UI code
outside the shared packages; it must not replace effect tools or broaden permission checks. Choose
an installation that explicitly admits those user-owned extensions. Presentation changes apply to
new processes or a supported resource reload, not by mutating an active runtime installation.
