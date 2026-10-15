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
| Permissions tests + `npm run test:stock --workspace=pi-permissions` | Rule precedence, constrained classifier output, genuine user context, native hooks and block-before-write |
| Goal tests | Independent scripted evaluator, deadlines/budgets, stop/resume, wait delivery and accounting |
| `test:packages` | Packs and installs all ten packages in a fresh consumer; native entrypoints and compiled child tooling work without checkout resolution |
| `test:e2e` | Native context, child tools, jobs, permissions and installed-consumer workflows |

Tests use temporary agent directories and scripted providers/HTTP. They prove lifecycle and
observable effects without contacting real providers. They do not prove live classifier judgement
or account behaviour. Real-provider checks must be reported separately with their limits.

CI runs on macOS and Linux with Node 24 and native file helpers. It does not install or configure
an OS sandbox. A hosted run that never executed is unavailable evidence, not a passing check.

For UI changes inspect captures rendered by Pi's actual components and, where possible, a terminal
instance. A browser approximation alone does not establish terminal layout or input behaviour.
