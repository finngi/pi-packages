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
import context from "../../../pi-context/extensions/context.ts";
import { catalogueInstructionId } from "../../../pi-context/lib/instruction-selection.ts";
import resources from "../../../pi-resources/extensions/resources.ts";
import subagents from "../../extensions/subagent.ts";

const system = (messages: any[]) => {
  const current = getCurrentSystemMessage(messages);
  return current ? getSystemMessageText(current) : "";
};

test(
  "stock child prompts use saved resources independently of temporary parent selections",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-child-resource-scopes-")),
      project = join(root, "project"),
      agentDir = join(root, "agent"),
      pack = join(root, "guidance"),
      instructionDir = join(pack, "instructions"),
      provider = join(root, "provider.mjs");
    const put = async (file: string, text: string) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    const skill = (name: string, marker: string) =>
      `---\nname: ${name}\ndescription: ${marker}_DESCRIPTION\n---\n${marker}_BODY`;
    const scenarios = [
      {
        name: "omitted",
        declaration: "",
        expected: ["personal", "project", "collision", "native-winner", "private"],
      },
      {
        name: "star",
        declaration: "skills: '*'\n",
        expected: ["personal", "project", "collision", "native-winner", "private"],
      },
      {
        name: "star-list",
        declaration: "skills: ['*']\n",
        expected: ["personal", "project", "collision", "native-winner", "private"],
      },
      {
        name: "named",
        declaration: "skills: [explicit-only, collision, native-winner, missing]\n",
        expected: ["explicit-only", "collision", "native-winner"],
      },
      { name: "empty", declaration: "skills: []\n", expected: [] },
    ];
    await mkdir(project);
    await put(join(project, "AGENTS.md"), "PROJECT_STATIC_CONTEXT");
    await put(
      join(instructionDir, "personal.md"),
      "# Personal guidance\nSAVED_PERSONAL_INSTRUCTION",
    );
    await put(
      join(instructionDir, "temporary.md"),
      "# Temporary guidance\nTEMPORARY_PARENT_INSTRUCTION",
    );
    await put(
      join(project, ".agents/instructions/project.md"),
      "# Project guidance\nSAVED_PROJECT_INSTRUCTION",
    );
    await put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "fixture-guidance",
        pi: { extensions: [], skills: [], instructions: ["./instructions"] },
      }),
    );
    const personalInstruction = catalogueInstructionId(instructionDir, "personal.md"),
      temporaryInstruction = catalogueInstructionId(instructionDir, "temporary.md");
    const globalSettings = JSON.stringify({
      packages: [pack],
      subagents: {
        skills: {
          personal: true,
          project: false,
          temporary: false,
          collision: true,
          "native-winner": true,
          "explicit-only": false,
        },
      },
      localContext: {
        autoGitIgnore: false,
        instructions: { [personalInstruction]: true, [temporaryInstruction]: false },
      },
    });
    const projectSettings = JSON.stringify({
      subagents: { skills: { project: true } },
      localContext: { instructions: { "local:.agents/instructions/project.md": true } },
    });
    await put(join(agentDir, "settings.json"), globalSettings);
    await put(join(project, ".pi/settings.json"), projectSettings);
    for (const name of ["personal", "temporary", "collision", "native-winner", "explicit-only"])
      await put(
        join(agentDir, "skills", name, "SKILL.md"),
        skill(name, `USER_${name.toUpperCase().replaceAll("-", "_")}`),
      );
    await put(join(project, ".pi/skills/project/SKILL.md"), skill("project", "PROJECT"));
    await put(
      join(project, ".pi/skills/native-winner/SKILL.md"),
      skill("native-winner", "PROJECT_NATIVE_WINNER"),
    );
    for (const scenario of scenarios) {
      const bundle = join(agentDir, "agents", scenario.name);
      await put(
        join(bundle, `${scenario.name}.md`),
        `---\nname: ${scenario.name}\ndescription: Fixture child ${scenario.name}\ntools: [read]\nconversation: none\n${scenario.declaration}---\nBUNDLE_${scenario.name}_INSTRUCTION`,
      );
      await put(join(bundle, "skills/private/SKILL.md"), skill("private", "PRIVATE"));
      await put(join(bundle, "skills/collision/SKILL.md"), skill("collision", "BUNDLE_COLLISION"));
    }
    const model: any = {
      id: "scope-fixture",
      name: "Scope fixture",
      provider: "scope-fixture",
      api: "scope-fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      contextWindow: 16384,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    // This provider runs in the real child RPC process and records what its model receives.
    await put(
      provider,
      `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAssistantMessageEventStream,getSystemMessageText} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
export default function(pi){const model=${JSON.stringify(model)}; pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx)=>{
const prompt=ctx.messages.filter(m=>m.role==='system').map(getSystemMessageText).join('\\n');
const name=JSON.stringify(ctx.messages).match(/capture:([a-z-]+)/)[1];
const skills=[...prompt.matchAll(/<skill>\\s*<name>([^<]+)<\\/name>[\\s\\S]*?<location>([^<]+)<\\/location>[\\s\\S]*?<\\/skill>/g)].map(m=>({name:m[1],path:m[2],body:readFileSync(m[2],'utf8')}));
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
    let session: sdk.AgentSession | undefined;
    const parentPrompts: string[] = [],
      results: any[] = [],
      captures: any[] = [];
    const steps: any[] = [
      {
        name: "session_setup",
        arguments: { op: "apply", skills: ["temporary"], instructions: [temporaryInstruction] },
      },
    ];
    for (const scenario of scenarios)
      steps.push(
        {
          name: "subagent",
          arguments: {
            agent: scenario.name,
            task: `capture:${scenario.name}`,
            workspace: "scratch",
          },
        },
        { name: "capture_child", arguments: { name: scenario.name } },
        () => ({
          name: "subagent_close",
          arguments: {
            id: JSON.parse(
              results.filter((result) => result.toolName === "subagent").at(-1).content[0].text,
            ).agent_id,
          },
        }),
      );
    let step = 0,
      delegate = false;
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
        streamSimple: (_model: any, ctx: any) => {
          parentPrompts.push(system(ctx.messages));
          const next = delegate ? steps[step++] : step++ === 0 ? steps[0] : undefined,
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
        extensionFactories: [
          {
            path: "fixture:resource-scopes",
            factory(pi) {
              resources(pi);
              context(pi);
              subagents(pi);
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
                  captures.push(JSON.parse(text));
                  return {
                    content: [{ type: "text", text: "Captured child prompt" }],
                    details: {},
                  };
                },
              });
            },
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const nativeWinner = loader
        .getSkills()
        .skills.find((skill) => skill.name === "native-winner")!;
      assert.ok(nativeWinner, "Stock Pi resolved the duplicate native skill");
      const nativeWinnerBody = await readFile(nativeWinner.filePath, "utf8");
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
      await session.bindExtensions({
        onError: (error) => {
          throw error;
        },
      });
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "toolResult")
          results.push(event.message);
      });
      await session.prompt("Choose temporary parent guidance.");
      assert(
        results.every((result) => !result.isError),
        JSON.stringify(results),
      );
      // Session setup takes effect on the next parent run, as in interactive Pi.
      step = 1;
      delegate = true;
      results.length = 0;
      await session.prompt("Delegate using each child's saved resource selection.");
      assert(
        results.every((result) => !result.isError),
        JSON.stringify(results),
      );
      assert.equal(captures.length, scenarios.length);
      const parent = parentPrompts.at(-1)!;
      assert.match(parent, /TEMPORARY_PARENT_INSTRUCTION/);
      assert.match(parent, /USER_TEMPORARY_DESCRIPTION/);
      assert.doesNotMatch(
        parent,
        /SAVED_PERSONAL_INSTRUCTION|SAVED_PROJECT_INSTRUCTION|USER_PERSONAL_DESCRIPTION|PROJECT_DESCRIPTION|PRIVATE_DESCRIPTION/,
      );
      for (const [index, scenario] of scenarios.entries()) {
        const capture = captures[index];
        assert.notEqual(capture.pid, process.pid, "Model capture came from a child process");
        assert.match(capture.prompt, new RegExp(`BUNDLE_${scenario.name}_INSTRUCTION`));
        assert.match(capture.prompt, /SAVED_PERSONAL_INSTRUCTION/);
        assert.match(capture.prompt, /SAVED_PROJECT_INSTRUCTION/);
        assert.match(capture.prompt, /PROJECT_STATIC_CONTEXT/);
        assert.ok(
          capture.prompt.indexOf("SAVED_PERSONAL_INSTRUCTION") <
            capture.prompt.indexOf(`BUNDLE_${scenario.name}_INSTRUCTION`),
          "Agent body follows saved instructions",
        );
        assert.doesNotMatch(
          capture.prompt,
          /TEMPORARY_PARENT_INSTRUCTION|USER_TEMPORARY_DESCRIPTION|_BODY/,
        );
        assert.deepEqual(
          capture.skills.map((skill: any) => skill.name).sort(),
          [...scenario.expected].sort(),
          scenario.name,
        );
        for (const advertised of capture.skills) {
          assert.ok(advertised.path.endsWith("/SKILL.md"));
          if (advertised.name === "collision") {
            assert.match(advertised.path, /\/bundles\/agent\/skills\/collision\/SKILL.md$/);
            assert.match(advertised.body, /BUNDLE_COLLISION_BODY/);
          } else if (advertised.name === "native-winner")
            assert.equal(advertised.body, nativeWinnerBody);
          else assert.match(advertised.body, /_BODY/);
        }
      }
      const namedLaunch = results.filter((result) => result.toolName === "subagent")[3];
      assert.match(JSON.stringify(namedLaunch), /missing.*not found.*omitted/i);
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), globalSettings);
      assert.equal(await readFile(join(project, ".pi/settings.json"), "utf8"), projectSettings);
    } finally {
      if (session) {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
        session.dispose();
      }
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
