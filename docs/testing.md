# Test a contribution

Use Node 24 and the root lockfile (Pi 1.2.0):

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

`check` runs formatting, lint and workspace TypeScript checks. Run an affected package's tests
while developing; run the combined checks before merging a cross-package migration.

| Check | Evidence |
|---|---|
| Delegation tests | Actual stock Pi parent/child processes, selected tools/model/skills, messages, cancellation and retained artifacts |
| Resources/context tests | Native filters, session/project/global selection, project trust, prompt separation and resume |
| Background tests | Actual managed commands, output cursors, cancellation and process ownership |
| Search tests | Native registry auth, scripted HTTP, citations, usage and abort/error handling |
| Permissions tests + `npm run test:stock --workspace=pi-permissions` | Rule matching, modes, session allows, classifier replies and timeouts, and blocking before a write on stock Pi |
| Goal tests | Independent scripted evaluator, deadlines/budgets, stop/resume, wait delivery and accounting |
| `test:packages` | Installs each artifact alone with stock Pi in a separate consumer, exercises extension behavior and library APIs, then runs a separate combined child integration |
| `test:e2e` | Native context, child tools, jobs, permissions and installed-consumer workflows |

Tests use temporary agent directories and scripted providers/HTTP. They prove lifecycle and
observable effects without contacting real providers. They do not prove live classifier judgement
or account behaviour. Real-provider checks must be reported separately with their limits.

CI runs on macOS and Linux with Node 24 and native file helpers. It does not install or configure
an OS sandbox. A hosted run that never executed is unavailable evidence, not a passing check.

For UI changes inspect captures rendered by Pi's actual components and, where possible, a terminal
instance. A browser approximation alone does not establish terminal layout or input behaviour.

## Independent artifact proof

`npm run test:packages` builds the candidate and installs exactly one repository tarball in each
fresh consumer, alongside stock Pi 1.2.0 host peers. Sibling top-level packages must be absent.
Tests import and execute the installed files; the source checkout is not an alternate resolver.
The npm download cache may be shared, but consumers do not share `node_modules`.

| Artifact | Observable use in its fresh consumer |
| --- | --- |
| `pi-background` | Launch, read and cancel a managed job while a foreground command runs |
| `pi-delegation` | Launch a real child RPC process, write a project file and close the child |
| `pi-resources` | Exclude/select a native skill and inspect the resulting lazy prompt description |
| `pi-context` | Load local context and selected instructions into the actual stock prompt |
| `pi-goal` | Start, pause, inspect and clear a goal through native commands/tools |
| `pi-codex-search` | Execute fixture HTTP search with native auth, citation output and usage |
| `pi-permissions` | Allow a read and deny a write before a file is created |
| `pi-contracts` | Import event identifiers and exchange a payload using the defined event |
| `pi-runtime` | Use token accounting and run a managed subprocess |
| `pi-resource-browser` | Search resources through the exported BM25/prefix API |

Only the seven extension entrypoints activate; the three helper artifacts are ordinary libraries.
A separate combined install checks shared session setup, resume/reset and compiled child tools.
The permissions fixture checks the configured read allowance and write denial. These
deterministic providers and HTTP responses prove package mechanics,
not live search quality, model judgement or a future Pi version.
