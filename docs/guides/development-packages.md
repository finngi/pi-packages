# Development packages

Experimental source packages, not published releases or a supported harness. Use Node 24 and
the pinned stock Pi 1.2.0 checks. Source hosting, tests and live activation are separate steps.

## Layout

```text
pi-packages/                  public repository
  AGENTS.md                  contributor guidance
  DESIGN.md                  shared design principles
  package.json               development workspace
  packages/<name>/            manifest, README, implementation and tests
  docs/                      guides and decisions
  scripts/                   existing build, pack and validation commands
  tests/                     installed-package integration checks
```

Use native `extensions/`, `skills/`, `prompts/` and `themes/` folders when needed, or declare
explicit paths in `package.json`. Keep the existing library `src/` layouts. Add no empty folders,
package scaffolding or second loader. Agent bundles and their scripts stay together; our two
capability extensions additionally recognise `pi.agents` and `pi.instructions` directories.
See [the manifest example and boundaries](../decisions/native-thin-slices.md#resource-location-and-cross-extension-behaviour).

The private repository keeps `packages/personal-interactive` and `packages/personal-extensions`.
Credentials, sessions and machine preferences stay in Pi's native user configuration, outside
both source repositories. Each source package currently remains `private: true`; no release
workflow is needed during this experimental stage.

## Interactive choices

| Needed behaviour | Load |
| --- | --- |
| Stock interactive Pi | Nothing extra |
| Selected instructions, `/instructions` and instruction session setup | `pi-local-context` |
| Child agents, `/agents`, our `/skills` and `/packages` pickers | `pi-subagents` |
| Personal tool presentation and available themes | Private `personal-interactive` |
| Model-facing timestamps, including print/RPC | Private `personal-extensions`; enable `modelTime` separately |

For our resource-selection workflow, start with **`pi-local-context` + `pi-subagents`**.
Libraries (`pi-runtime`, `pi-contracts`, `pi-resource-browser`) resolve through dependencies;
do not select them as extensions. `pi-bg`, `pi-goal` and `pi-codex-search` are optional features.
Agents do not require `pi-bg`. `pi-permissions` and the full `pi-security` sandbox are optional
alternatives with their own configuration, not requirements of interactive Pi.

The repository root still has a legacy aggregate manifest that includes the sandbox. Use
individual package directories, not that root, as the basis of a personal setup.

## Local paths, without publishing

Native `pi -e /absolute/package/path` loads that package for one invocation without saving a
default. Repeat `-e` for additional packages. Local dependencies are the author's responsibility;
run `npm ci --ignore-scripts` and `npm run build` in the public checkout first.

To try these packages without automatically loading other extensions, run the pinned CLI
from the repository root:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --no-extensions \
  -e ./packages/pi-local-context -e ./packages/pi-subagents --subagent-security=off
```

`--no-extensions` excludes automatically discovered and built-in extensions; explicit `-e`
entries still load. Native authentication and project context continue to apply. Existing
processes and saved package settings are unchanged.

For future sessions, native `pi install /absolute/package/path` saves personal defaults;
`pi install --local /absolute/package/path` saves a trusted project's defaults.

## Inside an open session

`/packages` and `session_setup` select skills, agents and instructions already discovered by
the session. They do not install packages, activate/unload executable extensions or change
permissions. UI/theme-only packages do not appear as resource groups there; use `/theme` for
loaded themes. Picker changes are session-only; Ctrl+S saves project defaults and Ctrl+Shift+S
saves personal defaults. Resumed sessions retain recorded choices.

New executable packages need native installation/configuration and an idle `/reload` for
ordinary changes. Runtime/security replacements or already-running children need a managed
restart. Existing children keep their launched configuration.

Configured packages containing only agents/instructions are discoverable. Temporary `-e`
packages containing only those custom types are not yet discoverable as package groups;
configure them through native settings. Do not add a fake extension to work around this.

See [session setup](../reference/tools.md#session-setup),
[distribution](distribution.md) and [checks](../testing.md).
