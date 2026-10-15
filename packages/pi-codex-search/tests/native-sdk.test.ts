import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelThinkingLevel,
  calculateCost,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createCodexSearchExtension,
  createCodexSearchTool,
  registerCodexSearch,
  resolveNativeReasoningEffort,
} from "../extensions/search.ts";
import { installAccounting } from "../../pi-runtime/src/accounting.ts";
import { accountIdFromToken } from "../lib/search.ts";
import { responsesFixture, streamFrom } from "./fixtures/responses-sse.ts";

const tokenFor = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;

function resultStream(
  model: Model<Api>,
  response: { id: string; name: string; arguments: Record<string, unknown> } | undefined,
  text: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response ? "toolUse" : "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  stream.push({ type: "start", partial });
  if (response) {
    const toolCall = {
      type: "toolCall",
      id: response.id,
      name: response.name,
      arguments: response.arguments,
    } as never;
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    stream.push({
      type: "done",
      reason: "toolUse",
      message: { ...partial, content: [toolCall], stopReason: "toolUse" } as never,
    });
  } else {
    stream.push({
      type: "done",
      reason: "stop",
      message: { ...partial, content: [{ type: "text", text }], stopReason: "stop" } as never,
    });
  }
  return stream;
}

async function sessionFor(
  path: string,
  route: "direct" | "codemode",
  requests: string[],
  outcomes: unknown[],
  queries = ["Pi 1.1.0 extension API"],
  denySearch = false,
  collectionOrder: "before" | "after" = "before",
  storedAccountId = "acct_stored",
  options: {
    freshness?: "live" | "cached" | "indexed";
    noPermissionCollector?: boolean;
    omitGrant?: boolean;
    missingOauth?: boolean;
    redirectResponses?: boolean;
    responseDelayMs?: number;
    concurrencyStats?: { active: number; max: number };
    codexModel?: boolean;
    searchCost?: Model<Api>["cost"];
    accounting?: boolean;
    responseSse?: (query: string) => string;
    sessionManager?: SessionManager;
    thinkingLevel?: ModelThinkingLevel;
    codexReasoning?: boolean;
    codexThinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  } = {},
) {
  let modelCalls = 0;
  const token = tokenFor(storedAccountId);
  const runtime = await ModelRuntime.create({
    authPath: join(path, "auth.json"),
    modelsPath: null,
    credentials: {
      async read(providerId) {
        return providerId === "openai-codex" && !options.missingOauth
          ? {
              type: "oauth",
              access: token,
              refresh: "synthetic-refresh",
              expires: Date.now() + 60 * 60_000,
              accountId: "acct_stored_must_be_ignored",
            }
          : undefined;
      },
      async list() {
        return options.missingOauth ? [] : [{ providerId: "openai-codex", type: "oauth" as const }];
      },
      async modify(providerId, update) {
        return update(
          providerId === "openai-codex" && !options.missingOauth
            ? {
                type: "oauth",
                access: token,
                refresh: "synthetic-refresh",
                expires: Date.now() + 60 * 60_000,
                accountId: "acct_stored_must_be_ignored",
              }
            : undefined,
        );
      },
      async delete() {},
    },
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("fake", {
    name: "Native tool test model",
    api: "fake-test",
    apiKey: "unused-test-key",
    models: [
      {
        id: "fake-model",
        name: "Fake",
        api: "fake-test",
        baseUrl: "https://model.invalid",
        input: ["text"],
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: (model, _context, _options) => {
      modelCalls++;
      if (modelCalls > 1)
        return resultStream(model, undefined, "The native search tool completed.");
      const args = {
        queries,
        freshness: options.freshness ?? "live",
        search_context_size: "medium",
      };
      const call =
        route === "direct"
          ? { id: "call_direct", name: "codex_search", arguments: args }
          : {
              id: "call_script",
              name: "codemode",
              arguments: {
                code: `const result = await tools.codex_search(${JSON.stringify(args)}); text(result.successes[0].text);`,
              },
            };
      return resultStream(model, call, "");
    },
  });
  if (options.codexModel || options.searchCost) {
    runtime.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      models: [
        {
          id: options.codexModel ? "gpt-6-luna" : "codex-default",
          name: "Synthetic Codex model",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          input: ["text"],
          reasoning: options.codexReasoning ?? true,
          contextWindow: 4096,
          maxTokens: 256,
          cost: options.searchCost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...(options.codexThinkingLevelMap
            ? { thinkingLevelMap: options.codexThinkingLevelMap }
            : {}),
        },
      ],
      streamSimple: (model, _context, _options) => {
        modelCalls++;
        if (modelCalls > 1)
          return resultStream(model, undefined, "The native search tool completed.");
        const args = {
          queries,
          freshness: options.freshness ?? "live",
          search_context_size: "medium",
        };
        const call =
          route === "direct"
            ? { id: "call_direct", name: "codex_search", arguments: args }
            : {
                id: "call_script",
                name: "codemode",
                arguments: {
                  code: `const result = await tools.codex_search(${JSON.stringify(args)}); text(result.successes[0].text);`,
                },
              };
        return resultStream(model, call, "");
      },
    });
  }
  const backend = async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(_input));
    assert.equal(init?.redirect, "manual");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { input?: Array<{ content?: Array<{ text?: string }> }> })
      : undefined;
    outcomes.push(
      body
        ? { ...body, accountHeader: new Headers(init?.headers).get("chatgpt-account-id") }
        : body,
    );
    if (String(_input).includes("/models"))
      return Response.json({ models: [{ slug: "codex-default", is_default: true }] });
    if (options.redirectResponses)
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" },
      });
    if (options.concurrencyStats) {
      options.concurrencyStats.active++;
      options.concurrencyStats.max = Math.max(
        options.concurrencyStats.max,
        options.concurrencyStats.active,
      );
    }
    if (options.responseDelayMs)
      await new Promise((resolve) => setTimeout(resolve, options.responseDelayMs));
    if (body?.input?.[0]?.content?.[0]?.text?.includes("failure"))
      return new Response("synthetic-token response secret", { status: 429 });
    const fixture =
      options.responseSse?.(body?.input?.[0]?.content?.[0]?.text ?? "") ?? responsesFixture;
    const response = new Response(streamFrom([new TextEncoder().encode(fixture)]), {
      headers: { "content-type": "text/event-stream" },
    });
    if (options.concurrencyStats) options.concurrencyStats.active--;
    return response;
  };
  const effectsFactory: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "codex_search" && options.omitGrant)
        return { block: true, reason: "permission policy is unavailable" };
    });
  };
  const searchFactory = createCodexSearchExtension({
    fetchImpl: backend,
  });
  const factories: ExtensionFactory[] = [
    ...(options.accounting ? [installAccounting] : []),
    ...(denySearch
      ? [
          (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) =>
            pi.on("tool_call", (event) =>
              event.toolName === "codex_search"
                ? { block: true, reason: "strict network policy fixture" }
                : undefined,
            ),
        ]
      : []),
    ...(!options.noPermissionCollector && collectionOrder === "before" ? [effectsFactory] : []),
    searchFactory,
    ...(!options.noPermissionCollector && collectionOrder === "after" ? [effectsFactory] : []),
    ...(route === "codemode" ? [createCodemodeExtension()] : []),
  ];
  const cwd = path;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path,
    extensionFactories: factories,
  });
  await resourceLoader.reload();
  const sessionResult = await createAgentSession({
    cwd,
    agentDir: path,
    modelRuntime: runtime,
    model: options.codexModel
      ? runtime.getModel("openai-codex", "gpt-6-luna")
      : runtime.getModel("fake", "fake-model"),
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    tools: route === "direct" ? ["codex_search"] : ["codemode", "codex_search"],
    resourceLoader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  await sessionResult.session.bindExtensions({ mode: "print" });
  return { ...sessionResult, runtime };
}

describe("Pi 1.2.0 native SDK paths", () => {
  for (const route of ["direct", "codemode"] as const) {
    it(`accounts search receipts once through ${route}, including cache, reasoning and resume`, async () => {
      const path = await mkdtemp(join(tmpdir(), "pi-search-usage-"));
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      let resumed: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        const searchCost = {
          input: 2,
          output: 8,
          cacheRead: 0.5,
          cacheWrite: 0,
          tiers: [{ inputTokensAbove: 20, input: 20, output: 80, cacheRead: 5, cacheWrite: 0 }],
        };
        const manager = SessionManager.create(path, join(path, "sessions"));
        created = await sessionFor(
          path,
          route,
          [],
          [],
          ["repeat", "repeat"],
          false,
          "before",
          "acct_test",
          {
            searchCost,
            sessionManager: manager,
            responseSse: () =>
              responsesFixture.replace(
                '"total_tokens":19',
                '"total_tokens":19,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":3}',
              ),
          },
        );
        await created.session.prompt("Search twice.");
        const stats = created.session.getSessionStats();
        assert.deepEqual(stats.tokens, {
          input: 16,
          output: 14,
          cacheRead: 8,
          cacheWrite: 0,
          total: 38,
        });
        const perRequest = {
          input: 8,
          output: 7,
          cacheRead: 4,
          cacheWrite: 0,
          totalTokens: 19,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        calculateCost(created.runtime.getModel("openai-codex", "codex-default")!, perRequest);
        assert.equal(
          stats.cost,
          perRequest.cost.total * 2,
          "price tiers apply per request, not per batch",
        );
        const messages = manager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
        assert.equal(messages.length, 1, "nested search receipts persist on the outer result only");
        const message = messages[0];
        assert.ok(message?.type === "message" && message.message.role === "toolResult");
        assert.equal(message.message.usage?.reasoning, 6, "reasoning remains an output subset");
        const file = manager.getSessionFile()!;
        created.session.dispose();
        created = undefined;
        resumed = await sessionFor(path, route, [], [], undefined, false, "before", "acct_test", {
          searchCost,
          sessionManager: SessionManager.open(file),
        });
        assert.deepEqual(resumed.session.getSessionStats().tokens, stats.tokens);
        assert.equal(resumed.session.getSessionStats().cost, stats.cost);
      } finally {
        created?.session.dispose();
        resumed?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    });

    it(`reports missing and partial search receipts honestly through ${route}`, async () => {
      const path = await mkdtemp(join(tmpdir(), "pi-search-missing-usage-"));
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          route,
          [],
          [],
          ["complete", "missing", "partial", "provider-error", "invalid"],
          false,
          "before",
          "acct_test",
          {
            accounting: true,
            responseSse: (query) =>
              query === "provider-error"
                ? 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"provider failed"},"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
                : query === "invalid"
                  ? responsesFixture.replace('"input_tokens":12', '"input_tokens":1.5')
                  : query === "missing"
                    ? responsesFixture.replace(
                        '"usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}',
                        '"status":"completed"',
                      )
                    : query === "partial"
                      ? responsesFixture.replace(
                          '{"input_tokens":12,"output_tokens":7,"total_tokens":19}',
                          '{"input_tokens":5}',
                        )
                      : responsesFixture,
          },
        );
        let result: any;
        created.session.subscribe((event) => {
          if (event.type === "tool_execution_end" && event.toolName === "codex_search")
            result = event.result;
        });
        await created.session.prompt("Search the batch.");
        assert.equal(created.session.getSessionStats().tokens.total, 29);
        assert.match(
          result.details.piUsageWarnings.join(" "),
          /1 search request\(s\) have no provider usage receipt/,
        );
        assert.match(
          result.details.piUsageWarnings.join(" "),
          /1 search receipt\(s\) have incomplete token counts/,
        );
        assert.match(
          result.details.piUsageWarnings.join(" "),
          /No catalogue price for openai-codex\/codex-default/,
        );
        assert.match(
          result.details.piUsageWarnings.join(" "),
          /1 search receipt\(s\) have invalid token counts and were omitted/,
        );
        assert.match(result.content[0].text, /Totals are a known lower bound/);
        const persisted = created.session.sessionManager
          .getEntries()
          .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
        assert.ok(persisted?.type === "message" && persisted.message.role === "toolResult");
        assert.deepEqual(
          (persisted.message.details as any).piUsageWarnings,
          result.details.piUsageWarnings,
        );
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    });
  }

  for (const route of ["direct", "codemode"] as const) {
    it(`discovers and executes codex_search through ${route}`, async () => {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(path, route, requests, outcomes);
        assert.ok(created.session.getAllTools().some((tool) => tool.name === "codex_search"));
        const results: unknown[] = [];
        created.session.subscribe((event) => {
          if (event.type === "tool_execution_end" && event.toolName === "codex_search")
            results.push(event.result);
        });
        await created.session.prompt("Use the requested search tool once.");
        assert.ok(requests.includes("https://chatgpt.com/backend-api/codex/responses"));
        const responseRequest = outcomes.find(
          (entry) => (entry as { model?: string } | undefined)?.model !== undefined,
        ) as { model: string; accountHeader?: string } | undefined;
        assert.equal(responseRequest?.model, "codex-default");
        assert.equal(responseRequest?.accountHeader, "acct_stored");
        assert.equal(requests.length, 2);
        assert.ok(created.session.messages.some((message) => message.role === "toolResult"));
        assert.equal(results.length, 1);
        assert.ok(JSON.stringify(results[0]).includes("https://example.com/source"));
        assert.equal(JSON.stringify(results[0]).includes("synthetic-test-token"), false);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    });
  }

  for (const route of ["direct", "codemode"] as const) {
    it(`submits runtime HIGH as reasoning.effort through ${route}`, async () => {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-thinking-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          route,
          requests,
          outcomes,
          undefined,
          false,
          "before",
          "acct_stored",
          { codexModel: true, thinkingLevel: "high" },
        );
        let searchResult: unknown;
        created.session.subscribe((event) => {
          if (event.type === "tool_execution_end" && event.toolName === "codex_search")
            searchResult = event.result;
        });
        await created.session.prompt("Use the requested search tool once.");
        const responseRequest = outcomes.find(
          (entry) => (entry as { model?: string } | undefined)?.model !== undefined,
        ) as { model: string; reasoning?: { effort?: string }; accountHeader?: string } | undefined;
        assert.equal(responseRequest?.model, "gpt-6-luna");
        assert.deepEqual(responseRequest?.reasoning, { effort: "high" });
        assert.equal(responseRequest?.accountHeader, "acct_stored");
        assert.equal(
          (
            searchResult as
              | { structuredContent?: { submittedReasoningEffort?: string } }
              | undefined
          )?.structuredContent?.submittedReasoningEffort,
          "high",
        );
        assert.equal(JSON.stringify(searchResult).includes("synthetic-refresh"), false);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    });
  }

  it("matches native Codex off, minimal, model mapping, unsupported and unset behavior", () => {
    const reasoningModel = {
      id: "synthetic",
      name: "Synthetic",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
      reasoning: true,
      contextWindow: 4096,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" },
    } as unknown as Model<Api>;
    assert.equal(resolveNativeReasoningEffort(reasoningModel, "high"), "high");
    assert.equal(resolveNativeReasoningEffort(reasoningModel, "off"), "none");
    assert.equal(resolveNativeReasoningEffort(reasoningModel, "minimal"), "low");
    assert.equal(
      resolveNativeReasoningEffort(
        {
          ...reasoningModel,
          thinkingLevelMap: { ...reasoningModel.thinkingLevelMap, high: "medium" },
        },
        "high",
      ),
      "medium",
    );
    assert.equal(
      resolveNativeReasoningEffort(
        { ...reasoningModel, thinkingLevelMap: { ...reasoningModel.thinkingLevelMap, high: null } },
        "high",
      ),
      "medium",
    );
    assert.equal(
      resolveNativeReasoningEffort(
        { ...reasoningModel, thinkingLevelMap: { ...reasoningModel.thinkingLevelMap, off: null } },
        "off",
      ),
      "low",
    );
    assert.equal(
      resolveNativeReasoningEffort({ ...reasoningModel, reasoning: false }, "high"),
      undefined,
    );
    assert.equal(resolveNativeReasoningEffort(reasoningModel, undefined), undefined);
  });

  it("sends off/minimal and SDK-clamped efforts in native direct requests", async () => {
    for (const scenario of [
      { level: "off", map: { off: "none", minimal: "low" }, expected: { effort: "none" } },
      { level: "minimal", map: { off: "none", minimal: "low" }, expected: { effort: "low" } },
      {
        level: "high",
        map: { off: "none", minimal: null, low: "low", medium: "medium", high: null },
        expected: { effort: "medium" },
      },
    ] as const) {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-thinking-map-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          "direct",
          requests,
          outcomes,
          undefined,
          false,
          "before",
          "acct_stored",
          {
            codexModel: true,
            thinkingLevel: scenario.level,
            codexThinkingLevelMap: scenario.map,
          },
        );
        await created.session.prompt("Use the requested search tool once.");
        const responseRequest = outcomes.find(
          (entry) => (entry as { model?: string } | undefined)?.model !== undefined,
        ) as { reasoning?: { effort?: string } } | undefined;
        assert.deepEqual(responseRequest?.reasoning, scenario.expected);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    }
  });

  it("uses the current runtime-resolved token account after an account swap", async () => {
    for (const storedAccountId of ["acct_first", "acct_second"]) {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-account-swap-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          "direct",
          requests,
          outcomes,
          undefined,
          false,
          "before",
          storedAccountId,
        );
        await created.session.prompt("Use the requested search tool once.");
        const responseRequest = outcomes.find(
          (entry) => (entry as { model?: string } | undefined)?.model !== undefined,
        ) as { accountHeader?: string } | undefined;
        assert.equal(responseRequest?.accountHeader, storedAccountId);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    }
  });

  it("preserves stock auth shape and uses the token from concurrent refresh and account swaps", async () => {
    const store = new InMemoryCredentialStore();
    await store.modify("synthetic-oauth", async () => ({
      type: "oauth",
      access: tokenFor("acct_before"),
      refresh: "refresh-token",
      expires: Date.now() + 60 * 60_000,
      accountId: "acct_before",
    }));
    let refreshCalls = 0;
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("synthetic-oauth", {
      name: "Synthetic OAuth",
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      oauth: {
        name: "Synthetic OAuth",
        login: async () => ({
          access: "unused",
          refresh: "unused",
          expires: Date.now() + 60 * 60_000,
        }),
        refreshToken: async () => {
          refreshCalls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            type: "oauth",
            access: tokenFor("acct_after_refresh"),
            refresh: "refreshed-refresh",
            expires: Date.now() + 60 * 60_000,
            accountId: "acct_after_refresh",
          };
        },
        getApiKey: (credential) => credential.access,
      },
    });
    const registry = new ModelRegistry(runtime);
    const baseline = await registry.getProviderAuth("synthetic-oauth");
    assert.equal(Object.hasOwn(baseline!, "credentialMetadata"), false);
    await store.modify("synthetic-oauth", async () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "refresh-token",
      expires: Date.now() - 1,
      accountId: "acct_before",
    }));
    const [first, second] = await Promise.all([
      registry.getProviderAuth("synthetic-oauth"),
      registry.getProviderAuth("synthetic-oauth"),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(accountIdFromToken(first!.auth.apiKey!), "acct_after_refresh");
    assert.equal(accountIdFromToken(second!.auth.apiKey!), "acct_after_refresh");
    assert.equal(first?.auth.apiKey, tokenFor("acct_after_refresh"));
    assert.equal(second?.auth.apiKey, tokenFor("acct_after_refresh"));
    await store.modify("synthetic-oauth", async () => ({
      type: "oauth",
      access: tokenFor("acct_swapped"),
      refresh: "swapped-refresh",
      expires: Date.now() + 60 * 60_000,
      accountId: "acct_swapped",
    }));
    const swapped = await registry.getProviderAuth("synthetic-oauth");
    assert.equal(swapped?.auth.apiKey, tokenFor("acct_swapped"));
    assert.equal(accountIdFromToken(swapped!.auth.apiKey!), "acct_swapped");
  });

  it("labels a configured API key without OAuth account metadata", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerProvider("synthetic-key", {
      name: "Synthetic key",
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      apiKey: "synthetic-api-key",
    });
    const registry = new ModelRegistry(runtime);
    const baseline = await registry.getProviderAuth("synthetic-key");
    assert.equal(Object.hasOwn(baseline!, "credentialMetadata"), false);
    const result = await registry.getProviderAuth("synthetic-key");
    assert.equal(result?.auth.apiKey, "synthetic-api-key");
    assert.notEqual(result?.source?.toLowerCase(), "oauth");
  });

  it("preserves a partial batch with per-query safe failures through Pi structuredContent", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-partial-"));
    const requests: string[] = [];
    const outcomes: unknown[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(path, "direct", requests, outcomes, [
        "Pi 1.1.0 extension API",
        "failure query",
      ]);
      let result: any;
      created.session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "codex_search")
          result = event.result;
      });
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.filter((url) => url.endsWith("/codex/responses")).length, 2);
      assert.equal(result.structuredContent.successes.length, 1);
      assert.equal(result.structuredContent.failures.length, 1);
      assert.equal(result.structuredContent.failures[0].kind, "rate_limit");
      assert.equal(result.structuredContent.partial, true);
      assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rejects invalid empty queries in Pi schema validation before backend access", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-invalid-"));
    const requests: string[] = [];
    const outcomes: unknown[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(path, "direct", requests, outcomes, [""]);
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 0);
      assert.ok(created.session.messages.some((message) => message.role === "toolResult"));
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("passes direct and nested calls through Pi tool_call admission before any backend request", async () => {
    for (const route of ["direct", "codemode"] as const) {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-denied-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(path, route, requests, outcomes, undefined, true);
        await created.session.prompt("Use the requested search tool once.");
        assert.equal(requests.length, 0);
        assert.ok(
          created.session.messages.some(
            (message) =>
              message.role === "toolResult" &&
              JSON.stringify(message).includes("strict network policy fixture"),
          ),
        );
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    }
  });

  for (const collectionOrder of ["before", "after"] as const) {
    it(`native admission hooks apply when search loads ${collectionOrder === "before" ? "before" : "after"} the gate`, async () => {
      const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-order-"));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          "direct",
          requests,
          outcomes,
          undefined,
          false,
          collectionOrder,
        );
        await created.session.prompt("Use the requested search tool once.");
        assert.equal(requests.filter((url) => url.endsWith("/codex/responses")).length, 1);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    });
  }

  it("rejects more than 32 queries in the native schema before any backend request", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-limit-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        [],
        Array.from({ length: 33 }, (_, index) => `query ${index + 1}`),
      );
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 0);
      assert.ok(created.session.messages.some((message) => message.role === "toolResult"));
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rejects whitespace-only input after schema validation without fetching", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-whitespace-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(path, "direct", requests, [], ["   "]);
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 0);
      assert.ok(created.session.messages.some((message) => message.role === "toolResult"));
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("requires OAuth and does not touch the backend when the selected runtime has no credential", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-no-oauth-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        [],
        undefined,
        false,
        "before",
        "acct_stored",
        { missingOauth: true },
      );
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 0);
      const result = created.session.messages.find((message) => message.role === "toolResult");
      assert.match(JSON.stringify(result), /login openai-codex/i);
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("refuses a redirected Responses request without following the destination", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-redirect-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        [],
        undefined,
        false,
        "before",
        "acct_stored",
        { redirectResponses: true },
      );
      let result: any;
      created.session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "codex_search")
          result = event.result;
      });
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 2);
      assert.ok(requests.every((url) => url.startsWith("https://chatgpt.com/")));
      assert.equal(JSON.stringify(result).includes("attacker.example"), false);
      assert.equal(result.structuredContent.failures[0].kind, "transport");
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("maps cached and indexed freshness through the native tool request", async () => {
    for (const [freshness, expected] of [
      ["cached", { type: "web_search", external_web_access: false, search_context_size: "medium" }],
      [
        "indexed",
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "medium",
          indexed_web_access: true,
        },
      ],
    ] as const) {
      const path = await mkdtemp(join(tmpdir(), `pi-search-sdk-${freshness}-`));
      const requests: string[] = [];
      const outcomes: unknown[] = [];
      let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
      try {
        created = await sessionFor(
          path,
          "direct",
          requests,
          outcomes,
          ["freshness path"],
          false,
          "before",
          "acct_stored",
          { freshness },
        );
        await created.session.prompt("Use the requested search tool once.");
        const body = outcomes.find(
          (entry) => (entry as { model?: string } | undefined)?.model !== undefined,
        ) as { tools?: unknown[] } | undefined;
        assert.deepEqual(body?.tools?.[0], expected);
      } finally {
        created?.session.dispose();
        await rm(path, { recursive: true, force: true });
      }
    }
  });

  it("keeps native query concurrency at five while preserving a seven-query batch", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-concurrency-"));
    const requests: string[] = [];
    const outcomes: unknown[] = [];
    const concurrency = { active: 0, max: 0 };
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        outcomes,
        Array.from({ length: 7 }, (_, index) => `query ${index + 1}`),
        false,
        "before",
        "acct_stored",
        { responseDelayMs: 10, concurrencyStats: concurrency },
      );
      let result: any;
      created.session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "codex_search")
          result = event.result;
      });
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(concurrency.max, 5);
      assert.equal(result.structuredContent.queryCount, 7);
      assert.equal(result.structuredContent.successes.length, 7);
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("native tool admission blocks backend access when permission configuration is unavailable", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-no-grant-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        [],
        undefined,
        false,
        "before",
        "acct_stored",
        { omitGrant: true },
      );
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.length, 0);
      const result = created.session.messages.find((message) => message.role === "toolResult");
      assert.match(JSON.stringify(result), /permission policy is unavailable/i);
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("works independently through the real SDK with native OAuth", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-sdk-off-")),
      requests: string[] = [],
      outcomes: unknown[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        outcomes,
        undefined,
        false,
        "before",
        "acct_stored",
        { noPermissionCollector: true },
      );
      await created.session.prompt("Use the search tool once.");
      assert(requests.length > 0);
      assert(
        created.session.messages.some(
          (message) => message.role === "toolResult" && !message.isError,
        ),
      );
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });
  it("an absent optional permission gate leaves native search usable", async () => {
    const path = await mkdtemp(join(tmpdir(), "pi-search-native-optional-gate-"));
    const requests: string[] = [];
    let created: Awaited<ReturnType<typeof sessionFor>> | undefined;
    try {
      created = await sessionFor(
        path,
        "direct",
        requests,
        [],
        undefined,
        false,
        "before",
        "acct_stored",
        { noPermissionCollector: true },
      );
      await created.session.prompt("Use the requested search tool once.");
      assert.equal(requests.filter((url) => url.endsWith("/codex/responses")).length, 1);
    } finally {
      created?.session.dispose();
      await rm(path, { recursive: true, force: true });
    }
  });
});

describe("standalone extension registration", () => {
  it("reports absent OAuth as sign-in guidance and sanitizes credential lookup failures", async () => {
    const fetchImpl = async () => {
      throw new Error("synthetic-private-token");
    };
    await assert.rejects(
      guardedHarness({
        input: { queries: ["query"] },
        fetchImpl,
        getProviderAuth: async () => undefined,
      }).pending,
      (error: unknown) => {
        assert.match(String(error), /OAuth sign-in is required/);
        assert.match(String(error), /\/login openai-codex/);
        assert.doesNotMatch(String(error), /refresh/i);
        return true;
      },
    );
    await assert.rejects(
      guardedHarness({
        input: { queries: ["query"] },
        fetchImpl,
        getProviderAuth: async () => {
          throw new Error("synthetic-private-token");
        },
      }).pending,
      (error: unknown) => {
        assert.match(String(error), /could not resolve OpenAI Codex credentials/);
        assert.doesNotMatch(String(error), /synthetic-private-token/);
        return true;
      },
    );
  });

  it("direct execution resolves native authentication and sanitizes errors", async () => {
    const tool = createCodexSearchTool({
      fetchImpl: async () => {
        throw new Error("fetch must not run");
      },
    });
    const ctx = {
      modelRegistry: {
        getProviderAuth() {
          throw new Error("private-auth-error");
        },
      },
    };
    await assert.rejects(
      (tool.execute as any)("naked", { queries: ["query"] }, undefined, undefined, ctx),
      /could not resolve OpenAI Codex credentials/,
    );
  });

  it("refuses an OAuth token without a usable account claim before backend access", async () => {
    for (const token of ["opaque", tokenFor("   ")]) {
      let requests = 0;
      await assert.rejects(
        guardedHarness({
          input: { queries: ["query"] },
          fetchImpl: async () => {
            requests++;
            return Response.json({});
          },
          getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }),
        }).pending,
        /account id is missing/,
      );
      assert.equal(requests, 0);
    }
  });

  it("registers the native search tool without a permission extension", () => {
    let registered: { name: string; execute: (...args: any[]) => any } | undefined;
    const pi = {
      registerTool(tool: any) {
        registered = tool;
      },
      events: { on() {} },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
    registerCodexSearch(pi, { fetchImpl: async () => Response.json({ models: [] }) });
    assert.equal(registered?.name, "codex_search");
    assert.equal(typeof registered?.execute, "function");
  });

  it("registered tools resolve native credentials exactly once and never fetch after auth failure", async () => {
    let registered: ReturnType<typeof createCodexSearchTool> | undefined;
    let authCalls = 0,
      fetchCalls = 0;
    registerCodexSearch(
      {
        registerTool(tool: any) {
          registered = tool;
        },
      } as any,
      {
        fetchImpl: async () => {
          fetchCalls++;
          throw Error("fetch must not run");
        },
      },
    );
    await assert.rejects(
      registered!.execute("call", { queries: ["query"] }, undefined, undefined, {
        modelRegistry: {
          async getProviderAuth(...args: unknown[]) {
            assert.deepEqual(args, ["openai-codex"]);
            authCalls++;
            throw Error("private-auth-error");
          },
        },
      } as any),
      (error) => {
        assert.match(String(error), /could not resolve OpenAI Codex credentials/);
        assert.doesNotMatch(String(error), /private-auth-error/);
        return true;
      },
    );
    assert.equal(authCalls, 1);
    assert.equal(fetchCalls, 0);
  });

  it("truncates a bounded provider answer while retaining its typed success and truncation flag", async () => {
    const text = "x".repeat(12_001);
    const source = `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\nevent: response.completed\ndata: {"response":{}}\n\n`;
    const harness = guardedHarness({
      input: { queries: ["long answer"] },
      model: { provider: "openai-codex", id: "selected-model" },
      fetchImpl: async () => new Response(streamFrom([new TextEncoder().encode(source)])),
    });
    const result = await harness.pending;
    assert.equal(result.structuredContent.successes[0].text.length, 12_000);
    assert.equal(result.structuredContent.successes[0].textTruncated, true);
    assert.equal(result.structuredContent.queryCount, 1);
    assert.equal(harness.dispatches, 1);
  });

  function guardedHarness(options: {
    input: {
      queries: string[];
      freshness?: "live" | "cached" | "indexed";
      search_context_size?: "low" | "medium" | "high";
    };
    getProviderAuth?: () => Promise<unknown>;
    fetchImpl: typeof fetch;
    model?: { provider: string; id: string };
    updates?: unknown[];
  }) {
    const controller = new AbortController();
    let dispatches = 0;
    const tool = createCodexSearchTool({
      fetchImpl: async (input, init) => {
        dispatches++;
        assert.equal(new URL(String(input)).origin, "https://chatgpt.com");
        return options.fetchImpl(input, init);
      },
    });
    const execute = tool.execute as (...args: any[]) => Promise<any>;
    const context = {
      modelRegistry: {
        getProviderAuth:
          options.getProviderAuth ??
          (async () => ({ source: "oauth", auth: { apiKey: tokenFor("acct_synthetic") } })),
        find: () => undefined,
      },
      model: options.model,
      signal: controller.signal,
      sessionManager: { getSessionId: () => "session_synthetic" },
    };
    const updates = options.updates ?? [];
    const pending = execute(
      "call_guarded",
      options.input,
      undefined,
      (update: unknown) => updates.push(update),
      context,
    );
    return {
      pending,
      controller,
      get dispatches() {
        return dispatches;
      },
      updates,
    };
  }

  it("does not fetch if native session cancellation occurs during credential resolution", async () => {
    let resolveAuth!: (value: unknown) => void;
    const authPending = new Promise<unknown>((resolve) => {
      resolveAuth = resolve;
    });
    let requests = 0;
    const harness = guardedHarness({
      input: { queries: ["credential wait"] },
      getProviderAuth: () => authPending,
      fetchImpl: async () => {
        requests++;
        return Response.json({ models: [] });
      },
    });
    harness.controller.abort();
    resolveAuth({ source: "oauth", auth: { apiKey: tokenFor("acct_synthetic") } });
    await assert.rejects(harness.pending);
    assert.equal(requests, 0);
    assert.equal(harness.dispatches, 0);
  });

  it("does not send a Responses query after cancellation during default-model lookup", async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const harness = guardedHarness({
      input: { queries: ["model wait"] },
      fetchImpl: async (input, init) => {
        requests++;
        assert.match(String(input), /\/codex\/models/);
        started();
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          else
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
        });
      },
    });
    await requestStarted;
    harness.controller.abort(new Error("session identity changed"));
    await assert.rejects(harness.pending);
    assert.equal(requests, 1);
    assert.equal(harness.dispatches, 1);
  });

  it("captures query text before asynchronous native credential lookup", async () => {
    let resolveAuth!: (value: unknown) => void;
    const authPending = new Promise<unknown>((resolve) => {
      resolveAuth = resolve;
    });
    let submitted = "";
    const input = { queries: ["before"] };
    const harness = guardedHarness({
      input,
      model: { provider: "openai-codex", id: "selected-model" },
      getProviderAuth: () => authPending,
      fetchImpl: async (_url, init) => {
        submitted = String(init?.body);
        return new Response(streamFrom([new TextEncoder().encode(responsesFixture)]));
      },
    });
    input.queries[0] = "after";
    resolveAuth({ source: "oauth", auth: { apiKey: tokenFor("acct_synthetic") } });
    await harness.pending;
    assert.match(submitted, /before/);
    assert.doesNotMatch(submitted, /after/);
    assert.equal(harness.dispatches, 1);
  });

  it("checks every dispatch and stops newly queued queries on native session cancellation", async () => {
    let started!: () => void;
    const firstFive = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const queries = Array.from({ length: 8 }, (_, index) => `query ${index + 1}`);
    const harness = guardedHarness({
      input: { queries },
      model: { provider: "openai-codex", id: "selected-model" },
      fetchImpl: async (_input, init) => {
        requests++;
        if (requests === 5) started();
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          else
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
        });
      },
    });
    await firstFive;
    harness.controller.abort(new Error("policy epoch changed"));
    await assert.rejects(harness.pending);
    assert.equal(requests, 5);
    assert.equal(harness.dispatches, 5);
    assert.equal(harness.updates.length, 1, "no partial progress was published after revocation");
  });

  it("aborts an in-flight Responses reader and publishes no stale result after cancellation", async () => {
    let readerCancelled = false;
    const updates: unknown[] = [];
    const harness = guardedHarness({
      input: { queries: ["stream revocation"] },
      model: { provider: "openai-codex", id: "selected-model" },
      updates,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: response.output_text.delta\ndata: {"delta":"current"}\n\n',
                ),
              );
            },
            cancel() {
              readerCancelled = true;
            },
          }),
        ),
    });
    const revoke = () => harness.controller.abort(new Error("permission epoch changed"));
    const interval = setInterval(() => {
      if (updates.length) {
        clearInterval(interval);
        revoke();
      }
    }, 0);
    await assert.rejects(harness.pending);
    clearInterval(interval);
    assert.equal(readerCancelled, true);
    assert.equal(updates.length, 1);
    assert.equal(harness.dispatches, 1);
  });
});
