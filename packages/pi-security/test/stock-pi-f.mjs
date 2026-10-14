// Question: can stock Pi 1.1.0 execute seven bound, confined tools in one real session?
// Compared fields: content/details shapes, edit diff/patch, helper EPERM and unchanged targets.
// Done when one scripted provider loop returns seven successful representative results.
// Does not check classifier, general command grammar, or production extension wiring.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture, verify } from "./files/kernel.mjs";
const f = await fixture();
const oldCwd = process.cwd();
let session;
try {
  process.chdir(f.project);
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const integrated = process.argv.includes("--integrated");
  if (integrated) {
    const p = JSON.parse(await readFile(f.policyPath, "utf8"));
    p.allow.push(
      ...["read", "write", "edit", "ls", "find", "grep"].map((tool) => ({
        id: "file-" + tool,
        tool,
      })),
    );
    await writeFile(f.policyPath, JSON.stringify(p));
    Object.assign(process.env, { PI_SECURITY_POLICY: f.policyPath, PI_SECURITY_TMP: f.tmp });
  }
  const adapter = path.join(f.root, "adapter.mjs");
  await writeFile(
    adapter,
    `
import {createBashToolDefinition} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
import {createFileClient} from ${JSON.stringify(pathToFileURL(path.join(src, "file-client.ts")).href)};
import {createFileToolDefinitions} from ${JSON.stringify(pathToFileURL(path.join(src, "file-tools.ts")).href)};
import {wrapShell,shellOperations} from ${JSON.stringify(pathToFileURL(path.join(src, "wrap-shell.ts")).href)};
import {compileProfile} from ${JSON.stringify(pathToFileURL(path.join(src, "profiles.ts")).href)};
import {loadPolicy} from ${JSON.stringify(pathToFileURL(path.join(src, "policy.ts")).href)};
import {Bindings,decide} from ${JSON.stringify(pathToFileURL(path.join(src, "gate.ts")).href)};
export default async pi=>{
 const loaded=await loadPolicy(${JSON.stringify(f.policyPath)},{project:${JSON.stringify(f.project)},tmp:${JSON.stringify(f.tmp)}}), bindings=new Bindings(), clients=new Map();
 const clientForPermissions=async c=>{if(!['read-only','build-test','fetch'].includes(c))throw Error('invalid class'); const mode=c==='read-only'?'read-only':'write'; if(!clients.has(mode))clients.set(mode,createFileClient({loaded,mode,wrapShell,compileProfile,policyPath:${JSON.stringify(f.policyPath)},extensionPath:${JSON.stringify(src)}})); return clients.get(mode);};
 const defs=createFileToolDefinitions({cwd:loaded.project,clientForPermissions}); defs.bash=createBashToolDefinition(loaded.project,{operations:shellOperations(loaded,'read-only')});
 for(const [name,def] of Object.entries(defs))pi.registerTool({...def,async execute(id,input,signal,update,ctx){const b=bindings.take(id,name,input);return def.execute(id,input,signal,update,{...ctx,securityPermissions:b.decision.permissions});}});
 pi.on('tool_call',e=>{const d=e.toolName==='bash'?decide(e.toolName,e.input,loaded):{verdict:'allow',class:['write','edit'].includes(e.toolName)?'build-test':'read-only',ruleIds:['synthetic-file-rule']};if(d.verdict!=='allow')return {block:true,reason:d.reason};bindings.put(e.toolCallId,e.toolName,e.input,d);});
 pi.on('session_shutdown',async()=>{for(const c of clients.values())await(await c).close();});
};
`,
  );
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai/compat");
  const version = JSON.parse(
    await readFile(
      new URL(
        "../../../node_modules/@earendil-works/pi-coding-agent/package.json",
        import.meta.url,
      ),
    ),
  ).version;
  assert.equal(version, "1.1.0");
  const calls = [
    { name: "read", arguments: { path: "input.txt" } },
    { name: "write", arguments: { path: "created.txt", content: "hello world\n" } },
    {
      name: "edit",
      arguments: { path: "created.txt", edits: [{ oldText: "world", newText: "stock" }] },
    },
    { name: "ls", arguments: { path: "." } },
    { name: "find", arguments: { pattern: "*.txt" } },
    { name: "grep", arguments: { pattern: "stock", path: "created.txt" } },
    { name: "bash", arguments: { command: "cat created.txt" } },
    ...(integrated
      ? [{ name: "write", arguments: { path: "escape", content: "should-not-escape" } }]
      : []),
    { name: "read", arguments: { path: "created.txt", offset: 205 } },
  ];
  let index = 0;
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "pi-f-scripted",
    provider: "local-f",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const streamSimple = () => {
    const stream = ai.createAssistantMessageEventStream(),
      next = calls[index++],
      stopReason = next ? "toolUse" : "stop";
    const message = {
      role: "assistant",
      content: next
        ? [{ type: "toolCall", id: "f-" + index, ...next }]
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
    apiKey: "synthetic-only",
    baseUrl: model.baseUrl,
    models: [{ ...model }],
    streamSimple,
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: f.project,
    agentDir: f.agentDir,
    additionalExtensionPaths: integrated ? [path.join(src, "extension.ts")] : [adapter],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: f.project,
    agentDir: f.agentDir,
    modelRuntime,
    resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory(),
    sessionManager: sdk.SessionManager.inMemory(),
    noTools: "builtin",
    model,
    thinkingLevel: "off",
  }));
  const errors = [];
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  session.setActiveToolsByName(calls.map((c) => c.name));
  const results = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_end")
      results.push({ tool: calls[results.length].name, isError: e.isError, result: e.result });
  });
  await session.prompt("Run synthetic file checks.");
  assert.equal(results.length, integrated ? 9 : 8);
  const invalidRead = results.at(-1);
  assert.equal(invalidRead.isError, true);
  assert.match(invalidRead.result.content[0].text, /Offset 205 is beyond end of file/);
  assert.doesNotMatch(invalidRead.result.content[0].text, /pi-security:/);
  for (const r of results.slice(0, 7)) {
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.ok(Array.isArray(r.result.content));
    assert.equal(r.result.content[0].type, "text");
  }
  assert.match(results[0].result.content[0].text, /hello/);
  assert.match(results[1].result.content[0].text, /Successfully wrote/);
  assert.ok(results[2].result.details.diff);
  assert.ok(results[2].result.details.patch);
  assert.equal(results[2].result.details.firstChangedLine, 1);
  assert.match(results[3].result.content[0].text, /created.txt/);
  assert.match(results[4].result.content[0].text, /created.txt/);
  assert.equal(results[5].result.content[0].text, "created.txt:1: hello stock");
  assert.equal(results[6].result.content[0].text, "hello stock\n");
  if (integrated) {
    assert.equal(results[7].isError, true);
    assert.match(JSON.stringify(results[7]), /EPERM|not permitted/);
    assert.equal(await readFile(path.join(f.outside, "target.txt"), "utf8"), "unchanged");
  }
  const kernel = await verify(f);
  console.log(
    JSON.stringify({
      piVersion: version,
      integrated,
      adapter: integrated ? "production extension" : "temporary adapter",
      rows: results,
      kernel,
    }),
  );
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
  session = undefined;
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  process.chdir(oldCwd);
  await f.close();
}
