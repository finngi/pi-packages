# Development packages

These are experimental source packages, not releases. Use Node 24 and the pinned Pi 1.3.0. Hosting
the source, testing it and switching your own Pi over to it are separate steps.

## Layout

```text
pi-packages/                  public repository
  AGENTS.md                  principles and contributor guidance
  .pi/skills/                package development and review skills
  package.json               development workspace
  packages/<name>/           manifest, README, code and tests
  docs/                      guides and decisions
  scripts/                   build, pack and check commands
  tests/                     installed-package checks
```

Use Pi's `extensions/`, `skills/`, `prompts/` and `themes/` folders where you need them, or list
paths in `package.json`. Libraries keep their `src/` layout. Do not add empty folders, scaffolding
or a second loader. Keep agent bundles and their scripts together. Two extensions also read
`pi.agents` and `pi.instructions` directories. See
[the manifest example](../decisions/thin-slice-resources.md#decision).

A separate private repository holds `packages/personal-interactive` and
`packages/personal-extensions`. Credentials, sessions and machine preferences live in Pi's user
configuration, outside both repositories. Every package is `private: true`, and there is no
release workflow at this stage.

## Which packages to load

| You want | Load |
| --- | --- |
| Plain interactive Pi | Nothing extra |
| Selected instructions and `/instructions` | `pi-context` |
| Child agents and `/agents` | `pi-delegation` |
| `/skills`, `/packages` and session skill filtering | `pi-resources` |
| Personal tool rendering and themes | Private `personal-interactive` |
| Timestamps in model context, including print and RPC | Private `personal-extensions`, with `modelTime` enabled |

For choosing resources, load `pi-resources`, plus `pi-context` for instructions and
`pi-delegation` for agents. Each works on its own. `pi-runtime`, `pi-contracts` and
`pi-resource-browser` are libraries pulled in as dependencies; do not load them as extensions.
`pi-background`, `pi-goal`, `pi-codex-search` and `pi-permissions` are optional. Agents do not
need `pi-background`. `pi-permissions` checks calls but does not sandbox them.

## Try local packages

`pi -e /absolute/package/path` loads a package for one run without saving anything. Repeat `-e`
for more packages. You handle the package's dependencies: run `npm ci --ignore-scripts` and
`npm run build` in the checkout first.

To try packages without other extensions, run the pinned CLI from the repository root:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --no-extensions \
  -e ./packages/pi-resources -e ./packages/pi-context -e ./packages/pi-delegation
```

`--no-extensions` skips discovered and built-in extensions; `-e` entries still load. Your login and
project context still apply. Running processes and saved settings are not touched.

Packages that contain only agents or instructions work with `-e` too, from any directory, with no
saved registration, placeholder extension or extra profile.

To keep a package for future sessions, use `pi install /absolute/package/path` for personal
settings or `pi install --local /absolute/package/path` for the current trusted project.

## Inside a running session

`/packages` and `session_setup` choose among skills, agents and instructions the session already
found. They do not install packages, load or unload code, or change permissions. Packages with
only UI or themes do not appear there; use `/theme` for themes. Picker changes last for the
session. Ctrl+S saves project defaults and Ctrl+Shift+S saves personal defaults. These save
selections, not package registrations. Resumed sessions keep their recorded choices.

New code needs Pi's normal install or configuration, then an idle `/reload` or a new session.
Replacing code while children run needs a planned restart. Running children keep their setup.

See [session setup](../reference/tools.md#session-setup), [distribution](distribution.md) and
[testing](../testing.md).
