import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { policy } from "./skeleton/fixture.mjs";
// Question: does stock codemode gate mapped MCP and launch confined background work?
// Fields: piVersion, native nested ids/parents, fixture executions, background completion, EPERM.
// Done: mapped fixture executes once, denied fixtures never execute, scoped job completes, outside job refuses.
// Excludes real MCP transport/auth confinement.
const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-stock-b-"));
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
      new URL("./../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
  ).version;
  assert.equal(version, "1.1.0");
  const p = policy();
  p.resources.network = ["fixture.example"];
  p.allow.push(
    { id: "codemode-wrapper", tool: "codemode" },
    { id: "fixture-mcp", tool: "mcp__fixture__echo" },
    { id: "outside-mcp", tool: "mcp__outside__echo" },
    { id: "unknown-mcp", tool: "mcp__unknown__echo" },
    { id: "background-control", tool: "background_process" },
    { id: "fixture-tick", tool: "fixture_tick" },
  );
  p.deny.push(
    { id: "denied-mcp-name", tool: "mcp__fixture__denied" },
    { id: "deny-rm", tool: "bash", match: { program: "rm" } },
  );
  const policyFile = path.join(agentDir, "policy.json");
  await writeFile(policyFile, JSON.stringify(p));
  process.env.PI_SECURITY_POLICY = policyFile;
  await writeFile(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { url: "https://fixture.example/mcp" },
        outside: { url: "https://outside.example/mcp" },
      },
    }),
  );
  const executions = { allowed: 0, nameDenied: 0, hostDenied: 0, unknown: 0 };
  const nativeCalls = [];
  const fixture = (pi) => {
    pi.registerTool({
      name: "fixture_tick",
      label: "Fixture tick",
      description: "Yield fixture event loop briefly",
      parameters: { type: "object", properties: {} },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { content: [{ type: "text", text: "tick" }] };
      },
    });
    pi.on("tool_call", (event) => {
      nativeCalls.push({
        id: event.toolCallId,
        parent: event.parentToolCallId,
        tool: event.toolName,
      });
    });
    for (const [name, namespace, counter] of [
      ["mcp__fixture__echo", "mcp__fixture", "allowed"],
      ["mcp__fixture__denied", "mcp__fixture", "nameDenied"],
      ["mcp__outside__echo", "mcp__outside", "hostDenied"],
      ["mcp__unknown__echo", "mcp__unknown", "unknown"],
    ])
      pi.registerTool({
        name,
        label: name,
        description: "Registered mapped MCP fixture; no transport",
        namespace: { name: namespace },
        exposure: "direct",
        parameters: { type: "object", properties: {} },
        async execute() {
          executions[counter]++;
          return { content: [{ type: "text", text: "fixture-ok" }] };
        },
      });
  };
  const outside = path.join(root, "outside-marker");
  const code = `const parse=x=>typeof x==='string'?JSON.parse(x):x; const j=parse(await tools.bash({command:'touch inside-marker',background:true})); let status; for(let i=0;i<200;i++){status=parse(await tools.background_process({id:j.id,action:'status'}));if(status.state==='done')break;await tools.fixture_tick({});} text({job:j.id,status,output:parse(await tools.background_process({id:j.id,action:'read'}))}); text(await tools.mcp__fixture__echo({})); for(const name of ['mcp__fixture__denied','mcp__outside__echo','mcp__unknown__echo']) {try{await tools[name]({});text({unexpected:name});}catch(e){text({denied:name,error:String(e)});}} try{await tools.bash({command:'rm denied-marker'});text('unexpected-rm');}catch(e){text({denied:'rm',error:String(e)});} const bad=parse(await tools.bash({command:${JSON.stringify("touch '" + outside + "'")},background:true})); for(let i=0;i<200;i++){status=parse(await tools.background_process({id:bad.id,action:'status'}));if(status.state==='done')break;await tools.fixture_tick({});} text({outsideJob:bad.id,status,output:parse(await tools.background_process({id:bad.id,action:'read'}))});`;
  const calls = [{ name: "codemode", arguments: { code } }];
  let index = 0;
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "pi-b-script",
    provider: "local-b",
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
          ? [{ type: "toolCall", id: "b-" + index, ...next }]
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
  await writeFile(path.join(project, "denied-marker"), "safe");
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    additionalExtensionPaths: [
      process.argv.includes("--extension")
        ? process.argv[process.argv.indexOf("--extension") + 1]
        : fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
    ],
    extensionFactories: [sdk.createCodemodeExtension({ models: false }), fixture],
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
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  session.setActiveToolsByName([
    "bash",
    "background_process",
    "codemode",
    "mcp__fixture__echo",
    "mcp__fixture__denied",
    "mcp__outside__echo",
    "mcp__unknown__echo",
    "fixture_tick",
  ]);
  const rows = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") rows.push(e);
  });
  await session.prompt("Run scripted B checks", { source: "interactive" });
  const wrapper = rows.find((r) => r.toolName === "codemode");
  assert.ok(wrapper);
  assert.equal(wrapper.isError, false, JSON.stringify(wrapper.result));
  assert.deepEqual(executions, { allowed: 1, nameDenied: 0, hostDenied: 0, unknown: 0 });
  assert.equal(await readFile(path.join(project, "inside-marker"), "utf8"), "");
  assert.equal(await readFile(path.join(project, "denied-marker"), "utf8"), "safe");
  await assert.rejects(readFile(outside), { code: "ENOENT" });
  const output = JSON.stringify(wrapper.result);
  assert.match(output, /Operation not permitted|Permission denied/);
  assert.doesNotMatch(output, /unexpected/);
  assert.match(output, /done/);
  const latestJobs = new Map();
  for (const row of rows.filter((r) => r.toolName === "background_process" && !r.isError)) {
    const value = JSON.parse(row.result.content[0].text);
    if (value.state) latestJobs.set(value.id, value);
  }
  assert.equal(latestJobs.size, 2);
  assert.ok([...latestJobs.values()].every((j) => j.state === "done"));
  assert.deepEqual([...latestJobs.values()].map((j) => j.exitCode).sort(), [0, 1]);
  const nested = rows.filter((r) => r.toolCallId.includes("/"));
  assert.ok(nested.length >= 8);
  const parents = nativeCalls.filter((r) => r.parent);
  assert.ok(parents.length > 0);
  assert.ok(parents.every((r) => r.parent === "b-1"));
  console.log(
    JSON.stringify({
      fixture: root,
      piVersion: version,
      productionExtension: true,
      actualCodemode: true,
      mcpTransport: "simulated registered tool with genuine namespace metadata",
      allowedHost: "fixture.example",
      executions,
      nestedIds: nested
        .filter((r) => r.toolName !== "background_process" && r.toolName !== "fixture_tick")
        .map((r) => ({ id: r.toolCallId, tool: r.toolName, isError: r.isError })),
      parentIds: [...new Set(parents.map((r) => r.parent))],
      insideJobComplete: true,
      outsideBackgroundEPERM: true,
      deniedMarkerUnchanged: true,
      jobs: [...latestJobs.values()],
      backgroundOutput: rows
        .filter((r) => r.toolName === "background_process" && !r.isError)
        .map((r) => JSON.parse(r.result.content[0].text))
        .filter((r) => r.stderr !== undefined),
    }),
  );
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  session = undefined;
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  process.chdir(saved.cwd);
  process.env = saved.env;
  await rm(root, { recursive: true, force: true });
}
