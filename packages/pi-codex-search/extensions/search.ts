/**
 * Native Pi adapter for the Responses web-search port.
 * Based on Leechael/pi-codex-search v0.1.6; see LICENSE.pi-codex-search.
 */
import { calculateCost, clampThinkingLevel, Type } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { SECURITY_PRESENCE } from "pi-contracts";
import {
  MAX_CONCURRENCY,
  MAX_QUERIES,
  MAX_QUERY_TEXT_CHARS,
  SearchError,
  classifyError,
  fetchCodexModels,
  accountIdFromToken,
  runResponsesSearch,
  selectDefaultModel,
  type Freshness,
  type SearchBatch,
  type SearchContextSize,
  type SearchFailure,
  type SearchSuccess,
} from "../lib/search.ts";

const PROVIDER = "openai-codex";
const SECURITY_EVENT = "pi-security:service:v1";
const BACKEND_ORIGIN = "https://chatgpt.com";

const citationSchema = Type.Object({
  title: Type.Optional(Type.String()),
  url: Type.String(),
  startIndex: Type.Optional(Type.Number()),
  endIndex: Type.Optional(Type.Number()),
});
const searchCallSchema = Type.Object({
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  actionType: Type.Optional(Type.String()),
});
const usageSchema = Type.Object({
  inputTokens: Type.Optional(Type.Number()),
  outputTokens: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  cacheReadTokens: Type.Optional(Type.Number()),
  reasoningTokens: Type.Optional(Type.Number()),
});
const successSchema = Type.Object({
  query: Type.String(),
  text: Type.String(),
  textTruncated: Type.Optional(Type.Boolean()),
  citations: Type.Array(citationSchema),
  searchCalls: Type.Array(searchCallSchema),
  responseId: Type.Optional(Type.String()),
  usage: Type.Optional(usageSchema),
});
const failureSchema = Type.Object({
  query: Type.String(),
  kind: Type.Union([
    Type.Literal("auth"),
    Type.Literal("rate_limit"),
    Type.Literal("transport"),
    Type.Literal("timeout"),
    Type.Literal("schema"),
    Type.Literal("unknown"),
  ]),
  message: Type.String(),
  status: Type.Optional(Type.Number()),
  usage: Type.Optional(usageSchema),
});
const outputSchema = Type.Object({
  model: Type.String(),
  submittedReasoningEffort: Type.Optional(
    Type.String({
      description:
        "Reasoning effort value included in the Responses request body; this records submission and does not guarantee provider execution.",
    }),
  ),
  freshness: Type.Union([Type.Literal("live"), Type.Literal("cached"), Type.Literal("indexed")]),
  searchContextSize: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
  ]),
  queryCount: Type.Number(),
  failedQueryCount: Type.Number(),
  successes: Type.Array(successSchema),
  failures: Type.Array(failureSchema),
  partial: Type.Boolean(),
  elapsedMs: Type.Number(),
});

export interface SearchExtensionDependencies {
  fetchImpl?: typeof fetch;
  security?: "required" | "off";
}

/** Per-call capability issued by the active pi-security service after exact tool admission. */
export interface SearchCapability {
  readonly origin: string;
  readonly signal: AbortSignal;
  assertCurrent(input: unknown): void;
  dispatch<T>(
    input: unknown,
    url: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  release(): void;
}

interface SearchSecurityService {
  version: 1;
  prepareSearch(spec: {
    toolCallId: string;
    input: unknown;
    signal?: AbortSignal;
  }): SearchCapability;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = [
    ...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined)),
  ];
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function publicMessage(error: unknown): string {
  if (error instanceof SearchError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Codex search was cancelled.";
  return "Codex search could not be completed.";
}

function formatResult(batch: SearchBatch): string {
  const blocks = batch.successes.map((success) => {
    const sourceList = success.citations
      .map(
        (citation, index) =>
          `${index + 1}. ${citation.title?.trim() || citation.url}: ${citation.url}`,
      )
      .join("\n");
    const suffix = success.textTruncated
      ? `\n\n[Answer text truncated at ${MAX_QUERY_TEXT_CHARS} characters.]`
      : "";
    return `Query: ${success.query}\n\n${success.text || "(no response text)"}${suffix}${sourceList ? `\n\nSources:\n${sourceList}` : ""}`;
  });
  for (const failure of batch.failures)
    blocks.push(`Query: ${failure.query}\n\nSearch ${failure.kind}: ${failure.message}`);
  return blocks.join("\n\n---\n\n") || "Codex search returned no results.";
}

/** Matches openai-codex-responses streamSimple's runtime clamp and request mapping. */
export function resolveNativeReasoningEffort(
  model: ExtensionToolContext["model"],
  level: ModelThinkingLevel | undefined,
): string | undefined {
  if (!model || !level || !model.reasoning) return undefined;
  const clamped = clampThinkingLevel(model, level);
  if (clamped === "off") {
    // The native Codex provider serializes its model's off mapping, defaulting to "none";
    // a null mapping explicitly means that off is unsupported and must be omitted.
    return model.thinkingLevelMap?.off === null
      ? undefined
      : (model.thinkingLevelMap?.off ?? "none");
  }
  return model.thinkingLevelMap?.[clamped] ?? clamped;
}

async function parallelMap<T, U>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  work: (item: T, index: number) => Promise<U>,
): Promise<PromiseSettledResult<U>[]> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await work(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildBatch(
  model: string,
  freshness: Freshness,
  searchContextSize: SearchContextSize,
  queries: string[],
  settled: PromiseSettledResult<SearchSuccess>[],
  startedAt: number,
): SearchBatch {
  const successes: SearchSuccess[] = [];
  const failures: SearchFailure[] = [];
  settled.forEach((entry, index) => {
    const query = queries[index]!;
    if (entry.status === "fulfilled") {
      const value = entry.value;
      successes.push(
        value.text.length > MAX_QUERY_TEXT_CHARS
          ? { ...value, text: value.text.slice(0, MAX_QUERY_TEXT_CHARS), textTruncated: true }
          : value,
      );
    } else
      failures.push({
        query,
        kind: classifyError(entry.reason),
        message: publicMessage(entry.reason),
        ...(entry.reason instanceof SearchError && entry.reason.status
          ? { status: entry.reason.status }
          : {}),
        ...(entry.reason instanceof SearchError && entry.reason.usage
          ? { usage: entry.reason.usage }
          : {}),
      });
  });
  return {
    model,
    freshness,
    searchContextSize,
    queryCount: queries.length,
    failedQueryCount: failures.length,
    successes,
    failures,
    partial: failures.length > 0 && successes.length > 0,
    elapsedMs: Date.now() - startedAt,
  };
}

function createTool(deps: SearchExtensionDependencies = {}) {
  return {
    name: "codex_search",
    label: "Codex Search",
    description:
      "Search the web through Pi's signed-in OpenAI Codex account. Returns provider answer text and the actual URL citations annotated by the Codex Responses stream.",
    promptSnippet: "Search the web through the signed-in OpenAI Codex account.",
    promptGuidelines: [
      "For codex_search, use freshness 'live' for current facts, 'cached' for stable facts, and 'indexed' for indexed web access.",
      "Cite only provider URL annotations returned by codex_search; an empty citation list supplies no sources.",
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
        minItems: 1,
        maxItems: MAX_QUERIES,
        description: "Search questions to run in parallel (up to 32).",
      }),
      search_context_size: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description: "Amount of web context. Defaults to medium.",
        }),
      ),
      freshness: Type.Optional(
        Type.Union([Type.Literal("live"), Type.Literal("cached"), Type.Literal("indexed")], {
          description: "Choose live, cached, or OpenAI-indexed web access. Defaults to live.",
        }),
      ),
    }),
    outputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(
      _id: string,
      params: { queries: string[]; search_context_size?: SearchContextSize; freshness?: Freshness },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionToolContext,
      grant?: SearchCapability,
    ) {
      if (!grant || grant.origin !== BACKEND_ORIGIN)
        throw new Error("Codex search requires an active pi-security search capability.");
      const queries = params.queries.map((query) => query.trim());
      if (queries.some((query) => query.length === 0))
        throw new SearchError("schema", "Search queries must not be empty.");
      const toolSignal = combineSignals(signal, ctx.signal, grant?.signal);
      const assertCurrent = () => grant.assertCurrent(params);
      const guardedFetch: typeof fetch = async (input, init) => {
        assertCurrent();
        const url = input instanceof Request ? input.url : String(input);
        return await grant.dispatch(params, url, (capabilitySignal) =>
          (deps.fetchImpl ?? fetch)(input, {
            ...init,
            signal: combineSignals(init?.signal ?? undefined, capabilitySignal),
          }),
        );
      };
      toolSignal?.throwIfAborted();
      assertCurrent();
      const startedAt = Date.now();
      let providerAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>>;
      try {
        providerAuth = await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER), toolSignal);
      } catch {
        toolSignal?.throwIfAborted();
        throw new SearchError(
          "auth",
          "Pi could not resolve OpenAI Codex credentials. Check `/login openai-codex` in Pi and retry.",
        );
      }
      toolSignal?.throwIfAborted();
      assertCurrent();
      if (typeof providerAuth?.source !== "string" || providerAuth.source.toLowerCase() !== "oauth")
        throw new SearchError(
          "auth",
          "A Pi OpenAI Codex OAuth sign-in is required. Run `/login openai-codex` in Pi.",
        );
      const token = providerAuth.auth.apiKey;
      if (typeof token !== "string" || !token.trim())
        throw new SearchError(
          "auth",
          "OpenAI Codex sign-in is unavailable. Run `/login openai-codex` in Pi.",
        );
      // The account comes from this resolved token; stock auth exposes no credential metadata.
      const accountId = accountIdFromToken(token)?.trim();
      if (!accountId)
        throw new SearchError(
          "auth",
          "The OpenAI Codex account id is missing. Run `/login openai-codex` in Pi.",
        );
      let model = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
      if (!model) {
        assertCurrent();
        const models = await fetchCodexModels({
          token,
          accountId,
          signal: toolSignal,
          fetchImpl: guardedFetch,
        });
        assertCurrent();
        model = selectDefaultModel(models);
        if (!model)
          throw new SearchError("unknown", "Codex model lookup returned no available models.");
      }
      toolSignal?.throwIfAborted();
      assertCurrent();
      const freshness = params.freshness ?? "live";
      const searchContextSize = params.search_context_size ?? "medium";
      const reasoningEffort =
        model === ctx.model?.id && ctx.model?.provider === PROVIDER
          ? resolveNativeReasoningEffort(ctx.model, ctx.thinkingLevel)
          : undefined;
      let completed = 0;
      const emit = (text: string) => {
        assertCurrent();
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { partial: true, completed, total: queries.length },
        });
      };
      if (queries.length > 1) emit(`Searching ${completed}/${queries.length} in progress`);
      const settled = await parallelMap(queries, MAX_CONCURRENCY, toolSignal, async (query) => {
        assertCurrent();
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          return await runResponsesSearch({
            query,
            model: model!,
            token: token!,
            accountId,
            freshness,
            searchContextSize,
            reasoningEffort,
            sessionId,
            threadId: sessionId,
            signal: toolSignal,
            fetchImpl: guardedFetch,
            onTextDelta: queries.length === 1 ? (delta) => emit(delta) : undefined,
          });
        } finally {
          completed++;
          if (queries.length > 1)
            emit(
              `Searching ${completed}/${queries.length} ${completed === queries.length ? "complete" : "in progress"}`,
            );
        }
      });
      toolSignal?.throwIfAborted();
      assertCurrent();
      const normalized = settled.map(
        (entry, index): PromiseSettledResult<SearchSuccess> =>
          entry.status === "fulfilled"
            ? { status: "fulfilled", value: { query: queries[index]!, ...entry.value } }
            : entry,
      );
      const result = buildBatch(
        model,
        freshness,
        searchContextSize,
        queries,
        normalized,
        startedAt,
      );
      if (reasoningEffort !== undefined) result.submittedReasoningEffort = reasoningEffort;
      toolSignal?.throwIfAborted();
      assertCurrent();
      let invalid = 0;
      const receipts = [...result.successes, ...result.failures].map((entry) => {
        const receipt = entry.usage;
        if (
          receipt &&
          (Object.values(receipt).some(
            (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
          ) ||
            (receipt.cacheReadTokens ?? 0) > (receipt.inputTokens ?? 0) ||
            (receipt.reasoningTokens ?? 0) > (receipt.outputTokens ?? 0))
        ) {
          invalid++;
          return undefined;
        }
        return receipt;
      });
      const missing = receipts.filter((receipt) => receipt === undefined).length - invalid;
      const partial = receipts.filter(
        (receipt) =>
          receipt && (receipt.inputTokens === undefined || receipt.outputTokens === undefined),
      ).length;
      const warnings: string[] = [];
      if (invalid)
        warnings.push(`${invalid} search receipt(s) have invalid token counts and were omitted.`);
      if (missing) warnings.push(`${missing} search request(s) have no provider usage receipt.`);
      if (partial) warnings.push(`${partial} search receipt(s) have incomplete token counts.`);
      let usage: Usage | undefined;
      const pricedModel = receipts.some(
        (receipt) => receipt?.inputTokens !== undefined || receipt?.outputTokens !== undefined,
      )
        ? ctx.modelRegistry.find(PROVIDER, model)
        : undefined;
      for (const receipt of receipts) {
        if (!receipt || (receipt.inputTokens === undefined && receipt.outputTokens === undefined))
          continue;
        usage ??= {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const cached = receipt.cacheReadTokens ?? 0;
        usage.input += (receipt.inputTokens ?? 0) - cached;
        usage.cacheRead += cached;
        usage.output += receipt.outputTokens ?? 0;
        if (receipt.reasoningTokens !== undefined)
          usage.reasoning = (usage.reasoning ?? 0) + receipt.reasoningTokens;
        if (pricedModel) {
          const cost = calculateCost(pricedModel, {
            input: (receipt.inputTokens ?? 0) - cached,
            output: receipt.outputTokens ?? 0,
            cacheRead: cached,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          });
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
            usage.cost[key] += cost[key];
        }
      }
      if (usage) {
        usage.totalTokens = usage.input + usage.cacheRead + usage.output;
        if (!pricedModel)
          warnings.push(`No catalogue price for ${PROVIDER}/${model}; search cost is unknown.`);
      }
      const warningText = warnings.length
        ? `\n\nUsage warning: ${warnings.join(" ")} Totals are a known lower bound.`
        : "";
      return {
        content: [{ type: "text" as const, text: formatResult(result) + warningText }],
        ...(usage ? { usage } : {}),
        details: { ...result, ...(warnings.length ? { piUsageWarnings: warnings } : {}) },
        structuredContent: result as never,
        ...(result.successes.length === 0 ? { isError: true } : {}),
      };
    },
  };
}

export function registerCodexSearch(
  pi: ExtensionAPI,
  deps: SearchExtensionDependencies = {},
): void {
  const tool = createTool(deps);
  const unwrappedExecute = tool.execute;
  tool.execute = async (...args: Parameters<typeof unwrappedExecute>) => {
    const services: unknown[] = [];
    pi.events.emit(SECURITY_EVENT, {
      version: 1,
      respond: (service: unknown) => services.push(service),
    });
    const service = services[0] as Partial<SearchSecurityService> | undefined;
    let selected = process.env.PI_SECURITY_TRANSPORT === "extensions";
    pi.events.emit(SECURITY_PRESENCE, {
      respond: (active: boolean) => {
        selected ||= active;
      },
    });
    if (deps.security === "off" && (selected || services.length))
      throw Error("Disable pi-security before selecting unrestricted search");
    if (!selected && services.length === 0 && deps.security !== "required") {
      const signal = combineSignals(args[2], args[4].signal) ?? new AbortController().signal;
      const unrestricted: SearchCapability = {
        origin: BACKEND_ORIGIN,
        signal,
        assertCurrent() {
          signal.throwIfAborted();
        },
        async dispatch(_input, url, operation) {
          signal.throwIfAborted();
          if (new URL(url).origin !== BACKEND_ORIGIN)
            throw Error("Unexpected Codex backend origin");
          const result = await operation(signal);
          signal.throwIfAborted();
          return result;
        },
        release() {},
      };
      return unwrappedExecute(args[0], args[1], args[2], args[3], args[4], unrestricted);
    }
    if (
      services.length !== 1 ||
      service?.version !== 1 ||
      typeof service.prepareSearch !== "function"
    ) {
      throw new Error(
        "Codex search requires exactly one active pi-security service; search is refused.",
      );
    }
    const capability = service.prepareSearch({
      toolCallId: args[0],
      input: args[1],
      signal: combineSignals(args[2], args[4].signal),
    });
    try {
      if (
        !capability ||
        capability.origin !== BACKEND_ORIGIN ||
        !(capability.signal instanceof AbortSignal) ||
        typeof capability.assertCurrent !== "function" ||
        typeof capability.dispatch !== "function" ||
        typeof capability.release !== "function"
      )
        throw new Error("Invalid pi-security search capability; search is refused.");
      return await unwrappedExecute(args[0], args[1], args[2], args[3], args[4], capability);
    } finally {
      capability?.release?.();
    }
  };
  pi.registerTool(tool);
}

export function createCodexSearchExtension(deps: SearchExtensionDependencies = {}) {
  return (pi: ExtensionAPI): void => registerCodexSearch(pi, deps);
}

export default function codexSearchExtension(pi: ExtensionAPI): void {
  createCodexSearchExtension()(pi);
}

export { createTool as createCodexSearchTool };
