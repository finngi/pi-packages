// Copied into each fresh consumer: every package import resolves from that install.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";

const [consumer, name] = process.argv.slice(2);
const agentDir = join(consumer, "agent"),
  cwd = join(consumer, "project");
await mkdir(agentDir);
await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT;
delete process.env.PI_SUBAGENT_CONTEXT;
if (["pi-contracts", "pi-runtime", "pi-resource-browser"].includes(name)) {
  const library = await import(name);
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: sdk.SettingsManager.inMemory(),
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(
    loader.getExtensions().extensions.length,
    0,
    "a library does not activate an extension",
  );
  if (name === "pi-contracts") {
    const bus = new EventEmitter();
    let received;
    bus.on(library.USAGE_EVENT, (value) => {
      received = value;
    });
    bus.emit("pi-runtime:usage:v1", { id: "contract-proof" });
    assert.deepEqual(received, { id: "contract-proof" });
    assert.equal(
      new Set(Object.values(library)).size,
      Object.keys(library).length,
      "event IDs are distinct",
    );
  } else if (name === "pi-resource-browser") {
    const { ResourceSearch } = await import("pi-resource-browser/search");
    const search = new ResourceSearch([
      { id: "review", name: "Reviewer", description: "Inspect evidence" },
      { id: "other", name: "Writer", description: "Draft text" },
    ]);
    assert.deepEqual(
      search.search("rev").map((entry) => entry.id),
      ["review"],
    );
  } else {
    assert.equal(
      library.totalTokens(
        library.addTokenUsage(
          { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
          { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 },
        ),
      ),
      11,
    );
    const processes = new library.BackgroundProcesses();
    try {
      const launched = processes.launch({
        command: process.execPath,
        args: ["-e", "process.stdout.write('PACKED_LIBRARY_PROCESS')"],
        cwd,
        owner: "packed-proof",
        label: "Library process",
      });
      assert.equal((await launched.done).status, "completed");
      assert.equal(
        processes
          .read(launched.id)
          .chunks.map((chunk) => chunk.data.toString())
          .join(""),
        "PACKED_LIBRARY_PROCESS",
      );
    } finally {
      await processes.close();
    }
  }
  console.log(`${name}: installed alone; library stock-Pi behaviour passed`);
  process.exit(0);
}
const put = async (path, text) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
};
const model = {
  id: "packed",
  name: "Packed fixture",
  api: "packed-fixture",
  provider: "packed-fixture",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};
const credentials = new InMemoryCredentialStore();
const runtime = await sdk.ModelRuntime.create({
  credentials,
  modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
let calls = [],
  index = 0;
const contexts = [],
  errors = [],
  results = [];
const output = (call) => {
  const reason = call ? "toolUse" : "stop";
  const message = {
    role: "assistant",
    content: call
      ? [{ type: "toolCall", id: `packed-${index}`, ...call }]
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
      cost: { ...model.cost, total: 0 },
    },
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
    stream.end();
  });
  return stream;
};
runtime.registerProvider(model.provider, {
  api: model.api,
  apiKey: "fixture",
  baseUrl: model.baseUrl,
  models: [model],
  streamSimple(_model, context) {
    contexts.push(structuredClone(context));
    const call = calls[index++];
    return output(typeof call === "function" ? call(context) : call);
  },
});
const packagePath = join(consumer, "node_modules", name);
new sdk.ProjectTrustStore(agentDir).set(cwd, true);
const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
if (name === "pi-context") {
  await put(join(cwd, "AGENTS.local.md"), "PACKED_LOCAL_CONTEXT");
  await put(join(cwd, ".agents/instructions/proof.md"), "# Proof\nPACKED_SELECTED_INSTRUCTION");
}
if (name === "pi-resources") {
  await put(
    join(agentDir, "skills/proof/SKILL.md"),
    "---\nname: proof\ndescription: PACKED_SKILL_DESCRIPTION\n---\nPACKED_LAZY_BODY",
  );
}
if (name === "pi-permissions") {
  await put(join(cwd, "input.txt"), "stock read works");
  await put(
    join(agentDir, "permissions.json"),
    JSON.stringify({
      mode: "auto",
      classifier: { model: "fixture/unavailable" },
      deny: [{ tool: "write" }],
      allow: [{ tool: "read" }],
    }),
  );
}
if (name === "pi-delegation") {
  await put(
    join(cwd, ".pi/agents/worker.md"),
    "---\nname: worker\ndescription: Installed child proof\ntools: [bash]\n---\nRun the deterministic child fixture.",
  );
  const provider = join(consumer, "child-provider.mjs");
  await writeFile(
    provider,
    `
    import {createAssistantMessageEventStream} from "@earendil-works/pi-ai/compat";
    export default function(pi) {
      const model=${JSON.stringify(model)}; let index=0;
      pi.registerProvider(model.provider,{api:model.api,apiKey:"fixture",baseUrl:model.baseUrl,models:[model],streamSimple(){
        const call=index++===0 ? {type:"toolCall",id:"child-proof",name:"bash",arguments:{command:"printf PACKED_CHILD_EXECUTED > child-proof.txt"}} : {type:"text",text:"PACKED_CHILD_DONE"};
        const reason=call.type==="toolCall" ? "toolUse" : "stop";
        const message={role:"assistant",content:[call],api:model.api,provider:model.provider,model:model.id,stopReason:reason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{...model.cost,total:0}}};
        const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason,message});stream.end();});return stream;
      }});
    }
  `,
  );
  process.env.PI_SUBAGENT_PROVIDER_EXTENSION = provider;
}
if (name === "pi-codex-search") {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_packed" } })).toString("base64url")}.signature`;
  const auth = { type: "oauth", access: token, refresh: "fixture", expires: Date.now() + 3600000 };
  await credentials.modify("openai-codex", () => auth);
  await put(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": auth }));
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    models: [
      { ...model, provider: "openai-codex", api: "openai-codex-responses", id: "packed-search" },
    ],
  });
  const sse = await readFile(join(consumer, "responses-sse.txt"), "utf8");
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input),
      headers = new Headers(init?.headers);
    assert(url.startsWith("https://chatgpt.com/backend-api/codex/"));
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("chatgpt-account-id"), "acct_packed");
    requests.push(url);
    if (new URL(url).pathname.endsWith("/models"))
      return Response.json({ models: [{ slug: "packed-search", is_default: true }] });
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  };
  process.on("exit", () => assert(requests.some((url) => url.endsWith("/responses"))));
}
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  additionalExtensionPaths: [packagePath],
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.equal(
  loader.getExtensions().extensions.length,
  1,
  "only the selected package activates an extension",
);
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  settingsManager: settings,
  resourceLoader: loader,
  sessionManager: sdk.SessionManager.create(cwd, join(agentDir, "sessions")),
});
await session.bindExtensions({
  onError(error) {
    errors.push(error);
  },
});
session.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "toolResult")
    results.push(event.message);
});
const currentSystemPrompt = () => {
  const messages = contexts.at(-1).messages.filter((message) => message.role === "system");
  assert(messages.length > 0, "stock Pi supplies a normalized system transcript");
  const current = structuredClone(messages[0]);
  current.sections ??= {};
  for (const update of messages.slice(1)) Object.assign(current.sections, update.sections);
  return getSystemMessageText(current);
};
const run = async (next) => {
  calls = next;
  index = 0;
  results.length = 0;
  await session.prompt("Exercise the independently installed package.");
  assert.deepEqual(errors, []);
  assert(
    results.every((result) => !result.isError),
    JSON.stringify(results),
  );
};
try {
  if (name === "pi-background") {
    await run([
      {
        name: "bash",
        arguments: { command: "printf PACKED_BACKGROUND_OUTPUT; sleep 30", background: true },
      },
      () => ({ name: "bash", arguments: { command: "printf foreground" } }),
      () => ({
        name: "background_process",
        arguments: { action: "read", id: results[0].details.id },
      }),
      () => ({
        name: "background_process",
        arguments: { action: "cancel", id: results[0].details.id },
      }),
    ]);
    assert.equal(results[0].details.running, true);
    assert.match(JSON.stringify(results[2].content), /PACKED_BACKGROUND_OUTPUT/);
    assert.equal(results[3].details.status, "cancelled");
  } else if (name === "pi-delegation") {
    await run([
      {
        name: "subagent",
        arguments: { agent: "worker", task: "Write child-proof.txt", workspace: "project" },
      },
      {
        name: "bash",
        arguments: {
          command:
            "i=0; while [ ! -s child-proof.txt ]; do i=$((i+1)); [ $i -lt 200 ] || exit 1; sleep 0.05; done; cat child-proof.txt",
        },
      },
      () => ({ name: "subagent_close", arguments: { id: results[0].details.id } }),
    ]);
    assert.equal(await readFile(join(cwd, "child-proof.txt"), "utf8"), "PACKED_CHILD_EXECUTED");
    assert.equal(results[2].details.artifacts.scope, "project-reference");
  } else if (name === "pi-resources") {
    await run([{ name: "session_setup", arguments: { op: "apply", skills: [] } }]);
    assert.deepEqual(JSON.parse(results[0].content[0].text).selected.skills, []);
    await run([]);
    assert(!currentSystemPrompt().includes("PACKED_SKILL_DESCRIPTION"));
    await run([{ name: "session_setup", arguments: { op: "apply", skills: ["proof"] } }]);
    await run([]);
    assert.match(currentSystemPrompt(), /PACKED_SKILL_DESCRIPTION/);
    assert(!currentSystemPrompt().includes("PACKED_LAZY_BODY"));
  } else if (name === "pi-context") {
    await run([
      { name: "session_setup", arguments: { op: "list", kinds: ["instructions"] } },
      () => ({
        name: "session_setup",
        arguments: {
          op: "apply",
          instructions: [JSON.parse(results[0].content[0].text).candidates[0].id],
        },
      }),
    ]);
    await run([]);
    assert.match(currentSystemPrompt(), /PACKED_LOCAL_CONTEXT/);
    assert.match(currentSystemPrompt(), /PACKED_SELECTED_INSTRUCTION/);
    const help = join(packagePath, "skills/pi-help/scripts/paths.mjs");
    await access(help);
  } else if (name === "pi-goal") {
    // Native user commands create and pause a real session goal without a host shim.
    await session.prompt("/goal start Installed goal proof");
    await session.waitForIdle();
    await session.prompt("/goal pause");
    await session.waitForIdle();
    await run([{ name: "get_goal", arguments: {} }]);
    assert.equal(results[0].details.status, "paused");
    assert.match(results[0].content[0].text, /Installed goal proof/);
    await session.prompt("/goal clear");
    await run([{ name: "get_goal", arguments: {} }]);
    assert.deepEqual(results[0].details, {});
  } else if (name === "pi-codex-search") {
    await run([{ name: "codex_search", arguments: { queries: ["installed search proof"] } }]);
    assert.equal(results[0].details.successes[0].text, "Fixture answer with a source.");
    assert.equal(results[0].usage.totalTokens, 19);
  } else if (name === "pi-permissions") {
    calls = [
      { name: "read", arguments: { path: "input.txt" } },
      { name: "write", arguments: { path: "blocked.txt", content: "forbidden" } },
    ];
    index = 0;
    await session.prompt("Read input.txt; the fixture policy must block writing blocked.txt.");
    assert.match(JSON.stringify(results[0].content), /stock read works/);
    assert.match(JSON.stringify(results[1].content), /pi-permissions: deny rule/);
    await assert.rejects(access(join(cwd, "blocked.txt")), { code: "ENOENT" });
    assert.deepEqual(errors, []);
  } else throw Error(`Missing installed behaviour proof for ${name}`);
  console.log(`${name}: installed alone; native stock-Pi behaviour passed`);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
}
