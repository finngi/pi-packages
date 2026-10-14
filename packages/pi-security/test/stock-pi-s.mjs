import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policy } from "./skeleton/fixture.mjs";

// Question: does one stock Pi agent loop gate five scripted calls and confine effects?
// Compared fields: tool result, project/outside markers, loopback listener count.
// Done when read/write/deny/outside/network outcomes are observed in one session.
// Does not check model intelligence, later command grammar, or classifier accuracy.
const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-stock-s-"));
const prior = { cwd: process.cwd(), env: { ...process.env } };
let session, server;
try {
  const project = path.join(root, "project"),
    outside = path.join(root, "outside");
  const home = path.join(root, "home"),
    agentDir = path.join(root, "agent"),
    tmp = path.join(root, "tmp");
  await Promise.all([project, outside, home, agentDir, tmp].map((dir) => mkdir(dir)));
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SECURITY_TMP: tmp,
    npm_config_cache: path.join(tmp, "npm-cache"),
    TMPDIR: `${tmp}/`,
  });
  process.chdir(project);
  const policyFile = path.join(agentDir, "policy.json");
  process.env.PI_SECURITY_POLICY = policyFile;
  await writeFile(policyFile, JSON.stringify(policy()));
  await writeFile(path.join(project, "input.txt"), "hello-read");
  await writeFile(path.join(project, "secret.txt"), "secret");
  await writeFile(
    path.join(project, "outside.mjs"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(path.join(outside, "marker"))}, 'escape');`,
  );
  let connections = 0;
  server = createServer((socket) => {
    connections++;
    socket.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await writeFile(
    path.join(project, "network.mjs"),
    `import {connect} from 'node:net'; const s=connect(${port},'127.0.0.1'); s.on('connect',()=>{console.log('connected');s.end()});s.on('error',e=>{console.error(e.code,e.message);process.exitCode=4});`,
  );
  const control = spawn(process.execPath, [path.join(project, "network.mjs")]);
  const controlExit = await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.once("exit", resolve);
  });
  assert.equal(controlExit, 0);
  assert.equal(connections, 1);
  connections = 0;

  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai/compat");
  const packageInfo = JSON.parse(
    await readFile(
      new URL(
        "../../../node_modules/@earendil-works/pi-coding-agent/package.json",
        import.meta.url,
      ),
    ),
  );
  assert.equal(packageInfo.version, "1.1.0");
  const cliToolList = path.join(root, "cli-tools.json");
  const probe = path.join(root, "probe.mjs");
  await writeFile(
    probe,
    `import {writeFileSync} from 'node:fs'; export default pi => pi.on('session_start', () => writeFileSync(${JSON.stringify(cliToolList)}, JSON.stringify(pi.getActiveTools())));`,
  );
  const cli = fileURLToPath(
    new URL(
      "../../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      import.meta.url,
    ),
  );
  const cliRun = spawnSync(
    process.execPath,
    [
      cli,
      "--offline",
      "--no-builtin-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--print",
      "--extension",
      probe,
      "hello",
    ],
    { cwd: project, env: process.env, encoding: "utf8", timeout: 8000 },
  );
  assert.equal(cliRun.error, undefined, cliRun.error?.message);
  assert.deepEqual(
    JSON.parse(await readFile(cliToolList, "utf8")),
    [],
    `CLI tools; stderr=${cliRun.stderr}`,
  );
  let calls = [
    { name: "bash", arguments: { command: "cat input.txt" } },
    { name: "bash", arguments: { command: "touch marker.txt" } },
    { name: "bash", arguments: { command: "cat secret.txt" } },
    { name: "bash", arguments: { command: "node outside.mjs" } },
    { name: "bash", arguments: { command: "node network.mjs" } },
    { name: "read", arguments: { path: "input.txt" } },
    { name: "write", arguments: { path: "forbidden.txt", content: "bad" } },
    {
      name: "edit",
      arguments: { path: "input.txt", edits: [{ oldText: "hello", newText: "bad" }] },
    },
    { name: "ls", arguments: { path: "." } },
    { name: "find", arguments: { pattern: "*" } },
    { name: "grep", arguments: { pattern: "hello" } },
  ];
  let index = 0;
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "pi-security-scripted",
    provider: "local-script",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const streamSimple = () => {
    const stream = ai.createAssistantMessageEventStream();
    const next = calls[index++];
    const content = next
      ? [{ type: "toolCall", id: `script-${index}`, ...next }]
      : [{ type: "text", text: "done" }];
    const stopReason = next ? "toolUse" : "stop";
    const message = {
      role: "assistant",
      content,
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
      stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
    });
    return stream;
  };
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "scripted-test-only",
    baseUrl: model.baseUrl,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text"],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
    streamSimple,
  });
  const extensionPath = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await sdk.createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory(),
    sessionManager: sdk.SessionManager.inMemory(),
    noTools: "builtin",
    model,
    thinkingLevel: "off",
  });
  session = created.session;
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  assert.deepEqual(extensionErrors, []);
  const all = session.getAllTools();
  assert.deepEqual(
    ["bash", "edit", "find", "grep", "ls", "read", "write"],
    all
      .filter((t) => ["bash", "edit", "find", "grep", "ls", "read", "write"].includes(t.name))
      .map((t) => t.name)
      .sort(),
  );
  assert.ok(all.find((t) => t.name === "bash").sourceInfo.path.endsWith("/src/extension.ts"));
  assert.deepEqual(session.getActiveToolNames().sort(), [
    "background_process",
    "bash",
    "edit",
    "read",
    "write",
  ]);
  session.setActiveToolsByName(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const results = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end")
      results.push({ call: calls[results.length], result: event.result, isError: event.isError });
  });
  await session.prompt("Run the scripted checks.");
  assert.equal(index, 12, `provider calls ${index}`);
  assert.equal(results.length, 11, JSON.stringify(results));
  assert.match(JSON.stringify(results[0]), /hello-read/);
  assert.equal(await readFile(path.join(project, "marker.txt"), "utf8"), "");
  assert.match(JSON.stringify(results[2]), /deny-cat-secret/);
  await assert.rejects(access(path.join(outside, "marker")));
  assert.match(JSON.stringify(results[3]), /Operation not permitted|EPERM|permission denied/i);
  assert.match(JSON.stringify(results[4]), /Operation not permitted|EPERM|permission denied/i);
  assert.equal(connections, 0);
  for (const row of results.slice(5)) assert.match(JSON.stringify(row), /classifier unavailable/);
  await assert.rejects(access(path.join(project, "forbidden.txt")));
  assert.equal(await readFile(path.join(project, "input.txt"), "utf8"), "hello-read");
  const goodRows = results.map((r, i) => ({
    call: calls[i],
    result: JSON.stringify(r.result).slice(0, 500),
    isError: r.isError,
  }));
  session.dispose();
  session = undefined;
  const invalidPolicyCases = [];
  for (const [label, content, expected] of [
    ["missing", null, /ENOENT/],
    ["malformed", "{", /JSON|property name|Unexpected/],
    ["unknown-key", JSON.stringify({ ...policy(), unexpected: true }), /unknown key unexpected/],
  ]) {
    if (content === null) await unlink(policyFile);
    else await writeFile(policyFile, content);
    calls = [{ name: "bash", arguments: { command: "cat input.txt" } }];
    index = 0;
    const invalidLoader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await invalidLoader.reload();
    assert.deepEqual(invalidLoader.getExtensions().errors, []);
    const invalid = await sdk.createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime,
      resourceLoader: invalidLoader,
      settingsManager: sdk.SettingsManager.inMemory(),
      sessionManager: sdk.SessionManager.inMemory(),
      noTools: "builtin",
      model,
      thinkingLevel: "off",
    });
    session = invalid.session;
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    assert.deepEqual(extensionErrors, []);
    const invalidResults = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") invalidResults.push(event.result);
    });
    await session.prompt("Try one read.");
    assert.equal(invalidResults.length, 1);
    assert.match(JSON.stringify(invalidResults), expected);
    assert.doesNotMatch(JSON.stringify(invalidResults), /hello-read|stale/);
    invalidPolicyCases.push(label);
    session.dispose();
    session = undefined;
  }
  console.log(
    JSON.stringify({
      piVersion: packageInfo.version,
      extensionLoaded: true,
      cliNoSecurityEffectTools: true,
      providerCalls: goodRows.length + 1,
      rows: goodRows,
      invalidPolicyBlocked: true,
      invalidPolicyCases,
      outsideMarker: false,
      sandboxedConnections: connections,
    }),
  );
} finally {
  session?.dispose();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(prior.cwd);
  process.env = prior.env;
  await rm(root, { recursive: true, force: true });
}
