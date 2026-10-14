// Question: can stock RPC children retain narrowed authority and forward a real unmatched ask?
// Fields: RPC UI frames, resolver count, successful tools, kernel EPERM, cleanup and widening.
// Done: real parent SDK launches real stock CLI, asks return upward, refusals reproduce.
// Excludes provider quality, dead-pid scavenging.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { policy } from "./skeleton/fixture.mjs";
const source = fileURLToPath(new URL("..", import.meta.url));
const src = (name) => pathToFileURL(path.join(source, "src", name + ".ts")).href;
const [
  { loadPolicy },
  { createTempScope },
  { createChildLauncher },
  { createFileClient },
  { compileProfile },
  { wrapShell },
] = await Promise.all(
  ["policy", "temp-scope", "child-launch", "file-client", "profiles", "wrap-shell"].map(
    (x) => import(src(x)),
  ),
);
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-u-stock-"));
const saved = { cwd: process.cwd(), env: { ...process.env } };
let session, scope, launcher, child, ro, rw;
try {
  const home = path.join(root, "home"),
    agentDir = path.join(root, "agent"),
    project = path.join(root, "project");
  await Promise.all([home, agentDir, project].map((x) => mkdir(x, { mode: 0o700 })));
  scope = await createTempScope({ base: path.join(root, "base") });
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SECURITY_TMP: scope.tmp,
    TMPDIR: scope.tmp + "/",
    npm_config_cache: path.join(scope.tmp, "npm"),
  });
  process.chdir(project);
  const policyPath = path.join(agentDir, "policy.json");
  const p = policy();
  p.mode = "auto";
  p.allow.push(
    { id: "file-write", tool: "write" },
    { id: "file-read", tool: "read" },
    { id: "child", tool: "subagent" },
  );
  await writeFile(policyPath, JSON.stringify(p));
  process.env.PI_SECURITY_POLICY = policyPath;
  const sdk = await import("@earendil-works/pi-coding-agent"),
    ai = await import("@earendil-works/pi-ai/compat");
  const cli = fileURLToPath(
    new URL(
      "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      pathToFileURL(source + "/test/stock-pi-u.mjs"),
    ),
  );
  const extension = path.join(source, "src/extension.ts");
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "u-fixture",
    provider: "u-local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const fixtureProvider = path.join(root, "scripted-provider.mjs");
  await writeFile(
    fixtureProvider,
    `import {createAssistantMessageEventStream} from ${JSON.stringify(pathToFileURL(path.join(source, "../../node_modules/@earendil-works/pi-ai/dist/compat.js")).href)};
export default function(pi){let i=0;const model=${JSON.stringify(model)};const calls=[{name:'write',arguments:{path:'own.txt',content:'own-data'}},{name:'read',arguments:{path:'own.txt'}},{name:'bash',arguments:{command:'printf child-unmatched'}},{name:'bash',arguments:{command:'cat '+JSON.stringify(process.env.U_PARENT_FILE)+'; touch '+JSON.stringify(process.env.U_PARENT_MARKER)+'; printf bad > '+JSON.stringify(process.env.U_LAUNCH_FILE)}},{name:'read',arguments:{path:process.env.U_PARENT_FILE}},{name:'write',arguments:{path:process.env.U_PARENT_MARKER,content:'bad'}},{name:'write',arguments:{path:process.env.U_LAUNCH_FILE,content:'bad'}}];pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture-only',baseUrl:model.baseUrl,models:[model],streamSimple:()=>{const s=createAssistantMessageEventStream(),next=calls[i++],reason=next?'toolUse':'stop',m={role:'assistant',content:next?[{type:'toolCall',id:'u-child-'+i,...next}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{...model.cost,total:0}},stopReason:reason,timestamp:Date.now()};queueMicrotask(()=>{s.push({type:'start',partial:m});s.push({type:'done',reason,message:m});s.end();});return s;}});}`,
  );
  process.env.PI_SECURITY_CHILD_FIXTURE_EXTENSION = fixtureProvider;
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let index = 0;
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture-only",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: () => {
      const s = ai.createAssistantMessageEventStream(),
        next =
          index++ === 0 ? { name: "subagent", arguments: { task: "Run fixture child" } } : null,
        reason = next ? "toolUse" : "stop";
      const m = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: "u-parent", ...next }]
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
  const metrics = { rpcFrames: [], resolverCount: 0, childResults: [], cleanup: false };
  let prepared;
  const factory = (pi) =>
    pi.registerTool({
      name: "subagent",
      label: "Fixture child",
      description: "Run fixture child",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      execute: async () => {
        let service;
        pi.events.emit("pi-security:service:v1", {
          version: 1,
          respond: (value) => {
            service = value;
          },
        });
        assert.ok(service?.prepareChildLaunch, "service initialized");
        prepared = await service.prepareChildLaunch({
          task: "untrusted scripted child",
          permissionMode: "manual",
          allowIds: ["file-write", "file-read", "cat", "touch"],
          permissions: { write: true, network: false },
        });
        const rpcParentFile = path.join(scope.tmp, "parent-rpc-data"),
          rpcParentMarker = path.join(scope.tmp, "parent-rpc-marker"),
          rpcLaunchFile = JSON.parse(prepared.env.PI_POLICY_LAUNCH).path;
        await writeFile(rpcParentFile, "parent-rpc-unchanged");
        const rpcLaunchBytes = await readFile(rpcLaunchFile);
        Object.assign(prepared.env, {
          U_PARENT_FILE: rpcParentFile,
          U_PARENT_MARKER: rpcParentMarker,
          U_LAUNCH_FILE: rpcLaunchFile,
        });
        child = spawn(
          prepared.argv[0],
          [
            ...prepared.argv.slice(1),
            "-e",
            fixtureProvider,
            "--provider",
            model.provider,
            "--model",
            model.id,
            "--thinking",
            "off",
            "--no-session",
          ],
          { cwd: prepared.cwd, env: prepared.env, stdio: ["pipe", "pipe", "pipe"] },
        );
        let buffer = "",
          stderr = "";
        child.stderr.on("data", (b) => (stderr += b));
        let complete;
        const done = new Promise((resolve, reject) => {
          complete = resolve;
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) reject(Error("child startup/exit " + code + ": " + stderr));
          });
        });
        child.stdout.on("data", (b) => {
          buffer += b;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (frame.type === "extension_ui_request" && frame.method === "select") {
              metrics.rpcFrames.push({ id: frame.id, method: frame.method, title: frame.title });
              Promise.resolve(service.handleChildAsk(prepared.id, frame)).then((response) =>
                child.stdin.write(JSON.stringify(response) + "\n"),
              );
            }
            if (frame.type === "tool_execution_end") metrics.childResults.push(frame);
            if (frame.type === "agent_end") complete();
          }
        });
        child.stdin.write(
          JSON.stringify({ id: "fixture-prompt", type: "prompt", message: "Run child fixture" }) +
            "\n",
        );
        let timer;
        try {
          await Promise.race([
            done,
            new Promise(
              (_, reject) =>
                (timer = setTimeout(() => reject(Error("real CLI timeout: " + stderr)), 20000)),
            ),
          ]);
          assert.equal(await readFile(path.join(prepared.tmp, "own.txt"), "utf8"), "own-data");
        } finally {
          clearTimeout(timer);
          child.kill();
          await new Promise((r) =>
            child.once("close", (code, signal) => {
              metrics.childExit = { code, signal };
              r();
            }),
          );
          child = undefined;
        }
        assert.equal(metrics.childResults.length, 7);
        assert.ok(
          metrics.childResults.slice(0, 3).every((x) => !x.isError),
          JSON.stringify(metrics.childResults),
        );
        assert.match(JSON.stringify(metrics.childResults[3]), /Operation not permitted/);
        assert.ok(metrics.childResults.slice(4).every((x) => x.isError));
        assert.equal(await readFile(rpcParentFile, "utf8"), "parent-rpc-unchanged");
        await assert.rejects(access(rpcParentMarker));
        assert.deepEqual(await readFile(rpcLaunchFile), rpcLaunchBytes);
        assert.equal(metrics.rpcFrames.length, 2);
        await prepared.cleanup();
        await assert.rejects(access(prepared.tmp));
        metrics.cleanup = true;
        return { content: [{ type: "text", text: "child fixture completed" }] };
      },
    });
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    additionalExtensionPaths: [extension],
    extensionFactories: [factory],
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
  await session.bindExtensions({
    onError: (e) => {
      throw Error(JSON.stringify(e));
    },
    uiContext: {
      select: async () => {
        metrics.resolverCount++;
        return "Allow";
      },
      notify() {},
      setStatus() {},
    },
  });
  session.setActiveToolsByName(["read", "write", "bash", "subagent"]);
  const parentResults = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") parentResults.push(e);
  });
  await session.prompt("Allow the fixture child to run", { source: "interactive" });
  assert.equal(parentResults.length, 1);
  assert.equal(parentResults[0].isError, false, JSON.stringify(parentResults));
  assert.equal(metrics.resolverCount, 2);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  session = undefined;
  // Direct executor reproductions bypass the early gate and require live successful processes.
  await scope.close();
  scope = await createTempScope({ base: path.join(root, "kernel-base") });
  process.env.TMPDIR = scope.tmp + "/";
  const parent = await loadPolicy(policyPath, { project: scope.tmp, tmp: scope.tmp });
  parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
  launcher = createChildLauncher({
    parentLoaded: parent,
    tempScope: scope,
    extensionPath: extension,
    piCliPath: cli,
  });
  const launch = await launcher.prepareChildLaunch({
    task: "kernel fixture",
    permissions: { write: true, network: false },
  });
  const parentFile = path.join(scope.tmp, "parent-data"),
    parentMarker = path.join(scope.tmp, "forbidden-write"),
    launchFile = path.join(scope.launchDir, "protected-data");
  await writeFile(parentFile, "parent-unchanged");
  await writeFile(launchFile, "launch-unchanged");
  const wrapped = wrapShell(
    "printf own-shell > own-shell; cat " +
      JSON.stringify(parentFile) +
      "; touch " +
      JSON.stringify(parentMarker) +
      "; printf bad > " +
      JSON.stringify(launchFile),
    "build-test",
    launch.childLoaded,
    { policyPath, extensionPath: extension },
  );
  const profileFile = path.join(launch.tmp, "trial.sb");
  await writeFile(profileFile, wrapped.profile);
  const run = spawnSync("/usr/bin/sandbox-exec", ["-f", profileFile, ...wrapped.argv], {
    cwd: launch.tmp,
    env: wrapped.env,
    encoding: "utf8",
  });
  assert.equal(await readFile(path.join(launch.tmp, "own-shell"), "utf8"), "own-shell");
  assert.match(run.stderr, /Operation not permitted|Permission denied/i);
  await assert.rejects(access(parentMarker));
  assert.equal(await readFile(parentFile, "utf8"), "parent-unchanged");
  assert.equal(await readFile(launchFile, "utf8"), "launch-unchanged");
  rw = await createFileClient({
    loaded: launch.childLoaded,
    mode: "write",
    wrapShell,
    compileProfile,
    policyPath,
    extensionPath: extension,
  });
  await rw.request("writeFile", { path: path.join(launch.tmp, "helper-own"), content: "ok" });
  for (const [op, args] of [
    ["readFile", { path: parentFile }],
    ["writeFile", { path: parentMarker, content: "bad" }],
    ["writeFile", { path: launchFile, content: "bad" }],
  ])
    await assert.rejects(rw.request(op, args), { code: "EPERM" });
  await rw.close();
  rw = undefined;
  const grandchild = await scope.allocateChild(launch.tmp);
  await writeFile(path.join(grandchild, "marker"), "ok");
  await scope.removeChild(grandchild);
  await assert.rejects(access(grandchild));
  await assert.rejects(
    launcher.prepareChildLaunch({ task: "widen", writeAllow: [scope.tmp] }),
    /widened/,
  );
  const roLaunch = await launcher.prepareChildLaunch({
    task: "ro",
    permissions: { write: false, network: false },
  });
  await assert.rejects(
    createFileClient({
      loaded: roLaunch.childLoaded,
      mode: "write",
      wrapShell,
      compileProfile,
      policyPath,
      extensionPath: extension,
    }),
    /cap/i,
  );
  await launch.cleanup();
  await roLaunch.cleanup();
  await launcher.close();
  launcher = undefined;
  console.log(
    JSON.stringify({
      piVersion: "1.1.0",
      realRpcChild: true,
      ...metrics,
      kernel: {
        shellStartup: true,
        shellStderr: run.stderr.trim(),
        helperStarted: true,
        parentRead: "EPERM",
        parentWrite: "EPERM",
        launchWrite: "EPERM",
        parentUnchanged: true,
        launchUnchanged: true,
        grandchildRemoved: true,
        wideningRefused: true,
        readOnlyWriteHelperRefused: true,
      },
    }),
  );
} finally {
  child?.kill();
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  await ro?.close();
  await rw?.close();
  await launcher?.close();
  await scope?.close();
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
