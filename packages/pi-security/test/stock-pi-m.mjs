// Question: does stock pi load the WASM parser and gate compounds/nested denies?
// Compared fields: pi version, parser AST, decisions, actual tool outputs.
// Done when the parser loads in session_start and scripted calls allow/deny correctly.
// Does not check classifier, file helper, fetch or model reasoning.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-security-m-")));
const prior = { cwd: process.cwd(), env: { ...process.env } };
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
    TMPDIR: tmp + "/",
    npm_config_cache: path.join(tmp, "cache"),
  });
  process.chdir(project);
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
  const matcher = fileURLToPath(new URL("../src/matcher.ts", import.meta.url));
  const parserOnly = process.argv.includes("--parser-only");
  const integrated = process.argv.includes("--integrated");
  if (integrated) {
    const { policy } = await import("./skeleton/fixture.mjs");
    const p = policy();
    p.deny = [
      { id: "deny-nested", tool: "bash", match: { program: "touch", "args-contain": "forbidden" } },
    ];
    p.allow = ["echo", "cat", "touch", "bash"].map((program) => ({
      id: program,
      tool: "bash",
      class: program === "touch" ? "build-test" : "read-only",
      match: { program },
    }));
    const policyFile = path.join(agentDir, "policy.json");
    await writeFile(policyFile, JSON.stringify(p));
    Object.assign(process.env, { PI_SECURITY_POLICY: policyFile, PI_SECURITY_TMP: tmp });
  }
  const extension = path.join(root, "adapter.mjs");
  const resultFile = path.join(root, "parser.json");
  await writeFile(
    extension,
    `import {Parser,Language} from ${JSON.stringify(fileURLToPath(new URL("../../../node_modules/web-tree-sitter/tree-sitter.cjs", import.meta.url)))};
 import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
 ${parserOnly || integrated ? "" : `import {decideBash} from ${JSON.stringify(matcher)};import {Bindings} from ${JSON.stringify(fileURLToPath(new URL("../src/gate.ts", import.meta.url)))};import {shellOperations} from ${JSON.stringify(fileURLToPath(new URL("../src/wrap-shell.ts", import.meta.url)))};import {createBashToolDefinition} from ${JSON.stringify(fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)))};`}
 export default pi=>{pi.on('session_start',async()=>{await Parser.init();const p=new Parser();p.setLanguage(await Language.load(${JSON.stringify(fileURLToPath(new URL("../../../node_modules/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url)))}));writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({ast:p.parse('git status && npm test').rootNode.toString()}));});
 ${
   parserOnly || integrated
     ? ""
     : `const loaded=${JSON.stringify({
         project,
         tmp,
         filesystem: { readDeny: [], writeAllow: [project, tmp], writeDeny: [] },
         policy: {
           env: { assignAllow: [], path: [] },
           resources: { network: [] },
           deny: [
             {
               id: "deny-nested",
               tool: "bash",
               match: { program: "touch", "args-contain": "forbidden" },
             },
           ],
           allow: [
             {
               id: "echo",
               tool: "bash",
               permissions: { write: false, network: [] },
               match: { program: "echo" },
             },
             {
               id: "cat",
               tool: "bash",
               permissions: { write: false, network: [] },
               match: { program: "cat" },
             },
             {
               id: "touch",
               tool: "bash",
               permissions: { write: true, network: [] },
               match: { program: "touch" },
             },
             {
               id: "shell",
               tool: "bash",
               permissions: { write: false, network: [] },
               match: { program: "bash", subcommand: "-c" },
             },
           ],
         },
       })};const bindings=new Bindings();pi.on('tool_call',e=>{const d=decideBash(e.input.command,loaded);if(d.verdict!=='allow')return {block:true,reason:d.reason+' '+d.ruleIds.join(',')};bindings.put(e.toolCallId,'bash',e.input,d);});const base=createBashToolDefinition(${JSON.stringify(project)});pi.registerTool({...base,async execute(id,input,signal,onUpdate,ctx){const b=bindings.take(id,'bash',input);return createBashToolDefinition(${JSON.stringify(project)},{operations:shellOperations(loaded,b.decision.permissions,{extensionPath:${JSON.stringify(extension)}}),exposeSessionEnvironment:false}).execute(id,input,signal,onUpdate,ctx);}});`
 }}
 `,
  );
  const calls = parserOnly
    ? []
    : [
        { command: "echo parser-ok && touch marker && cat marker" },
        { command: "bash -c 'touch forbidden'" },
      ];
  let index = 0;
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "matcher-test",
    provider: "local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("local", {
    api: model.api,
    apiKey: "fixture",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: () => {
      const stream = ai.createAssistantMessageEventStream();
      const next = calls[index++];
      const message = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: "m-" + index, name: "bash", arguments: next }]
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
        stopReason: next ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    additionalExtensionPaths: integrated
      ? [fileURLToPath(new URL("../src/extension.ts", import.meta.url)), extension]
      : [extension],
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (
    await sdk.createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime,
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
  const rows = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_end") rows.push({ isError: e.isError, result: e.result });
  });
  await session.prompt("Run fixture");
  const parser = JSON.parse(await readFile(resultFile));
  assert.match(parser.ast, /list/);
  if (!parserOnly) {
    assert.equal(rows.length, 2);
    assert.match(JSON.stringify(rows[0]), /parser-ok/);
    assert.equal(await readFile(path.join(project, "marker"), "utf8"), "");
    assert.match(JSON.stringify(rows[1]), /deny-nested/);
    await assert.rejects(readFile(path.join(project, "forbidden")));
  }
  console.log(
    JSON.stringify({
      piVersion: version,
      parserLoaded: true,
      parserOnly,
      integrated,
      parser,
      rows,
    }),
  );
} finally {
  session?.dispose();
  process.chdir(prior.cwd);
  process.env = prior.env;
  await rm(root, { recursive: true, force: true });
}
