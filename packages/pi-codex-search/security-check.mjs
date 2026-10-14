// Real stock-Pi admission and pi-security capability; synthetic OAuth and scripted HTTP only.
// Usage: node security-check.mjs [path to pi-security/src/extension.mjs]
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const securityExtension = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../pi-security/src/extension.ts", import.meta.url)),
);
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-search-security-")));
const saved = { env: { ...process.env }, cwd: process.cwd() };
let session;
const put = async (path, text) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

try {
  const home = join(root, "home"),
    agentDir = join(root, "agent"),
    cwd = join(root, "project"),
    scratch = join(root, "tmp");
  await Promise.all([home, agentDir, cwd, scratch].map((path) => mkdir(path, { mode: 0o700 })));
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_SECURITY_TMP: scratch,
    PI_SECURITY_POLICY: join(agentDir, "policy.json"),
    PI_SECURITY_MCP: join(agentDir, "fixture-mcp.json"),
    PI_SECURITY_ACTIVATION: "active",
    PI_SECURITY_PLACEMENT: "host",
    PI_SECURITY_TRANSPORT: "internal",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  });
  delete process.env.PI_SUBAGENT;
  delete process.env.PI_POLICY_LAUNCH;
  process.chdir(cwd);
  await put(process.env.PI_SECURITY_MCP, '{"servers":{}}');
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai/compat");
  const { createCodexSearchExtension } = await import("./extensions/search.ts");
  const { responsesFixture, streamFrom } = await import("./tests/fixtures/responses-sse.ts");
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
  const credentials = {
    async read(provider) {
      return provider === "openai-codex"
        ? {
            type: "oauth",
            access: token,
            refresh: "fixture-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "stored-account-must-not-be-used",
          }
        : undefined;
    },
    async list() {
      return [{ providerId: "openai-codex", type: "oauth" }];
    },
    async modify(provider, update) {
      return update(await this.read(provider));
    },
    async delete() {},
  };
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(scratch, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = {
    id: "scripted",
    name: "Scripted",
    provider: "search-fixture",
    api: "search-fixture-api",
    baseUrl: "https://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  let modelCalls = 0;
  const params = { queries: ["fixture search"] };
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture-only",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: () => {
      const stream = ai.createAssistantMessageEventStream(),
        first = modelCalls++ === 0,
        reason = first ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: first
          ? [
              {
                type: "toolCall",
                id: "fixture-search",
                name: "codex_search",
                arguments: structuredClone(params),
              },
            ]
          : [{ type: "text", text: "done" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { ...model.cost, total: 0 },
        },
        stopReason: reason,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message });
        stream.end();
      });
      return stream;
    },
  });
  const interceptor = join(root, "interceptor.mjs");
  await put(
    interceptor,
    `export default function(pi) { pi.events.on('pi-security:service:v1',request => { const respond=request.respond; request.respond=service => { const prepare=service.prepareSearch; service.prepareSearch=spec => { globalThis.__searchCheck.prepared.push(structuredClone({toolCallId:spec.toolCallId,input:spec.input})); const cap=prepare(spec); globalThis.__searchCheck.signals.push(cap.signal); const dispatch=cap.dispatch,release=cap.release; return {...cap, dispatch:(input,url,operation)=>{globalThis.__searchCheck.dispatches.push(url);return dispatch(input,url,operation);},release:()=>{globalThis.__searchCheck.releases++;return release();}}; }; respond(service); }; }); }`,
  );
  const outcomes = [];
  for (const scenario of [
    "allow",
    "host-refused",
    "approval-refused",
    "deny",
    "duplicate-service",
  ]) {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const evidence = { prepared: [], signals: [], dispatches: [], releases: 0, approvals: 0 };
    globalThis.__searchCheck = evidence;
    const policy = {
      version: 2,
      mode: "manual",
      resources: {
        write: ["${project}", "${tmp}"],
        denyRead: [],
        denyWrite: [],
        network: scenario === "host-refused" ? [] : ["chatgpt.com:443"],
      },
      classifier: { model: "none", timeoutSec: 5 },
      approvalTimeoutSec: 30,
      env: { path: [], assignAllow: [] },
      deny: scenario === "deny" ? [{ id: "fixture-deny-search", tool: "codex_search" }] : [],
      allow: [
        {
          id: "fixture-search",
          tool: "codex_search",
          permissions: {
            write: false,
            network: scenario === "approval-refused" ? [] : ["chatgpt.com:443"],
          },
        },
      ],
    };
    await put(process.env.PI_SECURITY_POLICY, JSON.stringify(policy));
    const requests = [];
    const search = createCodexSearchExtension({
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push(url);
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
        assert.equal(new Headers(init.headers).get("chatgpt-account-id"), "fixture-account");
        assert.equal(init.redirect, "manual");
        assert(init.signal instanceof AbortSignal);
        if (url.includes("/models"))
          return Response.json({ models: [{ slug: "fixture-codex", is_default: true }] });
        return new Response(streamFrom([new TextEncoder().encode(responsesFixture)]));
      },
    });
    let api;
    const factories = [
      (pi) => {
        api = pi;
      },
      search,
    ];
    if (scenario === "duplicate-service")
      factories.push((pi) =>
        pi.events.on("pi-security:service:v1", (request) =>
          request.respond({
            version: 1,
            prepareSearch() {
              throw Error("duplicate must not prepare");
            },
          }),
        ),
      );
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [interceptor, securityExtension],
      extensionFactories: factories,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      noTools: "builtin",
    }));
    const startupNotifications = [];
    await session.bindExtensions({
      uiContext: {
        setStatus() {},
        async select(_title, choices) {
          assert.equal(
            scenario,
            "approval-refused",
            "only the ungranted permission asks for approval",
          );
          assert.deepEqual(choices, ["Allow", "Deny"]);
          evidence.approvals++;
          return "Deny";
        },
        notify: (message, type) => startupNotifications.push({ message, type }),
      },
      onError: (error) => {
        throw Error(JSON.stringify(error));
      },
    });
    session.setActiveToolsByName(["codex_search"]);
    const services = [];
    api.events.emit("pi-security:service:v1", {
      version: 1,
      respond: (service) => services.push(service),
    });
    assert.equal(
      services.length,
      scenario === "duplicate-service" ? 2 : 1,
      `real security initialization required for every scenario: ${JSON.stringify(startupNotifications)}`,
    );
    modelCalls = 0;
    let result;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "codex_search") result = event;
    });
    await session.prompt("Run fixture search once.");
    assert(result, scenario);
    if (scenario === "allow") {
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(requests.length, 2);
      assert.deepEqual(evidence.dispatches, requests);
      assert.deepEqual(evidence.prepared, [{ toolCallId: "fixture-search", input: params }]);
      assert.equal(evidence.releases, 1);
      assert(evidence.signals.every((signal) => signal.aborted));
      assert.equal(
        result.result.structuredContent.successes[0].citations[0].url,
        "https://example.com/source",
      );
    } else {
      assert.equal(result.isError, true, scenario);
      assert.equal(requests.length, 0);
      const message = JSON.stringify(result);
      if (scenario === "host-refused")
        assert.match(message, /requested network access exceeds hard limits/);
      if (scenario === "approval-refused") assert.match(message, /human denied or cancelled/);
      if (scenario === "deny") assert.match(message, /fixture-deny-search/);
      if (scenario === "duplicate-service") assert.match(message, /exactly one active pi-security/);
    }
    if (scenario !== "allow") assert.equal(evidence.prepared.length, 0);
    assert.equal(evidence.approvals, scenario === "approval-refused" ? 1 : 0);
    assert.equal(startupNotifications.filter((notice) => notice.type === "error").length, 0);
    outcomes.push({
      scenario,
      requests: requests.length,
      capabilityPreparations: evidence.prepared.length,
      perRequestDispatches: evidence.dispatches.length,
      releases: evidence.releases,
      approvals: evidence.approvals,
    });
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    session = undefined;
  }
  console.log(
    JSON.stringify({
      ok: true,
      stockPi: "1.2.0",
      actualSecurity: securityExtension,
      syntheticOAuth: true,
      scriptedHttp: true,
      outcomes,
    }),
  );
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  delete globalThis.__searchCheck;
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
