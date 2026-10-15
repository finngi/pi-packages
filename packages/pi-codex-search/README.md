# pi-codex-search

Web search for Pi through the Codex Responses API, using the OpenAI Codex login Pi already has.
Loading the package registers `codex_search`. It returns the provider's answer, the URLs it cited,
its search calls, usage and any partial failures. It only sends search queries, to one fixed
backend.

The login is looked up through Pi's model registry each time the tool runs. Requests stay on the
fixed Codex backend. Redirects, cancellation, invalid logins and malformed replies end in short,
clear errors. Load `pi-permissions` if you want calls checked first.

Search usage is added to Pi's normal totals through the tool result, including when search runs
inside another tool. Prices come from the model catalogue. Missing usage or prices show a warning
in the result and in `/costs`, when shared accounting is loaded. Costs are estimates, not a separate
subscription charge.

Children of `pi-delegation` get `codex_search` when the parent has it selected and the agent's tool
list allows it. They use the same Codex login, whatever model the child runs.

- [Parameters, results and limits](../../docs/reference/tools.md#search-tool)
- [Upstream source and licence](../../docs/reference/packages.md#provenance), with the original
  [MIT text](LICENSE.pi-codex-search)

## Tests

From the repository root:

```sh
npm run test --workspace=pi-codex-search
npm run typecheck --workspace=pi-codex-search
npm run test:e2e --workspace=pi-codex-search
```

The SDK tests use a fake login and scripted HTTP. They cover direct and nested calls, permission
checks and accounting, and make no real search or model requests. Entrypoint:
[extensions/search.ts](extensions/search.ts). See [testing](../../docs/testing.md).
