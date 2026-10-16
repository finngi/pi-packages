import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type SessionSetupService, sessionSetupService } from "pi-resources/session-setup";
import context from "../../../pi-context/extensions/context.ts";
import resources from "../../../pi-resources/extensions/resources.ts";
import subagents from "../../extensions/subagent.ts";

const system = (messages: any[]) => {
  const current = getCurrentSystemMessage(messages);
  return current ? getSystemMessageText(current) : "";
};

// Saved skill choices shared by both scenarios; only package availability differs.
const skillChoices = { "open-chosen": true, "off-chosen": true, "terminal-chosen": true };

async function runScenario(name: string, packageSettings: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), `pi-package-availability-${name}-`)),
    project = join(root, "project"),
    agentDir = join(root, "agent"),
    provider = join(root, "provider.mjs");
  const put = async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const skill = (id: string) =>
    `---\nname: ${id}\ndescription: ${id.toUpperCase().replaceAll("-", "_")}_DESCRIPTION\n---\nBODY`;
  const pack = async (id: string, skills: string[], extra: Record<string, string[]> = {}) => {
    const dir = join(root, id);
    await put(
      join(dir, "package.json"),
      JSON.stringify({ name: id, version: "1.0.0", pi: { skills: ["skills"], ...extra } }),
    );
    for (const skillName of skills)
      await put(join(dir, "skills", skillName, "SKILL.md"), skill(skillName));
    return dir;
  };
  const openPack = await pack("open-pack", ["open-default", "open-chosen"], {
    agents: ["agents"],
  });
  await put(
    join(openPack, "agents/pack-worker/pack-worker.md"),
    "---\nname: pack-worker\ndescription: Package worker\ntools: [read]\nconversation: none\n---\nPACK_WORKER",
  );
  const offPack = await pack("off-pack", ["off-chosen"]);
  const terminalPack = await pack("terminal-pack", ["terminal-chosen"]);
  await put(join(project, "AGENTS.local.md"), "LOCAL_CONTEXT_BODY");
  await put(join(agentDir, "skills/direct-native/SKILL.md"), skill("direct-native"));
  const agents = {
    wildcard: "",
    named: "skills: [open-default, off-chosen, terminal-chosen]\n",
  };
  for (const [agent, declaration] of Object.entries(agents))
    await put(
      join(agentDir, "agents", agent, `${agent}.md`),
      `---\nname: ${agent}\ndescription: Fixture ${agent}\ntools: [read]\nconversation: none\n${declaration}---\nBUNDLE_${agent}`,
    );
  await put(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [openPack, offPack, terminalPack],
      subagents: { skills: skillChoices },
      localContext: { autoGitIgnore: false, instructions: { "local:AGENTS.local.md": true } },
      ...packageSettings,
    }),
  );
  const model: any = {
    id: "availability-fixture",
    name: "Availability fixture",
    provider: "availability-fixture",
    api: "availability-fixture",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    contextWindow: 16384,
    maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  // Runs in the real child RPC process and records the skills its model is offered.
  await put(
    provider,
    `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAssistantMessageEventStream,getSystemMessageText} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
export default function(pi){const model=${JSON.stringify(model)}; pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx)=>{
const prompt=ctx.messages.filter(m=>m.role==='system').map(getSystemMessageText).join('\\n');
const name=JSON.stringify(ctx.messages).match(/capture:([a-z-]+)/)[1];
const skills=[...prompt.matchAll(/<skill>\\s*<name>([^<]+)<\\/name>/g)].map(m=>m[1]);
writeFileSync(join(${JSON.stringify(root)},name+'.json'),JSON.stringify({prompt,skills,pid:process.pid}));
const stream=createAssistantMessageEventStream(),message={role:'assistant',content:[{type:'text',text:'CHILD_CAPTURED'}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}});}`,
  );
  const saved = { ...process.env };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_PROVIDER_EXTENSION: provider,
  });
  delete process.env.PI_SUBAGENT;
  let session: sdk.AgentSession | undefined,
    setup: SessionSetupService | undefined,
    ctx: sdk.ExtensionContext | undefined;
  const parentPrompts: string[] = [],
    results: any[] = [],
    captures: Record<string, { prompt: string; skills: string[] }> = {},
    errors: string[] = [];
  const steps: any[] = [];
  for (const agent of Object.keys(agents))
    steps.push(
      {
        name: "subagent",
        arguments: { agent, task: `capture:${agent}`, workspace: "scratch" },
      },
      { name: "capture_child", arguments: { name: agent } },
      () => ({
        name: "subagent_close",
        arguments: {
          id: JSON.parse(
            results.filter((result) => result.toolName === "subagent").at(-1).content[0].text,
          ).agent_id,
        },
      }),
    );
  let step = 0;
  try {
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple: (_model: any, request: any) => {
        parentPrompts.push(system(request.messages));
        const next = steps[step++],
          call = typeof next === "function" ? next() : next;
        const stream = createAssistantMessageEventStream(),
          reason = call ? "toolUse" : "stop";
        const message: any = {
          role: "assistant",
          content: call
            ? [{ type: "toolCall", id: `parent-${step}`, ...call }]
            : [{ type: "text", text: "PARENT_DONE" }],
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
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason, message });
          stream.end();
        });
        return stream;
      },
    });
    const settings = sdk.SettingsManager.create(project, agentDir, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          path: "fixture:package-availability",
          factory(pi) {
            resources(pi);
            context(pi);
            subagents(pi);
            setup = sessionSetupService(pi.events);
            pi.on("session_start", (_event, current) => {
              ctx = current;
            });
            pi.registerTool({
              name: "capture_child",
              label: "Capture child",
              description: "Wait for the actual child model prompt",
              parameters: Type.Object({ name: Type.String() }),
              async execute(_id, args) {
                const file = join(root, `${args.name}.json`),
                  deadline = Date.now() + 20000;
                let text = "";
                while (
                  !(text = await readFile(file, "utf8").catch(() => "")) &&
                  Date.now() < deadline
                )
                  await new Promise((resolve) => setTimeout(resolve, 25));
                assert.ok(text, `Child ${args.name} did not reach its model provider`);
                captures[args.name] = JSON.parse(text);
                return { content: [{ type: "text", text: "Captured" }], details: {} };
              },
            });
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(project),
    }));
    // The parent is interactive; children are always headless.
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(`${error.event}: ${error.error}`),
    });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult")
        results.push(event.message);
    });
    const listed = setup!.execute({ op: "list", limit: 50 }, ctx!);
    await session.prompt("Delegate to each fixture agent.");
    return {
      listed,
      parentPrompt: parentPrompts[0] ?? "",
      launches: results.filter((result) => result.toolName === "subagent"),
      results,
      captures,
      errors,
    };
  } finally {
    if (session) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("stock children follow saved package availability as headless sessions", {
  timeout: 60000,
}, async () => {
  const run = await runScenario("valid", {
    resourcePackages: { "off-pack": false },
    resourceSessionTypes: { packages: { "terminal-pack": "interactive" } },
  });
  assert.deepEqual(run.errors, []);
  assert(
    run.results.every((result) => !result.isError),
    JSON.stringify(run.results),
  );
  // The interactive parent offers the interactive-only package; the off package stays hidden.
  assert.match(run.parentPrompt, /TERMINAL_CHOSEN_DESCRIPTION/);
  assert.doesNotMatch(run.parentPrompt, /OFF_CHOSEN_DESCRIPTION|OPEN_DEFAULT_DESCRIPTION/);
  // Off and interactive-only packages stay out; a package skill with no saved choice stays off.
  assert.deepEqual([...run.captures.wildcard!.skills].sort(), ["direct-native", "open-chosen"]);
  // Explicit names may choose available unselected skills, never ones from hidden packages.
  assert.deepEqual(run.captures.named!.skills, ["open-default"]);
  const named = JSON.stringify(run.launches[1]);
  assert.match(
    named,
    /Skill \\"off-chosen\\" is from package \\"off-pack\\", which is off, and was left out of the child/,
  );
  assert.match(
    named,
    /Skill \\"terminal-chosen\\" is from interactive-only package \\"terminal-pack\\" and was left out of the child/,
  );
});

test("stock malformed resourcePackages keeps agents, local context and child launches", {
  timeout: 60000,
}, async () => {
  const run = await runScenario("malformed", { resourcePackages: ["open-pack"] });
  assert.deepEqual(run.errors, []);
  assert(
    run.results.every((result) => !result.isError),
    JSON.stringify(run.results),
  );
  assert.equal(run.listed.error, undefined);
  assert.equal(run.listed.warnings?.length, 1);
  assert.match(run.listed.warnings![0]!, /packages defaults were ignored.*old list format/);
  assert.deepEqual(
    run.listed.candidates
      .filter((candidate) => candidate.kind === "agents")
      .map((candidate) => candidate.id)
      .sort(),
    ["named", "pack-worker", "wildcard"],
  );
  assert.deepEqual([...run.listed.selected.agents].sort(), ["named", "wildcard"]);
  assert.match(run.parentPrompt, /LOCAL_CONTEXT_BODY/);
  // Every package falls back to available, so saved skill choices apply as usual.
  assert.deepEqual([...run.captures.wildcard!.skills].sort(), [
    "direct-native",
    "off-chosen",
    "open-chosen",
    "terminal-chosen",
  ]);
  assert.match(run.captures.wildcard!.prompt, /LOCAL_CONTEXT_BODY/);
  assert.deepEqual([...run.captures.named!.skills].sort(), [
    "off-chosen",
    "open-default",
    "terminal-chosen",
  ]);
});
