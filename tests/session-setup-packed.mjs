import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const consumer = process.argv[2];
// The package test copies this module into the clean consumer before executing it.
const fromConsumer = (name) => import(name);
const sdk = await fromConsumer("@earendil-works/pi-coding-agent");
const ai = await fromConsumer("@earendil-works/pi-ai/compat");
const { default: subagents } = await fromConsumer("pi-delegation");
const { default: context } = await fromConsumer("pi-context");
const { default: resources } = await fromConsumer("pi-resources");
const cwd = join(consumer, "setup-project"),
  agentDir = join(consumer, "setup-agent");
await mkdir(cwd);
await mkdir(agentDir);
await mkdir(join(cwd, ".pi"));
const settingsPath = join(agentDir, "settings.json"),
  projectPath = join(cwd, ".pi/settings.json");
const global = JSON.stringify({ packages: [join(consumer, "packs/fixture")] });
const project = JSON.stringify({ subagents: { skills: { "pack-proof": false }, agents: {} } });
await writeFile(settingsPath, global);
await writeFile(projectPath, project);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SUBAGENT;
delete process.env.PI_SUBAGENT_CONTEXT;
const runtime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const model = {
  id: "setup-packed",
  name: "Setup packed",
  api: "setup-packed",
  provider: "setup-packed",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};
let calls = [],
  index = 0,
  session;
const results = [];
const extensionErrors = [];
runtime.registerProvider(model.provider, {
  api: model.api,
  apiKey: "fixture",
  baseUrl: model.baseUrl,
  models: [model],
  streamSimple() {
    const call = calls[index++],
      reason = call ? "toolUse" : "stop";
    const message = {
      role: "assistant",
      content: call
        ? [{ type: "toolCall", id: `packed-${index}`, name: "session_setup", arguments: call }]
        : [{ type: "text", text: "done" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: reason,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
async function open(manager) {
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      {
        path: "fixture:packed-setup",
        factory(pi) {
          subagents(pi);
          resources(pi);
          context(pi);
        },
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
  }));
  await session.bindExtensions({
    onError(error) {
      extensionErrors.push(error);
    },
  });
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "toolResult")
      results.push(event.message);
  });
}
async function run(next) {
  calls = next;
  index = 0;
  results.length = 0;
  await session.prompt("Exercise installed session setup.");
  assert(results.every((result) => !result.isError));
  assert.deepEqual(extensionErrors, [], "installed extensions must not hide startup/prompt errors");
}
async function close() {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
}
try {
  await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
  await run([
    { op: "list", query: "bm25", kinds: ["packages"] },
    { op: "apply", packages: ["fixture"], tools: ["read"] },
  ]);
  assert.equal(JSON.parse(results[0].content[0].text).candidates[0].id, "fixture");
  assert.deepEqual(JSON.parse(results[1].content[0].text).selected.skills, ["pack-proof"]);
  assert.deepEqual(new Set(session.getActiveToolNames()), new Set(["read", "session_setup"]));
  const file = session.sessionManager.getSessionFile();
  assert(file);
  await close();
  await open(sdk.SessionManager.open(file));
  await run([{ op: "list" }]);
  assert.deepEqual(JSON.parse(results[0].content[0].text).selected.skills, ["pack-proof"]);
  await run([{ op: "reset" }, { op: "list" }]);
  assert.deepEqual(JSON.parse(results[1].content[0].text).selected.skills, []);
  assert.equal(await readFile(settingsPath, "utf8"), global);
  assert.equal(await readFile(projectPath, "utf8"), project);
} finally {
  await close();
}
console.log("Packed stock Pi: list/apply/resume/reset passed; settings unchanged.");
