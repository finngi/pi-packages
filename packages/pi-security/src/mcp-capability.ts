import type { ExecutionPermissions } from "./types.ts";
import { networkAllows, permitsNetwork } from "./permissions.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { canonicalizeHost } from "./fetch-proxy.ts";

const mcpPrivate = new URL(
  "./extensions/mcp/config.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href;
const corePrivate = new URL(
  "./core/mcp-servers.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href;
const [configModule, coreModule, resolveModule] = await Promise.all([
  import(mcpPrivate),
  import(corePrivate),
  import(
    new URL(
      "./core/resolve-config-value.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href
  ),
]);
const { loadMcpConfig } = configModule;
const { mcpNamespace } = coreModule;
const { resolveHeadersOrThrow } = resolveModule;

const resourceTools = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
type Rpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Ticket = {
  generation: number;
  server: string;
  tool: string;
  method: string;
  paramsHash: string;
  attempts: number;
};
type Entry = {
  name: string;
  config: {
    url?: string;
    headers?: Record<string, string>;
    exposure?: string;
    toolExposure?: Record<string, string>;
    [key: string]: unknown;
  };
  source?: string;
  scope?: string;
};
type Loaded = { policy: { resources: { network: string[] } }; sha256?: string };
type RegisteredTool = {
  name: string;
  label: string;
  namespace?: { name?: string };
  exposure?: string;
  execute?: (...args: unknown[]) => unknown;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceFingerprint = (source: string) => {
  if (!source || source === "extension") return "extension";
  const stat = statSync(source, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw Error("MCP config source is unavailable");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
};
const endpointOf = (entry: Entry) => {
  if (typeof entry.config.url !== "string") throw Error("MCP stdio transport is unsupported");
  const url = new URL(entry.config.url);
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password)
    throw Error("MCP endpoint must be an HTTP(S) URL without embedded credentials");
  return url;
};
const hostAllowed = (url: URL, hosts: string[]) => networkAllows(hosts, url);

export function createMcpCapability({
  getLoaded,
  getUnavailableReason,
  isCurrent,
  enabled,
  isRegisteredOwner,
}: {
  getLoaded: () => Loaded | undefined;
  getUnavailableReason?: () => string;
  isCurrent: () => boolean;
  enabled: () => boolean;
  isRegisteredOwner: (name: string) => Promise<boolean>;
}) {
  let generation = 0;
  const entries = new Map<
    string,
    { entry: Entry; endpoint: URL; generation: number; source: string }
  >();
  const tools = new Map<
    string,
    { server: string; raw: string; namespace: string; label: string; generation: number }
  >();
  const resources = new Map<string, string>();
  const tickets = new Map<string, Ticket>();
  const dispatchContext = new AsyncLocalStorage<string>();
  const clear = () => {
    generation++;
    entries.clear();
    tools.clear();
    resources.clear();
    tickets.clear();
  };
  const loadConfig = (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
    const loaded = getLoaded();
    if (!enabled())
      return {
        servers: [],
        errors: [
          "Native MCP is disabled. Restart Pi with --security-mcp to enable secured HTTP MCP.",
        ],
        autoEnableCodemode: false,
      };
    if (!isCurrent() || !loaded)
      return {
        servers: [],
        errors: [
          getUnavailableReason
            ? `pi-security could not initialize: ${getUnavailableReason()}`
            : "pi-security policy is unavailable",
        ],
        autoEnableCodemode: false,
      };
    generation++;
    entries.clear();
    tools.clear();
    resources.clear();
    tickets.clear();
    const config = loadMcpConfig({
      agentDir: process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent`,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    config.autoEnableCodemode = false;
    const accepted: Entry[] = [];
    for (const server of config.servers as Entry[]) {
      try {
        const endpoint = endpointOf(server);
        if (!hostAllowed(endpoint, loaded.policy.resources.network))
          throw Error("endpoint is outside policy.resources.network");
        server.config.exposure ??= "deferred";
        const source = server.source ?? "";
        entries.set(server.name, {
          entry: server,
          endpoint,
          generation,
          source: `${source}\0${sourceFingerprint(source)}`,
        });
        accepted.push(server);
      } catch (error) {
        config.errors.push(
          `${server.name}: ${error instanceof Error ? error.message : "MCP entry refused"}`,
        );
      }
    }
    config.servers = accepted as typeof config.servers;
    return config;
  };
  const assertTicket = async (callId: string, tool: string, input: unknown) => {
    const ticket = tickets.get(callId);
    if (
      !ticket ||
      ticket.tool !== tool ||
      ticket.generation !== generation ||
      !isCurrent() ||
      !enabled()
    )
      throw Error("MCP execution has no current Pi tool-call approval");
    if (!(await isRegisteredOwner(tool))) throw Error("MCP tool registration source is not owned");
    const bound = entries.get(ticket.server);
    if (
      !bound ||
      bound.generation !== generation ||
      bound.source !==
        `${bound.entry.source ?? ""}\0${sourceFingerprint(bound.entry.source ?? "")}` ||
      !hostAllowed(bound.endpoint, getLoaded()?.policy.resources.network ?? [])
    )
      throw Error("MCP connection binding is stale or outside current policy");
    let params: unknown;
    if (ticket.method === "tools/call") {
      const binding = tools.get(tool);
      if (!binding || binding.server !== ticket.server)
        throw Error("MCP tool no longer belongs to its approved connection");
      params = { name: binding.raw, arguments: input };
    } else {
      if (!object(input) || input.server !== ticket.server)
        throw Error("MCP resource execution does not match its approved server");
      if (ticket.method === "resources/read") {
        if (typeof input.uri !== "string" || !input.uri)
          throw Error("MCP resource read requires an approved URI");
        params = { uri: input.uri };
      } else {
        params = typeof input.cursor === "string" && input.cursor ? { cursor: input.cursor } : {};
      }
    }
    if (ticket.paramsHash !== hash(params))
      throw Error("MCP execution input does not match its approval");
  };
  const wrapApi = (api: ExtensionAPI): ExtensionAPI =>
    new Proxy(api, {
      get(target, property) {
        if (property === "registerTool")
          return (definition: RegisteredTool) => {
            if (resourceTools.has(definition.name)) {
              resources.set(definition.name, definition.label);
            } else {
              const namespace = definition.namespace?.name;
              const match = [...entries.values()].find(
                ({ entry }) =>
                  namespace === mcpNamespace(entry.name) &&
                  definition.label.startsWith(`${entry.name}/`),
              );
              if (match) {
                const raw = definition.label.slice(match.entry.name.length + 1);
                if (raw && match.generation === generation) {
                  const next = {
                    server: match.entry.name,
                    raw,
                    namespace: namespace!,
                    label: definition.label,
                    generation,
                  };
                  const existing = tools.get(definition.name);
                  if (!existing) tools.set(definition.name, next);
                  else if (
                    existing.server !== next.server ||
                    existing.raw !== next.raw ||
                    existing.namespace !== next.namespace ||
                    existing.label !== next.label
                  )
                    tools.delete(definition.name);
                }
              }
            }
            const execute = definition.execute;
            const wrapped = execute
              ? {
                  ...definition,
                  execute(...args: unknown[]) {
                    const callId = args[0];
                    if (typeof callId !== "string" || !callId)
                      throw Error("MCP tool execution has no Pi tool call ID");
                    return dispatchContext.run(callId, async () => {
                      await assertTicket(callId, definition.name, args[1]);
                      return execute.apply(definition, args);
                    });
                  },
                }
              : definition;
            return target.registerTool(wrapped as never);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const looksLikeMcpTool = (name: string, info?: Pick<ToolInfo, "namespace">) =>
    name.startsWith("mcp__") || info?.namespace?.name?.startsWith("mcp__") === true;
  const isOwnedMcpTool = (
    name: string,
    info?: Pick<ToolInfo, "name" | "namespace" | "exposure">,
  ) => {
    const binding = tools.get(name);
    return (
      !!binding &&
      binding.generation === generation &&
      info?.name === name &&
      info.namespace?.name === binding.namespace
    );
  };
  const isResourceTool = (name: string, info?: Pick<ToolInfo, "name">) =>
    resourceTools.has(name) && resources.get(name) !== undefined && info?.name === name;
  const issue = (
    callId: string,
    tool: string,
    params: unknown,
    info: ToolInfo,
    permissions: ExecutionPermissions,
  ) => {
    if (!isCurrent()) throw Error("MCP capability is stale");
    const binding = tools.get(tool);
    if (!binding || !isOwnedMcpTool(tool, info))
      throw Error("MCP tool has no unique live connection binding");
    const bound = entries.get(binding.server);
    if (
      !bound ||
      bound.generation !== generation ||
      !hostAllowed(bound.endpoint, getLoaded()?.policy.resources.network ?? [])
    )
      throw Error("MCP connection binding is stale or outside current policy");
    if (!permissions || !permitsNetwork(permissions, bound.endpoint))
      throw Error("MCP destination is not in the approved permissions");
    const actual = { name: binding.raw, arguments: params };
    if (tickets.has(callId)) throw Error("duplicate outstanding MCP tool call ID");
    tickets.set(callId, {
      generation,
      server: binding.server,
      tool,
      method: "tools/call",
      paramsHash: hash(actual),
      attempts: 0,
    });
  };
  const issueResource = (
    callId: string,
    tool: string,
    method: string,
    input: Record<string, unknown>,
    info: ToolInfo,
    permissions: ExecutionPermissions,
  ) => {
    if (!isCurrent() || !isResourceTool(tool, info)) throw Error("MCP resource tool is unowned");
    if (typeof input.server !== "string")
      throw Error("MCP resource operation requires a bound server");
    const bound = entries.get(input.server);
    if (
      !bound ||
      bound.generation !== generation ||
      !hostAllowed(bound.endpoint, getLoaded()?.policy.resources.network ?? [])
    )
      throw Error("MCP resource server is unbound or outside current policy");
    if (!permissions || !permitsNetwork(permissions, bound.endpoint))
      throw Error("MCP destination is not in the approved permissions");
    let params: Record<string, unknown>;
    if (method === "resources/read") {
      if (typeof input.uri !== "string" || !input.uri)
        throw Error("MCP resource read requires a URI");
      params = { uri: input.uri };
    } else {
      params = {};
      if (typeof input.cursor === "string" && input.cursor) params.cursor = input.cursor;
    }
    if (tickets.has(callId)) throw Error("duplicate outstanding MCP tool call ID");
    tickets.set(callId, {
      generation,
      server: input.server,
      tool,
      method,
      paramsHash: hash(params),
      attempts: 0,
    });
  };
  const revoke = (callId: string) => {
    tickets.delete(callId);
  };
  const transport = (entry: Entry, _cwd: string, authProvider?: unknown) => {
    if (!isCurrent()) throw Error("MCP security is not ready");
    const bound = entries.get(entry.name);
    if (
      !bound ||
      bound.generation !== generation ||
      (bound.entry !== entry && bound.endpoint.href !== endpointOf(entry).href)
    )
      throw Error("MCP config changed after admission");
    const endpoint = bound.endpoint;
    const connectionCurrent = () => {
      const loaded = getLoaded();
      return Boolean(
        enabled() &&
          isCurrent() &&
          loaded &&
          bound.generation === generation &&
          bound.source ===
            `${bound.entry.source ?? ""}\0${sourceFingerprint(bound.entry.source ?? "")}` &&
          hostAllowed(endpoint, loaded.policy.resources.network),
      );
    };
    const authFetch = async (input: string | URL, init?: RequestInit) => {
      const requested = new URL(input);
      const loaded = getLoaded();
      if (
        !(requested.protocol === "http:" || requested.protocol === "https:") ||
        requested.username ||
        requested.password ||
        !enabled() ||
        !isCurrent() ||
        !loaded ||
        bound.generation !== generation ||
        bound.source !==
          `${bound.entry.source ?? ""}\0${sourceFingerprint(bound.entry.source ?? "")}` ||
        !hostAllowed(requested, loaded.policy.resources.network) ||
        (init?.method !== undefined && !["GET", "POST"].includes(init.method.toUpperCase())) ||
        (init?.redirect !== undefined && init.redirect !== "error")
      )
        throw Error("MCP authentication request is outside current network.tools policy");
      return globalThis.fetch(input, { ...init, redirect: "error" });
    };
    const fetch = async (input: string | URL, init?: RequestInit) => {
      const requested = new URL(input);
      if (
        requested.href !== endpoint.href ||
        (init?.redirect !== undefined && init.redirect !== "error")
      )
        throw Error("MCP transport endpoint or redirect policy changed");
      const method = init?.method;
      if (method === "DELETE") {
        if (
          bound.source !==
          `${bound.entry.source ?? ""}\0${sourceFingerprint(bound.entry.source ?? "")}`
        )
          throw Error("MCP cleanup refused after config change");
        return globalThis.fetch(input, { ...init, redirect: "error" });
      }
      const loaded = getLoaded();
      if (
        !connectionCurrent() ||
        !loaded ||
        !hostAllowed(requested, loaded.policy.resources.network)
      )
        throw Error("MCP request is outside active policy");
      if (method !== "POST") throw Error("MCP HTTP method is unsupported");
      const rpc: Rpc | undefined =
        typeof init?.body === "string"
          ? (() => {
              try {
                const value: unknown = JSON.parse(init.body as string);
                return object(value) ? (value as Rpc) : undefined;
              } catch {
                return undefined;
              }
            })()
          : undefined;
      if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string")
        throw Error("invalid MCP JSON-RPC request");
      let ticketId: string | undefined;
      if (rpc.method === "tools/call") {
        if (!object(rpc.params) || typeof rpc.params.name !== "string")
          throw Error("invalid MCP tools/call");
        const keys = Object.keys(rpc.params);
        if (keys.some((key) => !["name", "arguments", "_meta"].includes(key)))
          throw Error("unexpected MCP tools/call fields");
        if (
          rpc.params._meta !== undefined &&
          (!object(rpc.params._meta) ||
            Object.keys(rpc.params._meta).some((key) => key !== "progressToken") ||
            !(
              typeof rpc.params._meta.progressToken === "string" ||
              (typeof rpc.params._meta.progressToken === "number" &&
                Number.isSafeInteger(rpc.params._meta.progressToken))
            ))
        )
          throw Error("invalid MCP progress metadata");
        const params = {
          name: rpc.params.name,
          ...(rpc.params.arguments !== undefined ? { arguments: rpc.params.arguments } : {}),
        };
        ticketId = dispatchContext.getStore();
        if (!ticketId) throw Error("MCP tool call is outside its Pi dispatch context");
        const ticket = tickets.get(ticketId);
        if (
          !ticket ||
          ticket.server !== entry.name ||
          ticket.method !== rpc.method ||
          ticket.paramsHash !== hash(params)
        )
          throw Error("MCP tool call does not match the active Pi dispatch ticket");
      } else if (
        ["resources/list", "resources/templates/list", "resources/read"].includes(rpc.method)
      ) {
        ticketId = dispatchContext.getStore();
        if (!ticketId || (rpc.method === "resources/read" && !object(rpc.params)))
          throw Error("MCP resource call is outside its Pi dispatch context");
        const params = object(rpc.params) ? rpc.params : {};
        const ticket = tickets.get(ticketId);
        if (
          !ticket ||
          ticket.server !== entry.name ||
          ticket.method !== rpc.method ||
          ticket.paramsHash !== hash(params)
        )
          throw Error("MCP resource call does not match the active Pi dispatch ticket");
      } else if (
        !["initialize", "notifications/initialized", "ping", "tools/list"].includes(rpc.method)
      ) {
        throw Error(`MCP operation ${rpc.method} is not admitted`);
      }
      if (ticketId) {
        const ticket = tickets.get(ticketId);
        if (!ticket || ticket.generation !== generation || ticket.attempts >= 2)
          throw Error("MCP operation has no matching security approval");
        ticket.attempts++;
      }
      if (
        bound.generation !== generation ||
        bound.source !==
          `${bound.entry.source ?? ""}\0${sourceFingerprint(bound.entry.source ?? "")}`
      )
        throw Error("MCP config changed after connection admission");
      let response: Response;
      try {
        response = await globalThis.fetch(input, { ...init, redirect: "error" });
      } catch (error) {
        if (ticketId) tickets.delete(ticketId);
        throw error;
      }
      if (
        ticketId &&
        ((response.status !== 401 && response.status !== 403) ||
          (tickets.get(ticketId)?.attempts ?? 0) >= 2)
      )
        tickets.delete(ticketId);
      return response;
    };
    const sdkAuth = authProvider as
      | {
          token?: () => Promise<string | undefined>;
          onUnauthorized?: (context: unknown) => Promise<void>;
          settled?: () => Promise<void>;
        }
      | undefined;
    const auth = sdkAuth
      ? {
          token: () => {
            if (!connectionCurrent())
              throw Error("MCP authentication refused for a stale connection");
            return sdkAuth.token?.() ?? Promise.resolve(undefined);
          },
          settled: () => sdkAuth.settled?.() ?? Promise.resolve(),
          onUnauthorized: (context: { response: Response; serverUrl: URL; token?: string }) =>
            sdkAuth.onUnauthorized?.({
              ...context,
              fetch: authFetch,
            }),
        }
      : undefined;
    return new StreamableHttpTransport({
      url: endpoint,
      headers: resolveHeadersOrThrow(entry.config.headers, `MCP server "${entry.name}"`),
      authProvider: auth as never,
      fetch,
      openGetStream: false,
      reconnect: { maxRetries: 0 },
    });
  };
  const requiredNetwork = (tool: string, input: Record<string, unknown>): string[] => {
    const server = resourceTools.has(tool) ? input.server : tools.get(tool)?.server;
    const bound = typeof server === "string" ? entries.get(server) : undefined;
    if (!bound || bound.generation !== generation)
      throw Error("MCP network destination is unbound");
    return [
      `${bound.endpoint.hostname}:${bound.endpoint.port || (bound.endpoint.protocol === "https:" ? "443" : "80")}`,
    ];
  };
  return {
    requiredNetwork,
    loadConfig,
    transport,
    wrapApi,
    issue,
    issueResource,
    revoke,
    clear,
    isMcpTool: looksLikeMcpTool,
    isOwnedMcpTool,
    isResourceTool,
  };
}
