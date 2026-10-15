// Actual stock SDK + native package loader; scripted model, no external service or user profile.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-permissions-stock-"));
const previous = process.env.PI_CODING_AGENT_DIR;
let session;
try {
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await Promise.all([agentDir, cwd].map((directory) => mkdir(directory)));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(path.join(cwd, "input.txt"), "stock read works");
  await writeFile(
    path.join(agentDir, "permissions.json"),
    JSON.stringify({
      mode: "auto",
      classifier: { model: "fixture/unavailable" },
      deny: [{ tool: "bash", match: { program: "sudo" } }],
      allow: [{ tool: "read" }, { tool: "bash", match: { program: "printf" } }],
    }),
  );
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "permission-fixture",
    provider: "permission-fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const calls = [
    { name: "read", arguments: { path: "input.txt" } },
    { name: "bash", arguments: { command: "printf allowed" } },
    { name: "bash", arguments: { command: "sudo true" } },
    { name: "write", arguments: { path: "should-not-exist", content: "blocked" } },
  ];
  let index = 0;
  const runtime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple() {
      const stream = createAssistantMessageEventStream();
      const next = calls[index++];
      const reason = next ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: `call-${index}`, ...next }]
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
  const packagePath =
    process.env.PI_PERMISSIONS_PACKAGE || fileURLToPath(new URL("..", import.meta.url));
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [packagePath],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(
    loader.getExtensions().extensions.length,
    1,
    "native package loads only the permission extension",
  );
  session = (
    await sdk.createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      settingsManager: sdk.SettingsManager.inMemory(),
      sessionManager: sdk.SessionManager.inMemory(),
    })
  ).session;
  await session.bindExtensions({
    onError(error) {
      throw Error(JSON.stringify(error));
    },
  });
  await session.prompt("Read input.txt and check permissions without creating the blocked file.");
  const results = session.state.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  const text = (message) =>
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  assert.match(text(results[0]), /stock read works/);
  assert.match(text(results[1]), /allowed/);
  assert.match(text(results[2]), /pi-permissions: deny rule deny\[0\]/);
  assert.match(text(results[3]), /classifier model fixture\/unavailable is unavailable/);
  await assert.rejects(access(path.join(cwd, "should-not-exist")));
  assert.equal(
    session.getAllTools().filter((tool) => tool.sourceInfo?.source === "extension").length,
    0,
    "gate registers no replacement tools",
  );
  console.log(
    "Stock Pi: one native permission package; original read/bash execute; deny and missing classifier block before writes.",
  );
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  }
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
