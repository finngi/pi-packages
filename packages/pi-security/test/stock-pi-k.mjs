import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { policy } from "./skeleton/fixture.mjs";
// Question: can the production stock gate serialize eight real nested codemode asks?
// Fields: results, shown count, peak dialogs, unavailable denial.
// Done: eight settle, one dialog maximum, unavailable classifier denies.
// Excludes live classifier quality and B's broader MCP/background integration.
const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-stock-k-"));
const saved = { cwd: process.cwd(), env: { ...process.env } };
let session;
try {
  const project = path.join(root, "project"),
    home = path.join(root, "home"),
    agentDir = path.join(root, "agent"),
    tmp = path.join(root, "tmp");
  await Promise.all([project, home, agentDir, tmp].map((p) => mkdir(p)));
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SECURITY_TMP: tmp,
    TMPDIR: tmp + "/",
    npm_config_cache: path.join(tmp, "cache"),
  });
  process.chdir(project);
  const sdk = await import("@earendil-works/pi-coding-agent"),
    ai = await import("@earendil-works/pi-ai/compat");
  const version = JSON.parse(
    await readFile(
      new URL(
        "../../../node_modules/@earendil-works/pi-coding-agent/package.json",
        import.meta.url,
      ),
    ),
  ).version;
  assert.equal(version, "1.1.0");
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "pi-k-script",
    provider: "local-k",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let calls, index;
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture-only",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: () => {
      const stream = ai.createAssistantMessageEventStream(),
        next = calls[index++],
        stopReason = next ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: "k-" + index, ...next }]
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { ...model.cost, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const metrics = { shown: 0, active: 0, max: 0 };
  let autoUnavailableDenied = false;
  const policyFile = path.join(agentDir, "policy.json");
  process.env.PI_SECURITY_POLICY = policyFile;
  for (const mode of ["auto", "manual"]) {
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const p = policy();
    p.mode = mode;
    p.approvalTimeoutSec = 0.1;
    p.allow.push({ id: "codemode-wrapper", tool: "codemode" });
    p.deny.push({ id: "deny-rm", tool: "bash", match: { program: "rm" } });
    await writeFile(policyFile, JSON.stringify(p));
    calls =
      mode === "auto"
        ? [{ name: "bash", arguments: { command: "printf unavailable-must-not-execute" } }]
        : [
            {
              name: "codemode",
              arguments: {
                code: "const r=await Promise.allSettled(Array.from({length:8},(_,i)=>tools.bash({command:'printf manual-'+i})));r.forEach((x,i)=>text({i,...x}));",
              },
            },
          ];
    index = 0;
    if (mode === "manual") {
      await writeFile(path.join(project, "blocked-marker"), "safe");
      calls.push({
        name: "bash",
        arguments: { command: "/usr/bin/env -u UNUSED /bin/bash -lc '/bin/rm blocked-marker'" },
      });
    }
    const loader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
      extensionFactories: [sdk.createCodemodeExtension({ models: false })],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (
      await sdk.createAgentSession({
        cwd: project,
        agentDir,
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: sdk.SettingsManager.inMemory(),
        sessionManager: sdk.SessionManager.inMemory(),
        noTools: "builtin",
        model,
        thinkingLevel: "off",
      })
    ).session;
    const errors = [];
    await session.bindExtensions({
      onError: (e) => errors.push(e),
      ...(mode === "manual"
        ? {
            uiContext: {
              select: async () => {
                metrics.shown++;
                metrics.active++;
                metrics.max = Math.max(metrics.max, metrics.active);
                await new Promise((r) => setTimeout(r, 15));
                metrics.active--;
                return "Allow";
              },
              notify() {},
              setStatus() {},
            },
          }
        : {}),
    });
    assert.deepEqual(errors, []);
    session.setActiveToolsByName(["bash", "codemode"]);
    const rows = [];
    session.subscribe((e) => {
      if (e.type === "tool_execution_end") rows.push(e);
    });
    await session.prompt("Run scripted checks", { source: "interactive" });
    if (mode === "auto") {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].isError, true);
      assert.match(JSON.stringify(rows[0].result), /unavailable/);
      autoUnavailableDenied = true;
    } else {
      const nested = rows.filter((r) => r.toolName === "bash" && r.toolCallId.includes("/"));
      assert.equal(nested.length, 8);
      assert.ok(nested.every((r) => !r.isError));
      assert.equal(rows.find((r) => r.toolName === "codemode").isError, false);
      assert.equal(metrics.shown, 8);
      assert.equal(metrics.max, 1);
      const refused = rows.find((r) => r.toolName === "bash" && !r.toolCallId.includes("/"));
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused.result), /deny-rm/);
      assert.equal(await readFile(path.join(project, "blocked-marker"), "utf8"), "safe");
      console.log(
        JSON.stringify({
          piVersion: version,
          productionExtension: true,
          actualCodemode: true,
          nestedCalls: 8,
          nestedCompleted: 8,
          uiShown: metrics.shown,
          peakDialogs: metrics.max,
          autoUnavailableDenied,
          wrapperDenyPreserved: true,
        }),
      );
    }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    session = undefined;
  }
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
