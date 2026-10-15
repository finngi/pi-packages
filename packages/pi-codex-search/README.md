# pi-codex-search

Codex Responses web search for Pi using OAuth resolved at runtime through Pi's model registry. The tool returns provider answer text, actual URL citations, search calls, usage, and partial failures. It exposes search queries only, through a fixed backend protocol.

Reported search tokens enter Pi’s normal totals through native tool-result usage, including
nested calls. Model-catalogue prices supply estimates; missing receipts or prices produce explicit
accounting warnings in results and `/costs` when the shared accounting extension is loaded.
Costs remain estimates and do not establish a separate subscription charge.

Search resolves credentials directly through Pi's native model registry and follows native tool-call admission. Load the optional `pi-permissions` package to gate visible calls. HTTP requests stay at the fixed Codex backend origin; redirects, cancellation, invalid OAuth and malformed responses fail with bounded errors.

Loading this package registers `codex_search`. `pi-delegation` children inherit it
when selected in the parent and allowed by their agent tool list. They use the same native Codex
authentication backing, independently of the worker model provider.

- [Search parameters, outputs, and bounds](../../docs/reference/tools.md#search-tool).
- [Upstream baseline and licence](../../docs/reference/packages.md#distribution-and-provenance); retained [MIT text](LICENSE.pi-codex-search).

Source entrypoint: [extensions/search.ts](extensions/search.ts). From the repository root, run `npm run test --workspace=pi-codex-search`, `npm run typecheck --workspace=pi-codex-search`, and `npm run test:e2e --workspace=pi-codex-search`. The native SDK tests use synthetic OAuth and scripted HTTP, exercise direct and nested admission and accounting, and make no live search/model request. See [testing](../../docs/testing.md).
