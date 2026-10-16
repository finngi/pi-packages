import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CODEX_BACKEND_ORIGIN,
  MAX_CONCURRENCY,
  MAX_QUERIES,
  MAX_MODEL_BYTES,
  MAX_STREAM_BYTES,
  MAX_FRAME_CHARS,
  SearchError,
  accountIdFromToken,
  classifyHttpStatus,
  fetchCodexModels,
  resolveAccountId,
  selectDefaultModel,
  runResponsesSearch,
} from "../lib/search.ts";
import { chunk, responsesFixture, streamFrom } from "./fixtures/responses-sse.ts";

const baseOptions = {
  query: "fixture source query",
  model: "fixture-codex-model",
  token: "synthetic-test-token",
  accountId: "acct_synthetic",
  freshness: "live" as const,
  searchContextSize: "medium" as const,
  sessionId: "session_fixture",
  threadId: "thread_fixture",
};

describe("pi-codex-search v0.1.6 Responses port", () => {
  it("pins provenance constants and safe bounded fan-out", () => {
    assert.equal(CODEX_BACKEND_ORIGIN, "https://chatgpt.com");
    assert.equal(MAX_QUERIES, 32);
    assert.equal(MAX_CONCURRENCY, 5);
  });

  it("uses a Pi OAuth account id first, then the upstream JWT claim", () => {
    const tokenFor = (claim: unknown) =>
      `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: claim } })).toString("base64url")}.signature`;
    const token = tokenFor("acct_from_jwt");
    assert.equal(accountIdFromToken(token), "acct_from_jwt");
    assert.equal(
      resolveAccountId(token, (provider) => {
        assert.equal(provider, "openai-codex");
        return { type: "oauth", accountId: " acct_from_pi " };
      }),
      "acct_from_pi",
    );
    const whitespaceToken = tokenFor(" acct_from_jwt ");
    assert.equal(accountIdFromToken(whitespaceToken), " acct_from_jwt ");
    const whitespaceOnlyToken = tokenFor("   ");
    assert.equal(accountIdFromToken(whitespaceOnlyToken), "   ");
    assert.equal(accountIdFromToken(tokenFor("")), undefined);
    assert.equal(accountIdFromToken(tokenFor(42)), undefined);
    assert.equal(
      resolveAccountId(token, () => ({ type: "oauth", accountId: "   " })),
      "acct_from_jwt",
    );
    assert.equal(
      resolveAccountId(whitespaceOnlyToken, () => ({ type: "oauth", accountId: " acct_stored " })),
      "acct_stored",
    );
    assert.equal(
      resolveAccountId(whitespaceOnlyToken, () => undefined),
      "   ",
    );
    assert.equal(
      resolveAccountId("opaque", () => undefined),
      undefined,
    );
  });

  it("selects upstream default model with first-model fallback", () => {
    assert.equal(
      selectDefaultModel([{ id: "first" }, { id: "default", isDefault: true }]),
      "default",
    );
    assert.equal(selectDefaultModel([{ id: "first" }]), "first");
    assert.equal(selectDefaultModel([]), undefined);
  });

  it("discovers Codex models only at the fixed origin and selects provider defaults", async () => {
    let requestUrl = "";
    let headers = new Headers();
    const models = await fetchCodexModels({
      token: "synthetic-test-token",
      accountId: "acct_synthetic",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        headers = new Headers(init?.headers);
        assert.equal(init?.redirect, "manual");
        return Response.json({
          models: [{ slug: "first-model" }, { slug: "default-model", is_default: true }],
        });
      },
    });
    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
    assert.equal(headers.get("authorization"), "Bearer synthetic-test-token");
    assert.equal(selectDefaultModel(models), "default-model");
  });

  it("does not dispatch model lookup when cancellation arrives during credential resolution", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    await assert.rejects(
      fetchCodexModels({
        token: "synthetic-test-token",
        accountId: "acct_synthetic",
        signal: controller.signal,
        fetchImpl: async () => {
          requests++;
          return Response.json({ models: [] });
        },
      }),
      (error: unknown) => error instanceof SearchError && error.kind === "timeout",
    );
    assert.equal(requests, 0);
  });

  it("parses upstream SSE frames across byte splits and preserves annotated citations, search calls and usage", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders = new Headers();
    const deltas: string[] = [];
    const sizes = Array.from({ length: responsesFixture.length }, (_, index) => (index % 7) + 1);
    const result = await runResponsesSearch({
      ...baseOptions,
      onTextDelta: (delta) => deltas.push(delta),
      fetchImpl: async (input, init) => {
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        assert.equal(init?.redirect, "manual");
        requestHeaders = new Headers(init?.headers);
        requestBody = JSON.parse(String(init?.body));
        return new Response(streamFrom(chunk(responsesFixture, sizes)), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    assert.equal(requestHeaders.get("authorization"), "Bearer synthetic-test-token");
    assert.equal(requestHeaders.get("chatgpt-account-id"), "acct_synthetic");
    assert.equal(requestHeaders.get("session-id"), "session_fixture");
    assert.equal(requestHeaders.get("thread-id"), "thread_fixture");
    assert.equal(requestHeaders.get("x-client-request-id"), "thread_fixture");
    assert.equal(
      Object.hasOwn(requestBody!, "reasoning"),
      false,
      "unset reasoning remains omitted from the request",
    );
    assert.deepEqual((requestBody!.tools as unknown[])[0], {
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
    });
    assert.equal(result.responseId, "resp_fixture_01");
    assert.equal(result.text, "Fixture answer with a source.");
    assert.deepEqual(deltas, ["Fixture answer with a source."]);
    assert.deepEqual(result.citations, [
      { title: "Fixture Source", url: "https://example.com/source", startIndex: 26, endIndex: 39 },
    ]);
    assert.deepEqual(result.searchCalls, [
      {
        id: "ws_fixture_01",
        status: "completed",
        query: "fixture source query",
        url: undefined,
        actionType: "search",
      },
    ]);
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  });

  it("maps cached and indexed access exactly as the upstream Responses request", async () => {
    for (const [freshness, expected] of [
      ["cached", { type: "web_search", external_web_access: false, search_context_size: "high" }],
      [
        "indexed",
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "high",
          indexed_web_access: true,
        },
      ],
    ] as const) {
      let tool: unknown;
      await runResponsesSearch({
        ...baseOptions,
        freshness,
        searchContextSize: "high",
        fetchImpl: async (_input, init) => {
          tool = (JSON.parse(String(init?.body)) as { tools: unknown[] }).tools[0];
          return new Response(
            streamFrom([
              new TextEncoder().encode(
                'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1}}}\n\n',
              ),
            ]),
          );
        },
      });
      assert.deepEqual(tool, expected);
    }
  });

  it("classifies HTTP auth, rate-limit and transport failures without echoing bodies or tokens", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "auth"],
      [429, "rate_limit"],
      [503, "transport"],
    ] as const) {
      await assert.rejects(
        runResponsesSearch({
          ...baseOptions,
          fetchImpl: async () =>
            new Response("synthetic-test-token private response text", { status }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof SearchError);
          assert.equal(error.kind, kind);
          assert.equal(error.message.includes("synthetic-test-token"), false);
          assert.equal(error.message.includes("private response text"), false);
          return true;
        },
      );
    }
    assert.equal(classifyHttpStatus(429), "rate_limit");
  });

  it("refuses a credential-bearing redirect without following it", async () => {
    let calls = 0;
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/collect" },
          });
        },
      }),
      /credentials were not forwarded/,
    );
    assert.equal(calls, 1);
  });

  it("cancels redirected bodies and stops reading after a terminal completion event", async () => {
    let canceled = 0;
    const redirected = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled++;
          },
        }),
        { status: 302 },
      );
    await assert.rejects(
      fetchCodexModels({
        token: "fixture",
        accountId: "fixture",
        fetchImpl: async () => redirected(),
      }),
      /credentials were not forwarded/,
    );
    await assert.rejects(
      runResponsesSearch({ ...baseOptions, fetchImpl: async () => redirected() }),
      /credentials were not forwarded/,
    );
    const result = await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: response.completed\ndata: {"response":{}}\n\n'),
              );
            },
            cancel() {
              canceled++;
            },
          }),
        ),
    });
    assert.equal(result.text, "");
    assert.equal(canceled, 3);
  });

  it("rejects malformed event data and empty streams as provider schema failures", async () => {
    for (const source of ["event: response.completed\ndata: {bad}\n\n", ""]) {
      await assert.rejects(
        runResponsesSearch({
          ...baseOptions,
          fetchImpl: async () =>
            new Response(streamFrom(source ? [new TextEncoder().encode(source)] : [])),
        }),
        (error: unknown) => error instanceof SearchError && error.kind === "schema",
      );
    }
  });

  it("rejects truncated streams and keeps malformed provider event names out of errors", async () => {
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () =>
          new Response(
            streamFrom([
              new TextEncoder().encode(
                'event: response.output_text.delta\ndata: {"delta":"unfinished"}\n\n',
              ),
            ]),
          ),
      }),
      /ended before a completed response/,
    );
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () =>
          new Response(
            streamFrom([
              new TextEncoder().encode("event: provider_private_sentinel\ndata: {broken}\n\n"),
            ]),
          ),
      }),
      (error) =>
        error instanceof SearchError &&
        error.kind === "schema" &&
        !error.message.includes("provider_private_sentinel"),
    );
  });

  it("filters malformed optional citation, search-call and usage fields to typed values", async () => {
    const source = [
      {
        type: "response.output_item.done",
        data: {
          item: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "answer",
                annotations: [
                  null,
                  {
                    type: "url_citation",
                    url: "https://example.com/source",
                    title: 42,
                    start_index: "private-index",
                    end_index: -1,
                  },
                ],
              },
            ],
          },
        },
      },
      {
        type: "response.output_item.done",
        data: {
          item: {
            type: "web_search_call",
            id: 42,
            status: {},
            action: { query: 99, queries: {}, url: 42, type: {} },
          },
        },
      },
      {
        type: "response.completed",
        data: {
          response: {
            usage: { input_tokens: "private-usage", output_tokens: 7, total_tokens: -1 },
          },
        },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      .join("");
    const result = await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async () => new Response(streamFrom([new TextEncoder().encode(source)])),
    });
    assert.equal(result.text, "answer");
    assert.deepEqual(result.citations, [
      {
        url: "https://example.com/source",
        title: undefined,
        startIndex: undefined,
        endIndex: undefined,
      },
    ]);
    assert.deepEqual(result.searchCalls, [
      { id: undefined, status: undefined, query: undefined, url: undefined, actionType: undefined },
    ]);
    assert.deepEqual(result.usage, {
      inputTokens: undefined,
      outputTokens: 7,
      totalTokens: undefined,
    });
    assert(!JSON.stringify(result).includes("private-"));
  });

  it("keeps provider-declared empty answers empty and classifies failed response events", async () => {
    const empty = await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async () =>
        new Response(
          streamFrom([
            new TextEncoder().encode(
              'event: response.completed\ndata: {"response":{"usage":{"total_tokens":1}}}\n\n',
            ),
          ]),
        ),
    });
    assert.equal(empty.text, "");
    assert.deepEqual(empty.citations, []);
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () =>
          new Response(
            streamFrom([
              new TextEncoder().encode(
                'event: response.failed\r\ndata: {"response":{"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"}}}\r\n\r\n',
              ),
            ]),
          ),
      }),
      (error: unknown) =>
        error instanceof SearchError &&
        error.kind === "rate_limit" &&
        !error.message.includes("Rate limit exceeded"),
    );
  });

  it("classifies nested and standalone provider errors and retains reported failure usage", async () => {
    for (const [event, data, kind] of [
      [
        "response.failed",
        {
          response: {
            error: { code: "rate_limit_exceeded" },
            usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
        },
        "rate_limit",
      ],
      ["error", { error: { message: "Unauthorized: private-secret" } }, "auth"],
      ["error", { code: "rate_limit_exceeded", message: "private-secret" }, "rate_limit"],
    ] as const) {
      await assert.rejects(
        runResponsesSearch({
          ...baseOptions,
          fetchImpl: async () =>
            new Response(
              streamFrom([
                new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              ]),
            ),
        }),
        (error: unknown) => {
          assert(error instanceof SearchError);
          assert.equal(error.kind, kind);
          assert(!error.message.includes("private-secret"));
          if (event === "response.failed")
            assert.deepEqual(error.usage, { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
          return true;
        },
      );
    }
  });

  it("retains cached input and reasoning subsets from provider receipts", async () => {
    const usage = {
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 3 },
    };
    const result = await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async () =>
        new Response(
          streamFrom([
            new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({ response: { usage } })}\n\n`,
            ),
          ]),
        ),
    });
    assert.deepEqual(result.usage, {
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      cacheReadTokens: 4,
      reasoningTokens: 3,
    });
  });

  it("joins multiple SSE data lines as the upstream parser does", async () => {
    const result = await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async () =>
        new Response(
          streamFrom([
            new TextEncoder().encode(
              'event: response.created\ndata: {"response":\ndata: {"id":"resp_multiline"}}\n\nevent: response.completed\ndata: {"response":{}}\n\n',
            ),
          ]),
        ),
    });
    assert.equal(result.responseId, "resp_multiline");
  });

  it("cancels and releases a partial SSE reader when parsing fails", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: response.output_text.delta\ndata: {broken}\n\n"),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      runResponsesSearch({ ...baseOptions, fetchImpl: async () => new Response(stream) }),
      /malformed/,
    );
    assert.equal(canceled, true);
  });

  it("aborts a pending backend request and bounds its deadline", async () => {
    const controller = new AbortController();
    let gotSignal: AbortSignal | undefined;
    const pending = runResponsesSearch({
      ...baseOptions,
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        gotSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      },
    });
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SearchError && error.kind === "timeout",
    );
    assert.equal(gotSignal?.aborted, true);
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        timeoutMs: 5,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            }),
          ),
      }),
      (error: unknown) => error instanceof SearchError && error.kind === "timeout",
    );
  });

  it("bounds model JSON, complete event frames and total SSE bytes, cancelling oversized readers", async () => {
    let canceled = 0;
    const response = (text: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
          },
          cancel() {
            canceled++;
          },
        }),
      );
    await assert.rejects(
      fetchCodexModels({
        token: "fixture",
        accountId: "fixture",
        fetchImpl: async () => response("x".repeat(MAX_MODEL_BYTES + 1)),
      }),
      /response size limit/,
    );
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () =>
          response(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "x".repeat(MAX_FRAME_CHARS) })}\n\n`,
          ),
      }),
      /event size limit/,
    );
    await assert.rejects(
      runResponsesSearch({
        ...baseOptions,
        fetchImpl: async () => response("x".repeat(MAX_STREAM_BYTES + 1)),
      }),
      /response size limit/,
    );
    assert.equal(canceled, 3);
  });

  it("retains only the port's approved Cloudflare cookies between fixed-origin requests", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "__cf_bm=fixture_cf; Secure; HttpOnly");
    headers.append("set-cookie", "cf_chl_fixture=challenge; Secure");
    headers.append("set-cookie", "session_token=private_cookie; Secure");
    await fetchCodexModels({
      token: "fixture",
      accountId: "fixture",
      fetchImpl: async () => Response.json({ models: [] }, { headers }),
    });
    await runResponsesSearch({
      ...baseOptions,
      fetchImpl: async (input, init) => {
        assert.equal(new URL(String(input)).origin, CODEX_BACKEND_ORIGIN);
        const cookie = new Headers(init?.headers).get("cookie")!;
        assert(cookie.includes("__cf_bm=fixture_cf"));
        assert(cookie.includes("cf_chl_fixture=challenge"));
        assert(!cookie.includes("session_token"));
        assert(!cookie.includes("private_cookie"));
        return new Response(
          streamFrom([
            new TextEncoder().encode('event: response.completed\ndata: {"response":{}}\n\n'),
          ]),
        );
      },
    });
  });

  it("applies the request deadline to pending model, HTTP-error and SSE body readers", async () => {
    let canceled = 0;
    const pendingBody = (status = 200) =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled++;
          },
        }),
        { status },
      );
    await assert.rejects(
      fetchCodexModels({
        token: "fixture",
        accountId: "fixture",
        timeoutMs: 5,
        fetchImpl: async () => pendingBody(),
      }),
      (error) => error instanceof SearchError && error.kind === "timeout",
    );
    await assert.rejects(
      runResponsesSearch({ ...baseOptions, timeoutMs: 5, fetchImpl: async () => pendingBody() }),
      (error) => error instanceof SearchError && error.kind === "timeout",
    );
    await assert.rejects(
      runResponsesSearch({ ...baseOptions, timeoutMs: 5, fetchImpl: async () => pendingBody(503) }),
      (error) => error instanceof SearchError && error.kind === "timeout",
    );
    assert.equal(canceled, 3);
  });
});
