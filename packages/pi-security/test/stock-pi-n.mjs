import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLab, cases } from "./fetch/lab.mjs";
import { policy } from "./skeleton/fixture.mjs";

// Tier 0: can stock 1.1.0 execute four real network clients through the fetch boundary?
// Fields: tool result exit, allowed destination, forbidden response, direct EPERM.
// Done: four successes, four proxy refusals, three kernel refusals in one agent loop.
// Default uses a temporary exact-command adapter; --integrated loads production gate.
const integrated = process.argv.includes("--integrated");
const lab = await createLab();
const prior = { cwd: process.cwd(), env: { ...process.env } };
const key = `piSecurityFetchTest${Date.now()}`;
let session;
try {
  process.chdir(lab.project);
  Object.assign(process.env, {
    HOME: lab.home,
    PI_CODING_AGENT_DIR: lab.agentDir,
    TMPDIR: lab.tmp + "/",
  });
  const calls = cases.flatMap((c) =>
    ["allow", "deny"].map((verdict) => ({
      command: c[verdict],
      host: c.host,
      permissions: { write: true, network: [[c.host]] },
      tool: c.name,
      verdict,
    })),
  );
  for (const cls of ["fetch", "read-only", "build-test"])
    calls.push({
      command: lab.directCommand,
      host: "example.com",
      permissions: {
        write: cls !== "read-only",
        network: cls === "fetch" ? [["example.com"]] : [],
      },
      tool: "direct",
      verdict: "deny",
    });
  const rows = [];
  globalThis[key] = async (command) => {
    const spec = calls.find((c) => c.command === command && !c.consumed);
    if (!spec) throw Error("adapter command refused");
    spec.consumed = true;
    const row = await lab.execute(spec.command, spec.host, spec.permissions);
    rows.push({ tool: spec.tool, verdict: spec.verdict, host: spec.host, ...row });
    return { content: [{ type: "text", text: JSON.stringify(row) }], details: row };
  };
  let extension = path.join(lab.root, "adapter.mjs");
  await writeFile(
    extension,
    `export default pi=>pi.registerTool({name:'bash',label:'Fixture fetch bash',description:'Runs exact synthetic fixture calls through fetch boundary',parameters:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false},execute:async(_id,input)=>globalThis[${JSON.stringify(key)}](input.command)});`,
  );
  if (integrated) {
    const fixturePolicy = policy();
    fixturePolicy.deny = [];
    fixturePolicy.allow = [];
    fixturePolicy.resources.network = cases.map((c) => c.host);
    const clientEnv = {
      npm_config_globalconfig: path.join(lab.tmp, "npm-global-config"),
      GOMODCACHE: path.join(lab.tmp, "go-mod-cache"),
      GOTOOLCHAIN: "local",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const [i, call] of calls.entries()) {
      const fixture = path.join(lab.project, `fixture-${i}.mjs`);
      const source =
        call.tool === "direct"
          ? await readFile(path.join(lab.project, "direct.mjs"), "utf8")
          : `import {spawnSync} from 'node:child_process'; const r=spawnSync('/bin/bash',['--noprofile','--norc','-c',${JSON.stringify(call.command)}],{env:{...process.env,...${JSON.stringify(clientEnv)}},encoding:'utf8',timeout:30000});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error)console.error(r.error.message);process.exitCode=r.status??1;`;
      await writeFile(fixture, source);
      call.command = `node ${fixture}`;
      fixturePolicy.allow.push({
        id: `fixture-${i}`,
        tool: "bash",
        match: { program: "node", "args-contain": fixture },
        permissions: { write: call.permissions.write, network: call.permissions.network.flat() },
      });
    }
    const policyPath = path.join(lab.agentDir, "policy.json");
    await writeFile(policyPath, JSON.stringify(fixturePolicy));
    Object.assign(process.env, { PI_SECURITY_POLICY: policyPath, PI_SECURITY_TMP: lab.tmp });
    extension = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai/compat");
  // Dependencies resolve from the parent repository rather than a private install in this worktree.
  const pkg = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
      ),
      "utf8",
    ),
  );
  assert.equal(pkg.version, "1.1.0");
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "pi-security-n-script",
    provider: "local-n",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  let index = 0;
  const streamSimple = () => {
    const stream = ai.createAssistantMessageEventStream();
    const next = calls[index++];
    const stopReason = next ? "toolUse" : "stop";
    const content = next
      ? [{ type: "toolCall", id: `n-${index}`, name: "bash", arguments: { command: next.command } }]
      : [{ type: "text", text: "done" }];
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
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "scripted-only",
    baseUrl: model.baseUrl,
    models: [{ ...model }],
    streamSimple,
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: lab.project,
    agentDir: lab.agentDir,
    additionalExtensionPaths: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (
    await sdk.createAgentSession({
      cwd: lab.project,
      agentDir: lab.agentDir,
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
    onError: (error) => {
      throw Error(JSON.stringify(error));
    },
  });
  if (integrated)
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const spec = calls[rows.length];
        rows.push({
          tool: spec.tool,
          verdict: spec.verdict,
          host: spec.host,
          permissions: spec.permissions,
          exitCode: event.result.structuredContent?.exit_code,
          output:
            event.result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n") ?? JSON.stringify(event.result),
          isError: event.isError,
        });
      }
    });
  await session.prompt("Run the synthetic fetch fixtures.");
  assert.equal(rows.length, 11);
  for (const row of rows) {
    if (row.verdict === "allow") assert.equal(row.exitCode, 0, row.output);
    else {
      assert.notEqual(row.exitCode, 0);
      assert.match(
        row.output,
        row.tool === "direct" ? /EPERM|Operation not permitted/ : /403|Forbidden/,
      );
    }
  }
  assert.equal(lab.connectionCount(), 0);
  console.log(
    JSON.stringify({
      piVersion: pkg.version,
      adapter: integrated
        ? "production extension gate + binding + fetch executor"
        : "exact-command temporary bash extension; root gate wiring pending",
      rows,
      directConnections: lab.connectionCount(),
    }),
  );
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  delete globalThis[key];
  process.chdir(prior.cwd);
  process.env = prior.env;
  await lab.close();
}
