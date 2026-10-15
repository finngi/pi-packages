// Runs the independently packaged extensions together with real stock-Pi RPC children.
// Provider responses and search HTTP are scripted; no account or installed config is used.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { policy } from "./skeleton/fixture.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const packages = path.resolve(process.env.PI_PACKAGES_DIR || path.join(source, ".."));
const packagedRoot = process.env.PI_PACKAGED_ROOT;
const codingAgentEntrypoint = packagedRoot
  ? path.join(packagedRoot, "@earendil-works/pi-coding-agent/dist/index.js")
  : undefined;
const aiCompatEntrypoint = packagedRoot
  ? path.join(packagedRoot, "@earendil-works/pi-ai/dist/compat.js")
  : undefined;
const childAiCompatEntrypoint =
  aiCompatEntrypoint ??
  path.join(source, "../../node_modules/@earendil-works/pi-ai/dist/compat.js");
const extensionPath = (name, sourcePath, builtPath) =>
  packagedRoot ? path.join(packagedRoot, name, builtPath) : path.join(packages, name, sourcePath);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-extensions-e2e-")));
const saved = { env: { ...process.env }, cwd: process.cwd() };
let session;
const metrics = { stockPi: "1.1.0", scriptedProvider: true, scriptedSearchHttp: true };
const put = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
const until = async (check, label) => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("Timed out: " + label);
};

try {
  const home = path.join(root, "home"),
    agentDir = path.join(root, "agent");
  const project = path.join(root, "project"),
    tmp = path.join(root, "tmp");
  await Promise.all(
    [home, agentDir, project, tmp].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TMPDIR: tmp + "/",
    PI_SECURITY_TMP: tmp,
    PI_SECURITY_POLICY: path.join(agentDir, "policy.json"),
    PI_SECURITY_MCP: path.join(agentDir, "fixture-mcp.json"),
    PI_SECURITY_ACTIVATION: "active",
    PI_SECURITY_PLACEMENT: "host",
    PI_SECURITY_TRANSPORT: "extensions",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(tmp, "cache"),
    npm_config_cache: path.join(tmp, "npm"),
  });
  delete process.env.PI_SUBAGENT;
  delete process.env.PI_POLICY_LAUNCH;
  process.chdir(project);
  const p = policy();
  p.mode = "manual";
  p.resources.network = ["chatgpt.com"];
  for (const tool of [
    "write",
    "read",
    "background_process",
    "subagent",
    "agent_message",
    "agent_list",
    "subagent_check",
    "subagent_message",
    "subagent_cancel",
    "subagent_close",
    "create_goal",
    "wait_for_goal_event",
    "get_goal",
  ]) {
    p.allow.push({
      id: "fixture-" + tool,
      tool,
      permissions: { write: tool !== "get_goal", network: [] },
    });
  }
  p.allow.push({
    id: "fixture-printf",
    tool: "bash",
    match: { program: "printf" },
    permissions: { write: true, network: [] },
  });
  p.allow.push({
    id: "fixture-search",
    tool: "codex_search",
    permissions: { write: false, network: ["chatgpt.com"] },
  });
  await put(process.env.PI_SECURITY_POLICY, JSON.stringify(p));
  await put(process.env.PI_SECURITY_MCP, '{"servers":{}}');
  await put(
    path.join(agentDir, "AGENTS.md"),
    "---\nnotes: GLOBAL_METADATA_SENTINEL\n---\nGLOBAL_BODY_SENTINEL\n",
  );
  await put(
    path.join(project, "AGENTS.md"),
    "---\nnotes: TEAM_METADATA_SENTINEL\n---\nTEAM_BODY_SENTINEL\n",
  );
  await put(
    path.join(project, "AGENTS.local.md"),
    "---\nnotes: LOCAL_METADATA_SENTINEL\n---\n<!-- PRESERVED_BODY_COMMENT -->\nLOCAL_BODY_SENTINEL\n",
  );
  await put(
    path.join(project, ".agents/instructions/a.md"),
    "---\nnotes: SELECTED_METADATA_SENTINEL\n---\nSELECTED_BODY_SENTINEL\n",
  );
  await put(
    path.join(agentDir, "skills/selected/SKILL.md"),
    "---\nname: selected\ndescription: Selected fixture skill\n---\nSELECTED_SKILL_BODY\n",
  );
  await put(
    path.join(agentDir, "skills/other/SKILL.md"),
    "---\nname: other\ndescription: Other fixture skill\n---\nOTHER_SKILL_BODY\n",
  );
  await put(
    path.join(agentDir, "agents/fixture.md"),
    "---\nname: fixture\ndescription: Global fixture\n---\nGLOBAL_AGENT_SHADOWED\n",
  );
  await put(
    path.join(project, ".pi/agents/fixture.md"),
    [
      "---",
      "name: fixture",
      "description: Local fixture",
      "model: e2e-local/scripted",
      "thinking: high",
      "tools: [read, write, bash]",
      "skills: [selected]",
      "permissionMode: manual",
      "conversation: 1",
      "notes: AGENT_METADATA_SENTINEL",
      "targets: [pi]",
      "---",
      "LOCAL_AGENT_INSTRUCTIONS_SENTINEL",
    ].join("\n"),
  );

  const sdk = codingAgentEntrypoint
    ? await import(pathToFileURL(codingAgentEntrypoint))
    : await import("@earendil-works/pi-coding-agent");
  const ai = aiCompatEntrypoint
    ? await import(pathToFileURL(aiCompatEntrypoint))
    : await import("@earendil-works/pi-ai/compat");
  const { createCodexSearchExtension } = await import(
    pathToFileURL(
      extensionPath("pi-codex-search", "extensions/search.ts", "dist/extensions/search.js"),
    )
  );
  const { responsesFixture, streamFrom } = await import(
    pathToFileURL(path.join(packages, "pi-codex-search/tests/fixtures/responses-sse.ts"))
  );
  const model = {
    id: "scripted",
    name: "Scripted",
    api: "e2e-fixture",
    provider: "e2e-local",
    baseUrl: "http://invalid.local",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 512,
  };
  const childProvider = path.join(root, "child-provider.mjs");
  await put(
    childProvider,
    `import {createAssistantMessageEventStream} from ${JSON.stringify(pathToFileURL(childAiCompatEntrypoint).href)};
export default function(pi) {
 let i=0;
 const model=${JSON.stringify(model)};
 const calls=[{name:'write',arguments:{path:'own.txt',content:'child'}},{name:'bash',arguments:{command:'echo child-needs-parent-approval'}}];
 pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx,options)=>{
  const stream=createAssistantMessageEventStream(),next=calls[i++];
  const evidence={systemPrompt:JSON.stringify(ctx.messages.filter(x=>x.role==='system')),tools:ctx.messages.filter(x=>x.role==='system').flatMap(x=>x.toolsAdded??[]).map(t=>t.name),messages:ctx.messages,thinking:pi.getThinkingLevel(),model:m.id};
  const reason=next?'toolUse':'stop';
  const message={role:'assistant',content:next?[{type:'toolCall',id:'e2e-child-'+i,...next}]:[{type:'text',text:JSON.stringify(evidence)}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{...model.cost,total:0}},stopReason:reason,timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason,message});stream.end();});return stream;
 }});
}`,
  );
  if (packagedRoot) {
    const childProviderSource = await readFile(childProvider, "utf8");
    assert.ok(
      childProviderSource.includes(pathToFileURL(aiCompatEntrypoint).href),
      "packaged child provider must import pi-ai from the temporary consumer installation",
    );
  }
  process.env.PI_SECURITY_CHILD_FIXTURE_EXTENSION = childProvider;
  const token =
    "header." +
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
    ).toString("base64url") +
    ".signature";
  const runtime = await sdk.ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read(provider) {
        return provider === "openai-codex"
          ? { type: "oauth", access: token, refresh: "fixture", expires: Date.now() + 3_600_000 }
          : undefined;
      },
      async list() {
        return [{ providerId: "openai-codex", type: "oauth" }];
      },
      async modify(provider, update) {
        return update(await this.read(provider));
      },
      async delete() {},
    },
  });
  let steps = [],
    index = 0,
    parentCalls = 0,
    parentPrompt,
    api,
    prepared,
    asks = 0;
  const toolResults = [];
  const latest = (name) =>
    [...toolResults].reverse().find((result) => result.toolName === name)?.result;
  const customEntries = (type) =>
    session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === type);
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: (_model, context) => {
      assert(++parentCalls < 60, "Automatic goal continuation is bounded in this fixture");
      parentPrompt = JSON.stringify(
        context.messages.filter((message) => message.role === "system"),
      );
      const step = steps[index++];
      const next = typeof step === "function" ? step() : step;
      const stream = ai.createAssistantMessageEventStream(),
        reason = next ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: "e2e-parent-" + parentCalls, ...next }]
          : [{ type: "text", text: "fixture idle" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
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
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message });
        stream.end();
      });
      return stream;
    },
  });
  const evaluatorModel = {
    ...model,
    id: "evaluator",
    provider: "e2e-evaluator",
    api: "e2e-evaluator",
    reasoning: false,
  };
  const evaluatorContexts = [];
  runtime.registerProvider(evaluatorModel.provider, {
    api: evaluatorModel.api,
    apiKey: "fixture-evaluator",
    baseUrl: evaluatorModel.baseUrl,
    models: [evaluatorModel],
    streamSimple(requested, context, options) {
      assert.equal(
        options.apiKey,
        "fixture-evaluator",
        "evaluator uses stock runtime authentication",
      );
      evaluatorContexts.push(structuredClone(context));
      const initial = context.messages.find((message) => message.role === "user");
      const goal = JSON.parse(String(initial.content)).goal;
      const verdict = evaluatorContexts.length === 1 ? "incomplete" : "finished";
      const message = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "e2e-evaluation-" + evaluatorContexts.length,
            name: "report_goal_evaluation",
            arguments: {
              verdict,
              reason:
                verdict === "finished"
                  ? "Fixture evidence verified"
                  : "Inspect delegated result and remaining evidence",
              blockerKey: null,
              requirements: goal.criteria.map((criterion) => ({
                criterionId: criterion.id,
                evidence: "Observed extension execution output",
                verdict: verdict === "finished" ? "met" : "unmet",
              })),
            },
          },
        ],
        api: requested.api,
        provider: requested.provider,
        model: requested.id,
        usage: {
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 8,
          cost: { ...model.cost, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    },
  });
  const urls = [];
  const search = createCodexSearchExtension({
    fetchImpl: async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("chatgpt-account-id"), "fixture-account");
      if (url.includes("/models"))
        return Response.json({ models: [{ slug: "fixture-codex", is_default: true }] });
      return new Response(streamFrom([new TextEncoder().encode(responsesFixture)]), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const intercept = path.join(root, "intercept.mjs");
  await put(
    intercept,
    `export default function(pi){pi.events.on('pi-security:service:v1',r=>{const respond=r.respond;r.respond=s=>{const prepare=s.prepareChildLaunch;s.prepareChildLaunch=async spec=>{const launch=await prepare(spec);globalThis.__e2ePrepared=launch;return launch;};respond(s);};});}`,
  );
  new sdk.ProjectTrustStore(agentDir).set(project, true);
  const settings = sdk.SettingsManager.create(project, agentDir, { projectTrusted: true });
  settings.setCompactionEnabled(false);
  const securityEntrypoint = packagedRoot
    ? path.join(packagedRoot, "pi-security/dist/src/extension.js")
    : path.join(source, "src/extension.ts");
  const backgroundEntrypoint = extensionPath(
    "pi-background",
    "extensions/background-process.ts",
    "dist/extensions/background-process.js",
  );
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager: settings,
    noPromptTemplates: true,
    additionalExtensionPaths: [
      intercept,
      securityEntrypoint,
      backgroundEntrypoint,
      extensionPath("pi-delegation", "extensions/subagent.ts", "dist/extensions/subagent.js"),
      extensionPath("pi-goal", "extensions/goal.ts", "dist/extensions/goal.js"),
      extensionPath("pi-context", "extensions/context.ts", "dist/extensions/context.js"),
    ],
    extensionFactories: [
      (pi) => {
        api = pi;
      },
      search,
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  api.events.emit("pi:human-input:v1", { version: 1, message: "UNINITIALIZED_INTENT" });
  loader
    .getExtensions()
    .runtime.flagValues.set(
      "goal-evaluator-model",
      `${evaluatorModel.provider}/${evaluatorModel.id}`,
    );
  ({ session } = await sdk.createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(project),
    noTools: "builtin",
    model,
    thinkingLevel: "high",
  }));
  await session.bindExtensions({
    onError: (error) => {
      throw Error(JSON.stringify(error));
    },
    uiContext: {
      select: async () => {
        asks++;
        return "Allow";
      },
      notify() {},
      setStatus() {},
      setWidget() {},
      theme: { fg: (_color, text) => text, bold: (text) => text },
    },
  });
  const commands = api.getCommands().map((command) => command.name);
  for (const name of ["agents", "skills", "skill:selected"])
    assert(commands.includes(name), "Registered command: " + name);
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") toolResults.push(event);
  });
  const call = (name, args) => ({ name, arguments: args });
  const prompt = async (text) => {
    let timer;
    try {
      await Promise.race([
        session.prompt(text, { source: "interactive" }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            session.abort();
            reject(Error("E2E prompt timed out"));
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const objective = "Run the isolated extension acceptance fixture";
  api.events.emit("pi:human-input:v1", {
    version: 1,
    sessionId: session.sessionManager.getSessionId(),
    message: objective,
  });
  api.events.emit("pi:human-input:v1", {
    version: 1,
    sessionId: "different-session",
    message: "WRONG_SESSION_INTENT",
  });
  process.env.PI_SUBAGENT = "1";
  api.events.emit("pi:human-input:v1", {
    version: 1,
    sessionId: session.sessionManager.getSessionId(),
    message: "CHILD_INTENT",
  });
  delete process.env.PI_SUBAGENT;
  api.events.emit("goal:create_authorization", { objective, budget: 1000 });
  const outside = path.join(root, "outside");
  await put(outside, "unchanged");
  steps = [
    call("create_goal", { objective, budget: 1000 }),
    call("bash", {
      command: "printf allowed > inside; printf bad > " + JSON.stringify(outside),
      background: true,
    }),
    call("codex_search", { queries: ["fixture search"] }),
    call("subagent", {
      agent: "fixture",
      task: "Execute fixture child task",
      model: "e2e-local/scripted:high",
    }),
    () => {
      const id = latest("subagent")?.details?.waitId;
      assert(id, "Subagent offers an acknowledged goal wait ID");
      return call("wait_for_goal_event", { id });
    },
    call("get_goal", {}),
    undefined, // First settled stop receives an independent incomplete assessment.
    undefined, // The next stop receives the evaluator's completed assessment.
  ];
  index = 0;
  session.setActiveToolsByName([
    "bash",
    "read",
    "write",
    "subagent",
    "agent_message",
    "agent_list",
    "subagent_check",
    "subagent_message",
    "subagent_cancel",
    "subagent_close",
    "create_goal",
    "wait_for_goal_event",
    "get_goal",
    "codex_search",
  ]);
  await prompt("PARENT_CONVERSATION_SENTINEL: execute the fixture goal.");
  assert(
    toolResults.every((result) => !result.isError),
    JSON.stringify(toolResults),
  );
  assert.equal(await readFile(outside, "utf8"), "unchanged");
  await until(async () => {
    try {
      return (await readFile(path.join(project, "inside"), "utf8")) === "allowed";
    } catch {
      return false;
    }
  }, "background inside write");
  let background;
  api.events.emit("background:service", {
    respond: (service) => {
      background = service;
    },
  });
  const backgroundId = latest("bash").details.id;
  await until(async () => background.status(backgroundId).executionExited, "background shell exit");
  assert.match(
    background
      .read(backgroundId, 0, 10000)
      .chunks.map((chunk) => chunk.data.toString())
      .join(""),
    /Operation not permitted/,
  );
  prepared = globalThis.__e2ePrepared;
  assert(prepared);
  const launchManifest = JSON.parse(
    await readFile(JSON.parse(prepared.env.PI_POLICY_LAUNCH).path, "utf8"),
  );
  assert(launchManifest.child.authorization.userMessages.includes(objective));
  assert(!JSON.stringify(launchManifest.child.authorization).includes("WRONG_SESSION_INTENT"));
  assert(!JSON.stringify(launchManifest.child.authorization).includes("CHILD_INTENT"));
  assert(!JSON.stringify(launchManifest.child.authorization).includes("UNINITIALIZED_INTENT"));
  assert.equal(await readFile(path.join(prepared.tmp, "own.txt"), "utf8"), "child");
  assert(asks >= 1, "Real child unmatched call reaches parent resolver");
  const waited = latest("wait_for_goal_event");
  const reply = waited.details.result;
  const evidence = JSON.parse(reply.text);
  const childShellResults = evidence.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "bash",
  );
  assert.equal(childShellResults.length, 1);
  assert.equal(childShellResults[0].isError, false, JSON.stringify(childShellResults));
  assert.match(JSON.stringify(childShellResults[0].content), /child-needs-parent-approval/);
  assert(
    prepared.argv.includes(
      await realpath(
        extensionPath(
          "pi-background",
          "extensions/background-process.ts",
          "dist/extensions/background-process.js",
        ),
      ),
    ),
    "secured child loads the parent's actual process transport extension",
  );
  assert(evidence.systemPrompt.includes("LOCAL_AGENT_INSTRUCTIONS_SENTINEL"));
  assert(!evidence.systemPrompt.includes("AGENT_METADATA_SENTINEL"));
  assert(!evidence.systemPrompt.includes("GLOBAL_AGENT_SHADOWED"));
  assert(evidence.systemPrompt.includes("Selected fixture skill"));
  assert(!evidence.systemPrompt.includes("Other fixture skill"));
  assert.deepEqual([...evidence.tools].sort(), [
    "agent_list",
    "agent_message",
    "bash",
    "read",
    "write",
  ]);
  assert(evidence.systemPrompt.includes("<agent_id>"));
  assert(evidence.systemPrompt.includes("<parent_id>"));
  assert(evidence.systemPrompt.includes("Write implementation artifacts only in your workspace"));
  assert(parentPrompt.includes("workspace; other paths require approval"));
  assert(parentPrompt.includes("<available_agents>"));
  assert(JSON.stringify(evidence.messages).includes("PARENT_CONVERSATION_SENTINEL"));
  assert.equal(evidence.model, "scripted");
  assert.equal(evidence.thinking, "high");
  assert.equal(toolResults.filter((result) => result.toolName === "wait_for_goal_event").length, 1);
  assert.equal(
    customEntries("subagent-dialogue-reply").length,
    0,
    "Owned response has no duplicate standalone notification",
  );
  assert(customEntries("pi-goal.continue").length > 0, "Goal supplies automatic continuation");
  for (const marker of [
    "GLOBAL_BODY_SENTINEL",
    "TEAM_BODY_SENTINEL",
    "LOCAL_BODY_SENTINEL",
    "SELECTED_BODY_SENTINEL",
    "<!-- PRESERVED_BODY_COMMENT -->",
  ])
    assert(parentPrompt.includes(marker), marker);
  const positions = [
    "GLOBAL_BODY_SENTINEL",
    "TEAM_BODY_SENTINEL",
    "LOCAL_BODY_SENTINEL",
    "SELECTED_BODY_SENTINEL",
  ].map((marker) => parentPrompt.indexOf(marker));
  assert(
    positions.every((position, i) => i === 0 || position > positions[i - 1]),
    "Context ordering preserves global, team, local, selected instructions",
  );
  for (const marker of [
    "GLOBAL_METADATA_SENTINEL",
    "TEAM_METADATA_SENTINEL",
    "LOCAL_METADATA_SENTINEL",
    "SELECTED_METADATA_SENTINEL",
  ])
    assert(!parentPrompt.includes(marker), marker);
  assert(urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/codex/models")));
  assert(urls.includes("https://chatgpt.com/backend-api/codex/responses"));
  assert(JSON.stringify(latest("codex_search")).includes("https://example.com/source"));
  const goalEntry = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-goal.state")
    .at(-1);
  assert.equal(goalEntry.data.state.status, "completed");
  assert.equal(
    evaluatorContexts.length,
    2,
    "incomplete and finished assessments control continuation",
  );
  assert.deepEqual(
    evaluatorContexts[1].messages.slice(0, evaluatorContexts[0].messages.length),
    evaluatorContexts[0].messages,
    "evaluator history preserves the unchanged initial prefix",
  );
  assert.ok(
    !session.getAllTools().some((tool) => tool.name === "update_goal"),
    "worker has no goal assessment tool",
  );
  const workerId = latest("subagent").details.id;
  steps = [
    call("agent_message", { to: workerId, message: "FOLLOW_UP_SENTINEL", mode: "followUp" }),
  ];
  index = 0;
  await prompt("Send a follow-up to the existing fixture child.");
  await until(
    async () => customEntries("subagent-dialogue-reply").length > 0,
    "unowned follow-up delivery",
  );
  assert.equal(customEntries("subagent-dialogue-reply").length, 1);
  await until(async () => !session.isStreaming, "parent follow-up turn settles");
  steps = [call("subagent_check", { id: workerId })];
  index = 0;
  await prompt("Inspect the existing child history.");
  const replySequences = new Set();
  let page = latest("subagent_check").details;
  for (let pages = 0; ; pages++) {
    for (const reply of page.replies) replySequences.add(reply.sequence);
    if (!page.hasMore) break;
    assert(pages < 32, "Reply paging progresses within the fixture bound");
    const cursor =
      page.nextReplySequence === undefined
        ? { after: page.nextAfter }
        : { replySequence: page.nextReplySequence, textOffset: page.nextTextOffset };
    steps = [call("subagent_check", { id: workerId, ...cursor })];
    index = 0;
    await prompt("Continue reading the child history page.");
    page = latest("subagent_check").details;
  }
  assert.deepEqual(
    [...replySequences],
    [1, 2],
    "Both retained replies are readable through bounded pages",
  );
  steps = [call("subagent_close", { id: workerId })];
  index = 0;
  await prompt("Close the existing child.");
  await assert.rejects(access(prepared.tmp));
  steps = [
    call("subagent", { agent: "fixture", task: "Start the cancellation fixture" }),
    () => call("subagent_cancel", { id: latest("subagent").details.id }),
  ];
  index = 0;
  await prompt("Start and cancel another child.");
  await assert.rejects(access(globalThis.__e2ePrepared.tmp));
  assert(
    toolResults.every((result) => !result.isError),
    JSON.stringify(toolResults),
  );
  metrics.goal = {
    continuation: true,
    ownedWait: true,
    singleDelivery: true,
    completed: true,
    independentEvaluator: true,
    evaluatorAssessments: evaluatorContexts.length,
    stableEvaluatorPrefix: true,
  };
  metrics.child = {
    localDiscovery: true,
    actualInstructions: true,
    toolSubset: true,
    selectedSkill: true,
    conversation: true,
    followUp: true,
    cancellation: true,
    cleanedScope: true,
    parentAsk: asks,
  };
  metrics.context = { allEagerMetadataStripped: true, orderedBodiesRetained: true };
  metrics.background = { insideWrite: true, outsideUnchanged: true };
  metrics.search = { runtimeFixtureAuth: true, fixedOriginRequests: urls.length, citations: true };
  if (packagedRoot) {
    metrics.packagedEntrypoints = {
      security: securityEntrypoint,
      background: backgroundEntrypoint,
    };
    metrics.packagedHostEntrypoints = {
      codingAgent: codingAgentEntrypoint,
      aiCompat: aiCompatEntrypoint,
    };
  }
  console.log(JSON.stringify(metrics));
} finally {
  if (session) {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  }
  process.chdir(saved.cwd);
  process.env = saved.env;
  delete globalThis.__e2ePrepared;
  await rm(root, { recursive: true, force: true });
}
