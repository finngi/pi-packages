/**
 * Responses web search port based on Leechael/pi-codex-search v0.1.6.
 * Upstream MIT copyright and terms are preserved in ../LICENSE.pi-codex-search.
 */
import { release } from "node:os";

export const CODEX_BACKEND_ORIGIN = "https://chatgpt.com";
export const CODEX_BACKEND_BASE = `${CODEX_BACKEND_ORIGIN}/backend-api`;
export const RESPONSES_URL = `${CODEX_BACKEND_BASE}/codex/responses`;
export const MODELS_URL = `${CODEX_BACKEND_BASE}/codex/models?client_version=1.0.0`;
export const MAX_QUERIES = 32;
export const MAX_CONCURRENCY = 5;
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_QUERY_TEXT_CHARS = 12_000;
export const MAX_MODEL_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 2 * 1024 * 1024;
export const MAX_FRAME_CHARS = 1024 * 1024;

const UPSTREAM_CODEX_VERSION = "0.143.0";

function buildUserAgent(): string {
  const platform =
    process.platform === "darwin"
      ? "Mac OS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  const terminal = process.env.TERM_PROGRAM
    ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`.trim()
    : process.env.WT_SESSION
      ? "WindowsTerminal"
      : process.env.KITTY_WINDOW_ID
        ? "kitty"
        : process.env.TMUX
          ? "tmux"
          : process.env.TERM && process.env.TERM !== "dumb"
            ? process.env.TERM
            : "unknown";
  return `codex_cli_rs/${UPSTREAM_CODEX_VERSION} (${platform} ${release()}; ${arch}) ${terminal}`;
}

export type Freshness = "live" | "cached" | "indexed";
export type SearchContextSize = "low" | "medium" | "high";
export type SearchErrorKind =
  | "auth"
  | "rate_limit"
  | "transport"
  | "timeout"
  | "schema"
  | "unknown";

export interface Citation {
  title?: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface SearchCall {
  id?: string;
  status?: string;
  query?: string;
  url?: string;
  actionType?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SearchSuccess {
  query: string;
  text: string;
  textTruncated?: boolean;
  citations: Citation[];
  searchCalls: SearchCall[];
  responseId?: string;
  usage?: Usage;
}

export interface SearchFailure {
  query: string;
  kind: SearchErrorKind;
  message: string;
  status?: number;
}

export interface SearchBatch {
  model: string;
  /** Reasoning effort included in the Responses request body, when present. This records the submitted value only. */
  submittedReasoningEffort?: string;
  freshness: Freshness;
  searchContextSize: SearchContextSize;
  queryCount: number;
  failedQueryCount: number;
  successes: SearchSuccess[];
  failures: SearchFailure[];
  partial: boolean;
  elapsedMs: number;
}

export class SearchError extends Error {
  readonly kind: SearchErrorKind;
  readonly status?: number;

  constructor(kind: SearchErrorKind, message: string, status?: number) {
    super(message);
    this.name = "SearchError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export function classifyHttpStatus(status: number): SearchErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "transport";
}

export function classifyError(error: unknown): SearchErrorKind {
  if (error instanceof SearchError) return error.kind;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return "timeout";
  return "unknown";
}

export function classifyEventError(message: string): SearchErrorKind {
  const value = message.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|429/.test(value)) return "rate_limit";
  if (/auth|unauthori[sz]ed|forbidden|401|403/.test(value)) return "auth";
  if (/timeout|timed out/.test(value)) return "timeout";
  if (/network|connection|disconnect|transport|fetch failed/.test(value)) return "transport";
  return "unknown";
}

export interface AccountCredential {
  type?: unknown;
  accountId?: unknown;
}

export type StoredCredentialReader = (providerId: string) => AccountCredential | undefined;

export function accountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const value = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAccountId(
  token: string,
  readCredential: StoredCredentialReader,
): string | undefined {
  const stored = readCredential("openai-codex");
  if (stored?.type === "oauth" && typeof stored.accountId === "string" && stored.accountId.trim()) {
    return stored.accountId.trim();
  }
  return accountIdFromToken(token);
}

export interface CodexModel {
  id: string;
  name?: string;
  isDefault?: boolean;
}

export function selectDefaultModel(models: CodexModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

export interface SearchRequestOptions {
  query: string;
  model: string;
  token: string;
  accountId: string;
  freshness: Freshness;
  searchContextSize: SearchContextSize;
  /** Already mapped through the active Pi model's Codex reasoning metadata. */
  reasoningEffort?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sessionId?: string;
  threadId?: string;
  onTextDelta?: (delta: string) => void;
}

interface SseEvent {
  type: string;
  data?: unknown;
}

interface OutputText {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface OutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  content?: OutputText[];
}

interface EventData {
  response?: {
    id?: string;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  item?: OutputItem;
  delta?: string;
  error?: { message?: string; code?: string };
}

interface Cookie {
  name: string;
  value: string;
}
const allowedCloudflareCookies = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);
const cloudflareCookies = new Map<string, Cookie>();

function cookieHeader(): string | undefined {
  const values = [...cloudflareCookies.values()].map(({ name, value }) => `${name}=${value}`);
  return values.length ? values.join("; ") : undefined;
}

function rememberCloudflareCookies(response: Response): void {
  const values = response.headers.getSetCookie?.() ?? [];
  for (const cookie of values) {
    const [pair] = cookie.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (eq <= 0) continue;
    const name = pair!.slice(0, eq).trim();
    if (allowedCloudflareCookies.has(name) || name.startsWith("cf_chl_")) {
      cloudflareCookies.set(name, { name, value: pair!.slice(eq + 1).trim() });
    }
  }
}

function timeoutSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(caller?.reason ?? new DOMException("Search timed out", "TimeoutError"));
  const timer = setTimeout(
    () => controller.abort(new DOMException("Search timed out", "TimeoutError")),
    timeoutMs,
  );
  if (caller?.aborted) abort();
  else caller?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
}

function validateEndpoint(url: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== CODEX_BACKEND_ORIGIN || parsed.protocol !== "https:") {
    throw new SearchError(
      "transport",
      "Codex search endpoint is outside the approved HTTPS origin.",
    );
  }
}

function requestHeaders(token: string, accountId: string, accept: string): Headers {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "codex_cli_rs",
    accept,
    "user-agent": buildUserAgent(),
  });
  const cookie = cookieHeader();
  if (cookie) headers.set("cookie", cookie);
  if (accept === "text/event-stream") headers.set("content-type", "application/json");
  return headers;
}

function safeResponseMessage(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (
    lower.includes("/cdn-cgi/challenge-platform/") ||
    lower.includes("cf_chl_") ||
    lower.includes("enable javascript and cookies to continue")
  ) {
    return "Codex search was blocked by a Cloudflare challenge. Retry after Pi/Codex has refreshed its session.";
  }
  if (status === 401 || status === 403)
    return "Codex rejected the current sign-in. Run `/login openai-codex` in Pi.";
  if (status === 429) return "Codex search is rate limited. Retry later.";
  return `Codex search request failed with HTTP ${status}.`;
}

async function boundedBody(
  response: Response,
  limit = 2048,
  signal?: AbortSignal,
  truncate = true,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (bytes < limit) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const remaining = limit - bytes;
      bytes += value.byteLength;
      if (!truncate && bytes > limit)
        throw new SearchError("schema", "Codex model lookup exceeded its response size limit.");
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
    }
    if (!truncate && bytes === limit) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (!next.done)
        throw new SearchError("schema", "Codex model lookup exceeded its response size limit.");
    }
    return (text + decoder.decode()).slice(0, limit);
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function fetchCodexModels(
  options: Pick<SearchRequestOptions, "token" | "accountId" | "signal" | "fetchImpl" | "timeoutMs">,
): Promise<CodexModel[]> {
  validateEndpoint(MODELS_URL);
  const deadline = timeoutSignal(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    deadline.signal.throwIfAborted();
    const response = await (options.fetchImpl ?? fetch)(MODELS_URL, {
      method: "GET",
      headers: requestHeaders(options.token, options.accountId, "application/json"),
      signal: deadline.signal,
      redirect: "manual",
    });
    rememberCloudflareCookies(response);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchError(
        "transport",
        "Codex model lookup returned a redirect; credentials were not forwarded.",
        response.status,
      );
    }
    if (!response.ok) {
      const body = await boundedBody(response, 2048, deadline.signal);
      throw new SearchError(
        classifyHttpStatus(response.status),
        safeResponseMessage(response.status, body),
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await boundedBody(response, MAX_MODEL_BYTES, deadline.signal, false));
    } catch (error) {
      if (error instanceof SearchError || deadline.signal.aborted) throw error;
      throw new SearchError("schema", "Codex model lookup returned invalid JSON.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { models?: unknown }).models)
    ) {
      throw new SearchError("schema", "Codex model lookup returned an unsupported response.");
    }
    return (payload as { models: Array<Record<string, unknown>> }).models
      .map((model) => ({
        id: String(model.slug ?? model.id ?? model.model ?? ""),
        name: typeof model.display_name === "string" ? model.display_name : undefined,
        isDefault: model.is_default === true,
      }))
      .filter((model) => model.id.length > 0);
  } catch (error) {
    if (error instanceof SearchError) throw error;
    if (deadline.signal.aborted)
      throw new SearchError("timeout", "Codex model lookup timed out or was cancelled.");
    throw new SearchError("transport", "Codex model lookup could not be completed.");
  } finally {
    deadline.dispose();
  }
}

export async function runResponsesSearch(options: SearchRequestOptions): Promise<{
  responseId?: string;
  model: string;
  text: string;
  searchCalls: SearchCall[];
  citations: Citation[];
  usage?: Usage;
}> {
  validateEndpoint(RESPONSES_URL);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = timeoutSignal(options.signal, timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    deadline.signal.throwIfAborted();
    const headers = requestHeaders(options.token, options.accountId, "text/event-stream");
    if (options.sessionId) headers.set("session-id", options.sessionId);
    if (options.threadId) {
      headers.set("thread-id", options.threadId);
      headers.set("x-client-request-id", options.threadId);
    }
    response = await fetchImpl(RESPONSES_URL, {
      method: "POST",
      headers,
      redirect: "manual",
      signal: deadline.signal,
      body: JSON.stringify({
        model: options.model,
        ...(options.reasoningEffort !== undefined
          ? { reasoning: { effort: options.reasoningEffort } }
          : {}),
        instructions:
          "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: options.query }] },
        ],
        tools: [
          {
            type: "web_search",
            external_web_access: options.freshness !== "cached",
            search_context_size: options.searchContextSize,
            ...(options.freshness === "indexed" ? { indexed_web_access: true } : {}),
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: [],
      }),
    });
    rememberCloudflareCookies(response);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new SearchError(
        "transport",
        "Codex search returned a redirect; credentials were not forwarded.",
        response.status,
      );
    }
    if (!response.ok) {
      const body = await boundedBody(response, 2048, deadline.signal);
      throw new SearchError(
        classifyHttpStatus(response.status),
        safeResponseMessage(response.status, body),
        response.status,
      );
    }
    if (!response.body)
      throw new SearchError("schema", "Codex search response did not contain an event stream.");
    return await consumeResponsesStream(response.body, { ...options, signal: deadline.signal });
  } catch (error) {
    if (deadline.signal.aborted) {
      const reason = deadline.signal.reason;
      if (reason instanceof Error && reason.name === "TimeoutError")
        throw new SearchError(
          "timeout",
          `Codex search exceeded its ${Math.ceil(timeoutMs / 1000)} second deadline.`,
        );
      throw new SearchError("timeout", "Codex search was cancelled.");
    }
    if (error instanceof SearchError) throw error;
    throw new SearchError("transport", "Codex search request could not be completed.");
  } finally {
    deadline.dispose();
  }
}

async function consumeResponsesStream(
  body: ReadableStream<Uint8Array>,
  options: SearchRequestOptions,
) {
  let responseId: string | undefined;
  let usage: Usage | undefined;
  let streamedText = "";
  const messageText: string[] = [];
  const searchCalls = new Map<string, SearchCall>();
  const citations = new Map<string, Citation>();
  let sawEvent = false;
  let completed = false;

  for await (const event of parseSse(body, options.signal)) {
    sawEvent = true;
    if (!event.data) continue;
    const data = event.data as EventData;
    if (event.type === "response.created") {
      responseId = optionalString(data.response?.id);
      continue;
    }
    if (event.type === "response.output_text.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      streamedText += delta;
      options.onTextDelta?.(delta);
      continue;
    }
    if (
      event.type === "response.output_item.added" &&
      data.item?.type === "web_search_call" &&
      typeof data.item.id === "string"
    ) {
      searchCalls.set(data.item.id, { id: data.item.id, status: optionalString(data.item.status) });
      continue;
    }
    if (event.type === "response.output_item.done") {
      collectOutputItem(data.item, searchCalls, messageText, citations);
      continue;
    }
    if (event.type === "response.completed") {
      if (!data.response || typeof data.response !== "object" || Array.isArray(data.response))
        throw new SearchError("schema", "Codex search returned an unsupported completion event.");
      completed = true;
      const source = data.response?.usage;
      if (source && typeof source === "object" && !Array.isArray(source))
        usage = {
          inputTokens: optionalNumber(source.input_tokens),
          outputTokens: optionalNumber(source.output_tokens),
          totalTokens: optionalNumber(source.total_tokens),
        };
      break;
    }
    if (event.type === "response.failed") {
      const message =
        optionalString(data.error?.message) ??
        optionalString(data.error?.code) ??
        "Codex web search failed";
      throw new SearchError(
        classifyEventError(message),
        `Codex search failed: ${safeEventMessage(message)}.`,
      );
    }
  }
  if (!sawEvent) throw new SearchError("schema", "Codex search returned an empty event stream.");
  if (!completed)
    throw new SearchError("schema", "Codex search stream ended before a completed response.");
  return {
    responseId,
    model: options.model,
    text: messageText.join("") || streamedText,
    searchCalls: [...searchCalls.values()],
    citations: [...citations.values()],
    usage,
  };
}

function safeEventMessage(message: string): string {
  const lower = message.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|429/.test(lower)) return "rate limited";
  if (/auth|unauthori[sz]ed|forbidden|401|403/.test(lower)) return "authentication rejected";
  if (/timeout|timed out/.test(lower)) return "timed out";
  if (/network|connection|disconnect|transport|fetch failed/.test(lower)) return "transport error";
  return "provider returned a failed response";
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReading = false;
  let bytes = 0;
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        doneReading = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES)
        throw new SearchError("schema", "Codex search stream exceeded its response size limit.");
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator?.index !== undefined) {
        if (separator.index > MAX_FRAME_CHARS)
          throw new SearchError("schema", "Codex search stream exceeded its event size limit.");
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parseSseFrame(frame);
        if (event) yield event;
        separator = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > MAX_FRAME_CHARS)
        throw new SearchError("schema", "Codex search stream exceeded its event size limit.");
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (!doneReading) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  buffer += decoder.decode();
  const trailing = parseSseFrame(buffer);
  if (trailing) yield trailing;
}

function parseSseFrame(frame: string): SseEvent | undefined {
  const lines = frame.split(/\r?\n/);
  let type = "";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return undefined;
  const raw = data.join("\n");
  if (raw === "[DONE]") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return { type, data: value };
  } catch {
    throw new SearchError("schema", "Codex search stream contained malformed event JSON.");
  }
}

function collectOutputItem(
  item: OutputItem | undefined,
  searchCalls: Map<string, SearchCall>,
  texts: string[],
  citations: Map<string, Citation>,
): void {
  if (!item) return;
  if (item.type === "web_search_call") {
    const id = optionalString(item.id);
    const key = id ?? `search-${searchCalls.size + 1}`;
    const query =
      optionalString(item.action?.query) ??
      (Array.isArray(item.action?.queries)
        ? item.action.queries.filter((value) => typeof value === "string").join(", ")
        : undefined);
    searchCalls.set(key, {
      id,
      status: optionalString(item.status),
      query,
      url: optionalString(item.action?.url),
      actionType: optionalString(item.action?.type),
    });
    return;
  }
  if (item.type !== "message" || item.role !== "assistant") return;
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (part?.type !== "output_text") continue;
    texts.push(optionalString(part.text) ?? "");
    for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
      if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
      citations.set(annotation.url, {
        title: optionalString(annotation.title),
        url: annotation.url,
        startIndex: optionalNumber(annotation.start_index),
        endIndex: optionalNumber(annotation.end_index),
      });
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
