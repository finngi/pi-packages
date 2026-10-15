# Testing

Use Node 24 and the root lockfile, which pins Pi 1.2.0:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run check:boundary
npm run check:docs
npm test
npm run test:packages
npm run test:e2e
```

`check` runs formatting, lint and TypeScript checks. `check:docs` checks relative links and
`check:boundary` checks that no private paths are in the public source. While you work, run the
tests for the package you changed. Run everything before merging a change that spans packages.

| Tests | What they cover |
|---|---|
| Delegation | Real stock-Pi parent and child processes, selected tools, model and skills, messages, cancellation and collected files |
| Resources and context | Independent session/project/global choices and project/global session types, all four pickers' keyboard/mouse controls, frozen defaults, resume, invalid saved defaults, missing resources, project trust and prompt sections |
| Background | Real commands, output cursors, cancellation and process ownership |
| Search | Pi registry login, scripted HTTP, citations, usage, cancellation and errors |
| Permissions, plus `npm run test:stock --workspace=pi-permissions` | Rule matching, modes, session allows, classifier replies and timeouts, and that a denied write never happens on stock Pi |
| Goals | Scripted evaluator, deadlines, budgets, stop and resume, waits and accounting |
| `test:packages` | Installs each tarball alone with stock Pi in its own fresh project, exercises it, then runs a separate combined child check |
| `test:e2e` | Context, child tools, jobs, permissions and the installed-package workflows |

Tests use temporary agent directories and scripted providers and HTTP. They check lifecycles and
visible effects without calling real providers, so they say nothing about how well a real
classifier judges calls or how a real account behaves. Report any real-provider check separately,
with its limits.

`packages/pi-resources/test/scoped-picker-paths-stock.test.ts` drives the actual native pickers
against temporary personal/project settings and persisted sessions. The child-resource stock test
captures real RPC child prompts: interactive-only skill/instruction markers must appear in the TUI
parent and be absent from children, including explicit public-skill requests. It also checks that
rereading defaults leaves live children running. Neither test uses the normal profile or existing sessions.

CI runs on macOS and Linux with Node 24. It does not set up a sandbox. A CI job that did not run is
not a pass.

For UI changes, look at captures rendered by Pi's real components, and in a real terminal where
you can. A browser mock-up does not show terminal layout or input behaviour.

## Installed-package checks

`npm run test:packages` builds the packages and installs exactly one tarball into each fresh
project, next to stock Pi 1.2.0. No sibling package is installed at the top level. Tests import and
run the installed files; the checkout is never used to resolve them. Projects may share npm's
download cache but not `node_modules`.

| Tarball | What its fresh project checks |
| --- | --- |
| `pi-background` | Launch, read and cancel a job while a foreground command runs |
| `pi-delegation` | Launch a real child over RPC, write a project file and close the child |
| `pi-resources` | Exclude and select a skill and check the description in the prompt |
| `pi-context` | Load local context and selected instructions into the real prompt |
| `pi-goal` | Start, pause, inspect and clear a goal with its commands and tools |
| `pi-codex-search` | Run a scripted search with Pi login, citations and usage |
| `pi-permissions` | Allow a read and deny a write before the file is created |
| `pi-contracts` | Import event names and exchange a payload on one event |
| `pi-runtime` | Record token usage and run a managed subprocess |
| `pi-resource-browser` | Search resources with the exported BM25 and prefix API |

Only the seven extensions load as extensions; the other three are plain libraries. A separate
combined install checks shared session setup, resume and reset, and compiled child tools. Scripted
providers and HTTP replies test how the packages work, not search quality, model judgement or
future Pi versions.
