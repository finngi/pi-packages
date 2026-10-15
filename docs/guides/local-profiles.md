# Local profiles

Your personal setup lives in Pi's own settings, not in these packages. Pi reads personal settings
from `~/.pi/agent/settings.json` and trusted project settings from `.pi/settings.json`. Package
sources can be local folders, Git or npm. Keep the same agent directory when you change packages,
so your login, sessions and collected files stay.

| Package | What you choose |
|---|---|
| Delegation | Agents, their models, tools and skills |
| Background jobs | Commands and display preferences |
| Permissions | Whether it is loaded, mode (`off`, `ask` or `auto`), allow and deny rules, classifier model |
| Goals | Evaluator model and timeout |
| Context | Selected instructions and local files |
| Presentation | Themes, layout, timestamps and footer |

The private `personal-interactive` package holds terminal rendering and themes.
`personal-extensions` holds context changes that work in interactive, print and RPC sessions.
They are ordinary Pi packages, not special modes. Use Pi's public renderer, header and footer
APIs rather than patching Pi's private classes. Credentials and MCP stay in Pi's own
configuration.

Set the goal evaluator in Pi's settings:

```json
{"goal":{"evaluator":{"model":"provider/model","timeoutSec":30}}}
```

The optional [permission package](../../packages/pi-permissions/README.md) reads its rules from
your personal settings. Without it, commands run with your normal user permissions. Choosing
packages does not change that.
