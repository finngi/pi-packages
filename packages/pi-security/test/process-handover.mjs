// Actual stock Pi, process manager and kernel confinement; deterministic provider for control timing.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { policy } from "./skeleton/fixture.mjs";
const saved = { env: { ...process.env }, cwd: process.cwd() };
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-process-handover-")));
const project = join(root, "project"),
  agent = join(root, "agent"),
  tmp = join(root, "tmp");
let session;
const until = async (check, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Timed out: ${label}`);
};
try {
  await Promise.all([project, agent, tmp].map((p) => mkdir(p)));
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agent,
    PI_SECURITY_POLICY: join(agent, "policy.json"),
    PI_SECURITY_TMP: tmp,
    TMPDIR: tmp + "/",
    PI_SECURITY_ACTIVATION: "active",
    PI_SECURITY_PLACEMENT: "host",
    PI_SECURITY_TRANSPORT: "extensions",
  });
  process.chdir(project);
  const p = policy();
  p.allow.push({ id: "handover-fixture", tool: "bash", permissions: { write: true, network: [] } });
  await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(p));
  const sdk = await import("@earendil-works/pi-coding-agent"),
    ai = await import("@earendil-works/pi-ai/compat");
  const model = {
    id: "fixture",
    name: "Fixture",
    api: "handover-fixture",
    provider: "handover-fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 128,
  };
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    allowModelNetwork: false,
  });
  let requests = 0,
    api,
    bg;
  const contexts = [],
    results = [];
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: (m, context) => {
      requests++;
      contexts.push(context);
      const content =
        requests === 1
          ? [
              {
                type: "toolCall",
                id: "foreground-call",
                name: "bash",
                arguments: { command: "printf ready >> started; sleep 2; printf done > completed" },
              },
            ]
          : [{ type: "text", text: "Answered the queued question." }];
      const reason = requests === 1 ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        content,
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { ...model.cost, total: 0 },
        },
        stopReason: reason,
        timestamp: Date.now(),
      };
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message });
        stream.end();
      });
      return stream;
    },
  });
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir: agent,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [
      join(packageRoot, "pi-security/src/extension.ts"),
      join(packageRoot, "pi-bg/extensions/background-process.ts"),
    ],
    extensionFactories: [
      (pi) => {
        api = pi;
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: project,
    agentDir: agent,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(project),
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
    model,
    noTools: "builtin",
  }));
  const errors = [];
  await session.bindExtensions({
    mode: "print",
    onError: (e) => errors.push(e),
    uiContext: { notify() {}, setStatus() {}, setWidget() {} },
  });
  api.events.emit("background:service", {
    respond: (service) => {
      bg = service;
    },
  });
  session.setActiveToolsByName(["bash", "background_process"]);
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") results.push(e);
  });
  const first = session.prompt("Run the foreground command.");
  await until(async () => {
    try {
      return !!(await readFile(join(project, "started"), "utf8"));
    } catch {
      return false;
    }
  }, "process started").catch((error) => {
    console.error(JSON.stringify({ results, errors }));
    throw error;
  });
  const marker = await readFile(join(project, "started"), "utf8");
  assert.equal(marker, "ready");
  await session.prompt("What is still running?", {
    streamingBehavior: "steer",
    source: "interactive",
  });
  await until(() => results.some((r) => r.toolName === "bash"), "foreground yielded");
  const result = results.find((r) => r.toolName === "bash");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.result.details.running, true);
  const id = result.result.details.id;
  assert.equal(bg.status(id).status, "running");
  assert.equal(
    await readFile(join(project, "started"), "utf8"),
    marker,
    "handover keeps the original process output",
  );
  await first;
  assert(
    contexts.some((c) => JSON.stringify(c.messages).includes("What is still running?")),
    "queued steer reaches model before process completes",
  );
  await until(() => bg.status(id).executionExited, "background completion");
  assert.equal(await readFile(join(project, "completed"), "utf8"), "done");
  assert.equal(await readFile(join(project, "started"), "utf8"), marker);
  assert.equal(
    results.filter((r) => r.toolName === "bash").length,
    1,
    "handover does not relaunch bash",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      stockPi: "1.1.0",
      sameProcess: true,
      steerDeliveredBeforeCompletion: true,
      foregroundYielded: true,
      backgroundCompleted: true,
      kernelConfinement: true,
      scriptedProvider: true,
    }),
  );
} finally {
  if (session) {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  }
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
