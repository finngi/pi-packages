# Personal configuration

Pi reads personal settings from `~/.pi/agent/settings.json` and trusted project settings from
`.pi/settings.json`. Package sources can be local directories, Git or npm. Keep the existing
agent directory when changing packages so native login, sessions and retained results remain.

| Reusable capability | Personal choice |
|---|---|
| Delegation | Agent definitions, models, selected tools/skills |
| Background jobs | Commands and display preferences |
| Permissions | Whether loaded, mode (off/ask/auto), allow/deny rules, classifier model |
| Goals | Evaluator model and timeout |
| Context | Selected instructions and project overlays |
| Presentation | Themes, layout, timestamps and footer |

`personal-interactive` contains terminal-only rendering and themes. `personal-extensions` contains
context transformations usable in interactive, print and RPC sessions. These are ordinary private
Pi packages, not special launcher modes. Use public renderer/header/footer APIs; do not patch
Pi's private classes. Credential storage and MCP remain native Pi configuration.

Configure goal evaluation in native settings:

```json
{"goal":{"evaluator":{"model":"provider/model","timeoutSec":30}}}
```

The optional [permission gate](../../packages/pi-permissions/README.md) uses a user-owned policy
file. Without it, commands use ordinary host permissions. Package selection does not change that.
