// Question: do the independently packaged extensions preserve the stock host boundary?
// Fields: responders/readiness, tool ownership, inside/outside writes and real RPC ask frames.
// Done: isolated stock 1.1.0 loads all paths and the assertions pass.
// Excludes Linux containment, model quality, runtime bundle/release closure.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { policy } from "./skeleton/fixture.mjs";
const source = fileURLToPath(new URL("..", import.meta.url));
const packages = path.resolve(process.env.PI_PACKAGES_DIR || path.join(source, ".."));
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-i-"));
const saved = { env: { ...process.env }, cwd: process.cwd() };
let session;
const results = { piVersion: "1.1.0" };
try {
  const home = path.join(root, "home"),
    agentDir = path.join(root, "agent"),
    project = path.join(root, "project"),
    tmp = path.join(root, "tmp");
  await Promise.all(
    [home, agentDir, project, tmp, path.join(agentDir, "agents")].map((p) =>
      mkdir(p, { recursive: true, mode: 0o700 }),
    ),
  );
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TMPDIR: tmp + "/",
    PI_SECURITY_TMP: tmp,
    PI_SECURITY_POLICY: path.join(agentDir, "policy.json"),
    PI_SECURITY_MCP: path.join(agentDir, "fixture-mcp.json"),
    XDG_CACHE_HOME: path.join(tmp, "cache"),
    npm_config_cache: path.join(tmp, "npm"),
  });
  process.chdir(project);
  const p = policy();
  p.mode = "manual";
  p.allow.push(
    { id: "goal-read", tool: "get_goal", permissions: { write: false, network: [] } },
    { id: "write", tool: "write" },
    { id: "read", tool: "read" },
    { id: "background", tool: "background_process" },
    { id: "subagent", tool: "subagent" },
    {
      id: "printf",
      tool: "bash",
      match: { program: "printf" },
      permissions: { write: true, network: [] },
    },
  );
  await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(p));
  await writeFile(process.env.PI_SECURITY_MCP, '{"servers":{}}');
  await writeFile(
    path.join(agentDir, "agents", "fixture.md"),
    "---\nname: fixture\ndescription: fixture\n---\nRun the fixture.",
  );
  const sdk = await import("@earendil-works/pi-coding-agent"),
    ai = await import("@earendil-works/pi-ai/compat");
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "i-fixture",
    provider: "i-local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const provider = path.join(root, "child-provider.mjs");
  await writeFile(
    provider,
    `import {createAssistantMessageEventStream} from ${JSON.stringify(pathToFileURL(path.join(source, "../../node_modules/@earendil-works/pi-ai/dist/compat.js")).href)};export default function(pi){let i=0;const model=${JSON.stringify(model)};const calls=[{name:'write',arguments:{path:'own.txt',content:'child'}},{name:'bash',arguments:{command:'echo child-unmatched'}}];pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:()=>{const s=createAssistantMessageEventStream(),next=calls[i++],reason=next?'toolUse':'stop',m={role:'assistant',content:next?[{type:'toolCall',id:'i-child-'+i,...next}]:[{type:'text',text:'child done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{...model.cost,total:0}},stopReason:reason,timestamp:Date.now()};queueMicrotask(()=>{s.push({type:'start',partial:m});s.push({type:'done',reason,message:m});s.end();});return s;}});}`,
  );
  let calls = [],
    index = 0,
    asks = 0,
    preparedChild,
    finnPi;
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: () => {
      const s = ai.createAssistantMessageEventStream(),
        next = calls[index++],
        reason = next ? "toolUse" : "stop",
        m = {
          role: "assistant",
          content: next
            ? [{ type: "toolCall", id: "i-parent-" + index, ...next }]
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
        s.push({ type: "start", partial: m });
        s.push({ type: "done", reason, message: m });
        s.end();
      });
      return s;
    },
  });
  async function open(paths, { builtin = false, factories = [] } = {}) {
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const loader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      additionalExtensionPaths: paths,
      extensionFactories: factories,
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
        ...(builtin ? {} : { noTools: "builtin" }),
        model,
        thinkingLevel: "off",
      })
    ).session;
    return loader;
  }
  async function bind() {
    await session.bindExtensions({
      onError: (e) => {
        throw Error(JSON.stringify(e));
      },
      uiContext: {
        select: async () => {
          asks++;
          return "Allow";
        },
        notify() {},
        setStatus() {},
        theme: { fg: (_c, text) => text, bold: (text) => text },
      },
    });
  }
  async function close() {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    session = undefined;
  }
  // Standalone entrypoints own the transport; fixture installs only scripted child provider.
  process.env.PI_SECURITY_ACTIVATION = "active";
  process.env.PI_SECURITY_PLACEMENT = "host";
  process.env.PI_SECURITY_TRANSPORT = "extensions";
  process.env.PI_SECURITY_CHILD_FIXTURE_EXTENSION = provider;
  const intercept = path.join(root, "intercept.mjs");
  await writeFile(
    intercept,
    `export default function(pi){pi.events.on('pi-security:service:v1',r=>{const respond=r.respond;r.respond=s=>{const prepare=s.prepareChildLaunch;s.prepareChildLaunch=async spec=>{const child=await prepare(spec);globalThis.__iPrepared=child;return child;};respond(s);};});}`,
  );
  await open(
    [
      intercept,
      path.join(source, "src/extension.ts"),
      path.join(packages, "pi-background/extensions/background-process.ts"),
      path.join(packages, "pi-delegation/extensions/subagent.ts"),
      path.join(packages, "pi-goal/extensions/goal.ts"),
      path.join(packages, "pi-context/extensions/context.ts"),
    ],
    {
      factories: [
        (pi) => {
          finnPi = pi;
        },
      ],
    },
  );
  await bind();
  const toolResults = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") toolResults.push(e);
  });
  const outside = path.join(root, "outside");
  await writeFile(outside, "unchanged");
  calls = [
    {
      name: "bash",
      arguments: {
        command: "printf allowed > inside; printf bad > " + JSON.stringify(outside),
        background: true,
      },
    },
    { name: "subagent", arguments: { agent: "fixture", task: "Run scripted child" } },
    { name: "get_goal", arguments: {} },
  ];
  index = 0;
  session.setActiveToolsByName(["read", "write", "bash", "subagent", "get_goal"]);
  await session.prompt("Allow fixture tools", { source: "interactive" });
  assert.equal(toolResults.length, 3);
  assert.ok(
    toolResults.every((r) => !r.isError),
    JSON.stringify(toolResults),
  );
  assert.ok(session.getAllTools().some((t) => t.name === "get_goal"));
  assert.ok(session.getAllTools().some((t) => t.name === "subagent_check"));
  assert.ok(session.getAllTools().some((t) => t.name === "background_process"));
  // Find background ID using result details and wait by canary; session output is bounded transport evidence.
  for (let i = 0; i < 200; i++) {
    try {
      if (
        (await readFile(path.join(project, "inside"), "utf8")) === "allowed" &&
        globalThis.__iPrepared &&
        (await readFile(path.join(globalThis.__iPrepared.tmp, "own.txt"), "utf8")) === "child" &&
        asks >= 1
      )
        break;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(await readFile(path.join(project, "inside"), "utf8"), "allowed");
  assert.equal(await readFile(outside, "utf8"), "unchanged");
  let bg;
  finnPi.events.emit("background:service", {
    respond: (s) => {
      bg = s;
    },
  });
  const bgId = toolResults[0].result.details.id;
  for (let i = 0; i < 200 && !bg.status(bgId).executionExited; i++)
    await new Promise((r) => setTimeout(r, 10));
  const bgOutput = bg
    .read(bgId, 0, 10000)
    .chunks.map((c) => c.data.toString())
    .join("");
  assert.match(bgOutput, /Operation not permitted/);
  results.backgroundStderr = bgOutput.trim();
  assert.equal(await readFile(path.join(globalThis.__iPrepared.tmp, "own.txt"), "utf8"), "child");
  assert.ok(asks >= 1);
  results.packages = {
    entrypoints: true,
    insideWrite: true,
    outsideUnchanged: true,
    realRpcChild: true,
    parentAskCount: asks,
  };
  await close();
  console.log(JSON.stringify(results));
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  }
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
