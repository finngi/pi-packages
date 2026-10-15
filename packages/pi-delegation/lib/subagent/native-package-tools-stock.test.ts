import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageRecord } from "pi-runtime";
import { responsesFixture } from "../../../pi-codex-search/tests/fixtures/responses-sse.ts";

const packagedRoot = process.env.PI_CHILD_PACKAGED_ROOT;
assert.ok(!packagedRoot || isAbsolute(packagedRoot), "PI_CHILD_PACKAGED_ROOT must be absolute");
const packageFile = (name: string, source: string, compiled = source.replace(/\.ts$/, ".js")) =>
  packagedRoot
    ? realpathSync(join(packagedRoot, name, "dist", compiled))
    : fileURLToPath(new URL(`../../../${name}/${source}`, import.meta.url));
const { BackgroundProcesses } = (await import(
  pathToFileURL(packageFile("pi-runtime", "src/index.ts", "index.js")).href
)) as typeof import("pi-runtime");
const { launchChild } = (await import(
  pathToFileURL(packageFile("pi-delegation", "lib/subagent/child-launch.ts")).href
)) as typeof import("./child-launch.ts");
const { MESSAGE_BRIDGE } = (await import(
  pathToFileURL(packageFile("pi-delegation", "lib/subagent/messages.ts")).href
)) as typeof import("./messages.ts");
const { createNativeLauncher } = (await import(
  pathToFileURL(packageFile("pi-delegation", "lib/subagent/native-launcher.ts")).href
)) as typeof import("./native-launcher.ts");
const providerApi = packagedRoot
  ? pathToFileURL(join(packagedRoot, "@earendil-works/pi-ai/dist/compat.js")).href
  : import.meta.resolve("@earendil-works/pi-ai/compat");

const model = {
  id: "native-child-model",
  name: "Native child fixture",
  provider: "native-child-fixture",
  api: "native-child-fixture",
  baseUrl: "http://invalid.local",
  input: ["text"],
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

for (const selected of [undefined, ["bash"], ["codex_search"]])
  test(
    `native child package tools and OAuth with ${selected?.join(",") ?? "inherited tools"}`,
    { timeout: 30000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-native-package-child-"));
      const agentDir = join(root, "native-agent");
      const project = join(root, "project");
      const provider = join(root, "provider.mjs");
      const observed = join(root, "observed.json");
      const requests = join(root, "requests.json");
      const background = packageFile("pi-background", "extensions/background-process.ts");
      const search = packageFile("pi-codex-search", "extensions/search.ts");
      const messaging = packageFile("pi-delegation", "extensions/subagent.ts");
      const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_native_child" } })).toString("base64url")}.signature`;
      const auth = JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: token,
          refresh: "synthetic-refresh",
          expires: Date.now() + 3600000,
        },
      });
      const commands = {
        launch: `printf 'native-background-ready\\n'; printf '%s' "$$" > job.pid; sleep 60`,
        cancel: `attempt=0; while kill -0 "$(cat job.pid)" 2>/dev/null; do attempt=$((attempt+1)); [ "$attempt" -lt 200 ] || exit 1; sleep 0.01; done; printf cancel-verified`,
      };
      const transport = new BackgroundProcesses();
      const saved = { ...process.env };
      let child: Awaited<ReturnType<typeof launchChild>> | undefined;
      try {
        await Promise.all([mkdir(agentDir), mkdir(project)]);
        await writeFile(join(agentDir, "auth.json"), auth);
        await writeFile(
          join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              "openai-codex": {
                api: "openai-codex-responses",
                baseUrl: "https://chatgpt.com/backend-api",
                models: [
                  {
                    id: "codex-native-search",
                    name: "Synthetic search model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 8192,
                    maxTokens: 256,
                    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
        await writeFile(
          provider,
          `
import { createAssistantMessageEventStream } from ${JSON.stringify(providerApi)};
import { writeFileSync } from "node:fs";
export default function(pi) {
  let step = 0;
  const model = ${JSON.stringify(model)}, requests = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input), headers = new Headers(init?.headers);
    if (!url.startsWith("https://chatgpt.com/backend-api/codex/")) throw Error("Unexpected network request: " + url);
    if (headers.get("authorization") !== ${JSON.stringify(`Bearer ${token}`)} || headers.get("chatgpt-account-id") !== "acct_native_child") throw Error("Search did not use native OAuth");
    requests.push({ url, accountId: headers.get("chatgpt-account-id"), nativeOAuth: true });
    writeFileSync(${JSON.stringify(requests)}, JSON.stringify(requests));
    if (new URL(url).pathname.endsWith("/models")) return Response.json({ models: [{ slug: "codex-native-search", is_default: true }] });
    if (new URL(url).pathname.endsWith("/responses")) return new Response(${JSON.stringify(responsesFixture)}, { headers: { "content-type": "text/event-stream" } });
    throw Error("Unexpected Codex request: " + url);
  };
  pi.registerTool({ name: "provider_sibling", label: "Sibling", description: "Must remain excluded by native selection", parameters: { type: "object", properties: {} }, async execute() { throw Error("Sibling must not run"); } });
  pi.registerProvider(model.provider, {
    api: model.api, apiKey: "fixture", baseUrl: model.baseUrl, models: [model],
    streamSimple(m, ctx) {
      const active = pi.getActiveTools(), results = ctx.messages.filter(m => m.role === "toolResult");
      const job = results.find(m => m.toolName === "bash" && m.details?.id)?.details.id;
      const parent = JSON.parse(process.env.PI_SUBAGENT_CONTEXT).parentId;
      const steps = [
        ...(active.includes("codex_search") ? [{ name: "codex_search", arguments: { queries: ["native child OAuth search"] } }] : []),
        ...(active.includes("bash") && active.includes("background_process") ? [
          { name: "bash", arguments: { command: ${JSON.stringify(commands.launch)}, background: true } },
          { name: "bash", arguments: { command: "while [ ! -s job.pid ]; do sleep 0.01; done; printf foreground-ready" } },
          { name: "background_process", arguments: { action: "read", id: job } },
          { name: "background_process", arguments: { action: "cancel", id: job } },
          { name: "bash", arguments: { command: ${JSON.stringify(commands.cancel)} } },
        ] : active.includes("bash") ? [{ name: "bash", arguments: { command: "printf narrowed-bash" } }] : []),
        { name: "agent_message", arguments: { to: parent, message: "NATIVE_CHILD_MESSAGE", kind: "progress" } },
      ];
      const call = steps[step++], reason = call ? "toolUse" : "stop";
      if (!call) writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ active, results, nativeAgentDir: process.env.PI_CHILD_AGENT_DIR, isolatedAgentDir: process.env.PI_CODING_AGENT_DIR }));
      const message = { role: "assistant", content: call ? [{ type: "toolCall", id: "native-" + step, ...call }] : [{ type: "text", text: "NATIVE_CHILD_DONE" }], api: m.api, provider: m.provider, model: m.id, stopReason: reason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(); });
      return stream;
    },
  });
}
`,
        );
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PI_SUBAGENT_PROVIDER_EXTENSION = provider;
        delete process.env.PI_SECURITY_TRANSPORT;
        delete process.env.PI_SUBAGENT;
        const pi = {
          events: { emit() {} },
          getActiveTools: () => ["bash", "background_process", "codex_search"],
          getAllTools: () => [
            { name: "bash", sourceInfo: { path: background, scope: "user" } },
            { name: "background_process", sourceInfo: { path: background, scope: "user" } },
            { name: "codex_search", sourceInfo: { path: search, scope: "user" } },
            { name: "provider_sibling", sourceInfo: { path: provider, scope: "user" } },
          ],
          getCommands: () => [],
          getThinkingLevel: () => "off",
        } as unknown as ExtensionAPI;
        const modelRegistry = {
          find: (provider: string, id: string) =>
            provider === model.provider && id === model.id ? model : undefined,
          getRegisteredNativeProvider: () => undefined,
          getRegisteredProviderConfig: () => undefined,
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: "synthetic-selected-model-key",
            headers: {},
          }),
          getAvailableOfType: async () => [model],
        };
        const launcher = createNativeLauncher(
          pi,
          () => ({ cwd: project, model, modelRegistry }) as unknown as ExtensionContext,
          messaging,
        );
        const usage: UsageRecord[] = [],
          messages: unknown[] = [];
        child = await launchChild({
          launcher,
          transport,
          isCurrent: () => true,
          spec: {
            task: "Exercise native child package tools",
            instructions: "Run the deterministic fixture.",
            ...(selected ? { tools: selected } : {}),
            communication: {
              id: "agent-bright-coral-river",
              name: "worker",
              parentId: "agent-calm-silver-forest",
              parentName: "main",
            },
          },
          onUsage: (record) => usage.push(record),
          onMessage: async (request) => {
            const message = JSON.parse(String(request.title).slice(MESSAGE_BRIDGE.length));
            messages.push(message);
            return {
              type: "extension_ui_response",
              id: request.id,
              value: JSON.stringify({ accepted: true }),
            };
          },
        });
        assert.equal(
          child.prepared.argv[1],
          packageFile("pi-delegation", "lib/subagent/child-rpc.ts"),
        );
        assert.equal(child.prepared.env.PI_CHILD_AGENT_DIR, agentDir);
        assert.notEqual(child.prepared.env.PI_CODING_AGENT_DIR, agentDir);
        assert.equal(
          child.prepared.argv.includes(background),
          selected === undefined || selected.includes("bash"),
        );
        assert.equal(
          child.prepared.argv.includes(search),
          selected === undefined || selected.includes("codex_search"),
        );
        await child.start("Run native package fixture.");
        await child.dialogue.waitIdle(15000);
        assert.equal(
          child.dialogue.snapshot().status,
          "idle",
          JSON.stringify(child.dialogue.snapshot()),
        );
        const evidence = JSON.parse(await readFile(observed, "utf8"));
        const expected = [
          ...(selected ?? ["bash", "background_process", "codex_search"]),
          "agent_list",
          "agent_message",
        ].sort();
        assert.deepEqual(evidence.active.sort(), expected);
        assert.ok(
          evidence.results.every((result: any) => !result.isError),
          JSON.stringify(evidence.results),
        );
        assert.equal(evidence.nativeAgentDir, agentDir);
        assert.notEqual(evidence.isolatedAgentDir, agentDir);
        assert.equal(messages.length, 1);
        assert.deepEqual(
          messages[0] && {
            to: (messages[0] as any).to,
            message: (messages[0] as any).message,
            kind: (messages[0] as any).kind,
          },
          { to: "agent-calm-silver-forest", message: "NATIVE_CHILD_MESSAGE", kind: "progress" },
        );
        const hasSearch = selected === undefined || selected.includes("codex_search");
        if (hasSearch) {
          const searchResult = evidence.results.find(
            (result: any) => result.toolName === "codex_search",
          );
          assert.equal(searchResult.details.successes[0].text, "Fixture answer with a source.");
          assert.equal(searchResult.usage.totalTokens, 19);
          assert.ok(Math.abs(searchResult.usage.cost.total - 0.000026) < 1e-12);
          assert.equal(searchResult.details.piUsageWarnings, undefined);
          const http = JSON.parse(await readFile(requests, "utf8"));
          assert.equal(http.length, 2, "one catalogue lookup and one search request");
          assert.ok(
            http.every(
              (request: any) => request.nativeOAuth && request.accountId === "acct_native_child",
            ),
          );
        } else await assert.rejects(readFile(requests), { code: "ENOENT" });
        if (selected === undefined) {
          const launch = evidence.results.find(
            (result: any) => result.toolName === "bash" && result.details?.id,
          );
          assert.equal(launch.details.running, true);
          assert.equal(typeof launch.details.id, "string");
          assert.match(
            evidence.results.find((result: any) => result.toolName === "background_process")
              .content[0].text,
            /native-background-ready/,
          );
          assert.ok(
            evidence.results.some((result: any) => result.content?.[0]?.text === "cancel-verified"),
          );
        }
        const stats = await child.dialogue.request({ type: "get_session_stats" });
        assert.equal((stats.data as any).tokens.total, hasSearch ? 19 : 0);
        await child.dialogue.reconcileUsage();
        await child.dialogue.reconcileUsage();
        const total = () =>
          usage.reduce((sum, record) => sum + (record.usage?.totalTokens ?? 0), 0);
        const cost = () => usage.reduce((sum, record) => sum + (record.usage?.cost.total ?? 0), 0);
        assert.equal(total(), hasSearch ? 19 : 0);
        await child.close();
        await child.close();
        assert.equal(
          total(),
          hasSearch ? 19 : 0,
          "stats reconciliation and repeated close must not duplicate search usage",
        );
        assert.ok(
          Math.abs(cost() - (hasSearch ? 0.000026 : 0)) < 1e-12,
          "search cost is forwarded once",
        );
        assert.equal(
          await readFile(join(agentDir, "auth.json"), "utf8"),
          auth,
          "native OAuth remains in its original profile",
        );
      } catch (error) {
        const output = child
          ? transport
              .read(child.id, 0, 1000000)
              .chunks.filter((chunk) => chunk.stream === "stderr")
              .map((chunk) => chunk.data.toString())
              .join("")
          : "";
        throw new Error(`Native child fixture failed: ${String(error)}\n${output}`, {
          cause: error,
        });
      } finally {
        await child?.close().catch(() => {});
        await transport.close();
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
