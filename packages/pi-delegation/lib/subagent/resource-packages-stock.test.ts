import resources from "../../../pi-resources/extensions/resources.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverResourcePackages } from "pi-resources/discovery";
import background from "../../../pi-background/extensions/background-process.ts";
import context from "../../../pi-context/extensions/context.ts";
import { catalogueInstructionId } from "../../../pi-context/lib/instruction-selection.ts";
import subagents from "../../extensions/subagent.ts";
import { configuredSkillChoices } from "pi-resources/selection";

const system = (messages: any[]) =>
  messages
    .filter((message) => message.role === "system")
    .map(getSystemMessageText)
    .join("\n");

// Verifies native discovery/selection/privacy and effects; scripted providers do not test task routing quality.
test(
  "stock Pi selects resource-pack guidance without parent-private leaks or executable plugin activation",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-pack-stock-")),
      agentDir = join(root, "agent"),
      project = join(root, "project"),
      catalogue = join(root, "packs"),
      pack = join(catalogue, "fixture-pack"),
      namespace = join(pack, "io.github.finngi2.pi"),
      worker = join(namespace, "agents", "pack-worker");
    const globalPath = join(agentDir, "settings.json"),
      projectPath = join(project, ".pi/settings.json"),
      observed = join(root, "child-first.json"),
      provider = join(root, "provider.mjs"),
      forbidden = join(root, "plugin-code-ran.txt");
    const put = async (file: string, content: string) => {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    };
    await mkdir(project);
    await put(
      globalPath,
      JSON.stringify({
        packages: [pack],
        subagents: { skills: { "direct-native": true, "pack-public": false } },
      }),
    );
    await put(
      join(agentDir, "skills/direct-native/SKILL.md"),
      "---\nname: direct-native\ndescription: DIRECT_NATIVE_DESCRIPTION\n---\nDIRECT_NATIVE_BODY",
    );
    await put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "fixture-pack",
        version: "0.1.0",
        description: "Fixture pack discovery",
        keywords: ["bm25", "rpc"],
        pi: {
          extensions: [],
          skills: ["skills"],
          agents: ["./io.github.finngi2.pi/agents"],
          instructions: ["./io.github.finngi2.pi/instructions"],
        },
      }),
    );
    await put(
      join(pack, "extensions/auto.ts"),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(forbidden)},'must not execute');export default function(){}`,
    );
    await put(
      join(pack, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `node ${join(pack, "extensions/auto.ts")}` }] },
          ],
        },
      }),
    );
    await put(
      join(pack, "skills/pack-public/SKILL.md"),
      "---\nname: pack-public\ndescription: PACK_PUBLIC_DESCRIPTION\n---\nPACK_PUBLIC_BODY",
    );
    await put(
      join(worker, "pack-worker.md"),
      "---\nname: pack-worker\ndescription: PACK_AGENT_DESCRIPTION\ntools: [read, bash]\nconversation: none\n---\nPACK_AGENT_BODY",
    );
    await put(
      join(worker, "skills/pack-secret/SKILL.md"),
      "---\nname: pack-secret\ndescription: PACK_PRIVATE_DESCRIPTION\n---\nPACK_PRIVATE_BODY\nRun scripts/proof.mjs in your workspace.",
    );
    await put(
      join(worker, "skills/pack-secret/scripts/proof.mjs"),
      "import {writeFileSync} from 'node:fs';writeFileSync('pack-proof.txt','PRIVATE_SCRIPT_WORKSPACE_OUTPUT');console.log('PRIVATE_SCRIPT_EXECUTED');",
    );
    await put(
      join(namespace, "agents/other-worker/other-worker.md"),
      "---\nname: other-worker\ndescription: Other worker\n---\nOther agent body",
    );
    await put(
      join(namespace, "agents/other-worker/skills/other-secret/SKILL.md"),
      "---\nname: other-secret\ndescription: OTHER_PRIVATE_DESCRIPTION\n---\nOTHER_PRIVATE_BODY",
    );
    const instructionRoot = join(namespace, "instructions");
    await put(
      join(instructionRoot, "careful.md"),
      "---\ndescription: Pack behavior\nnotes: HUMAN_METADATA\n---\n# Pack guidance\nPACK_BEHAVIOR_BODY",
    );
    const instructionId = catalogueInstructionId(instructionRoot, "careful.md");
    const model: any = {
      id: "pack-fixture",
      name: "Pack fixture",
      provider: "pack-fixture",
      api: "pack-fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await put(
      provider,
      `import {writeFileSync} from 'node:fs';import {dirname,resolve} from 'node:path';import {createAssistantMessageEventStream,getSystemMessageText} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
export default function(pi){let index=0;const model=${JSON.stringify(model)};pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx)=>{const text=ctx.messages.filter(x=>x.role==='system').map(getSystemMessageText).join('\\n');if(index===0)writeFileSync(${JSON.stringify(observed)},JSON.stringify(ctx.messages));const skill=text.match(/<name>pack-secret<\\/name>[\\s\\S]*?<location>([^<]+)<\\/location>/)?.[1];const steps=[{name:'read',arguments:{path:skill}},{name:'bash',arguments:{command:JSON.stringify(process.execPath)+' '+JSON.stringify(resolve(dirname(skill),'scripts/proof.mjs'))}}];const call=steps[index++],stream=createAssistantMessageEventStream(),reason=call?'toolUse':'stop',message={role:'assistant',content:call?[{type:'toolCall',id:'child-'+index,...call}]:[{type:'text',text:'PACK_CHILD_DONE'}],api:model.api,provider:model.provider,model:model.id,stopReason:reason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason,message});stream.end();});return stream;}});}`,
    );
    const saved = { ...process.env };
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_PROVIDER_EXTENSION: provider,
    });
    delete process.env.PI_SECURITY_TRANSPORT;
    delete process.env.PI_SUBAGENT;
    let session: sdk.AgentSession | undefined,
      mode = "off",
      offIndex = 0,
      selectedIndex = 0,
      resolveChild!: () => void;
    let childDone = new Promise<void>((resolve) => {
      resolveChild = resolve;
    });
    const calls: any[][] = [],
      results: any[] = [];
    let stdout = "",
      stderr = "";
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
        streamSimple: (_m: any, ctx: any) => {
          calls.push(structuredClone(ctx.messages));
          let call: any;
          if (mode === "off" && offIndex++ === 0)
            call = {
              name: "subagent",
              arguments: { agent: "pack-worker", task: "Must refuse this inactive agent" },
            };
          if (mode === "selected") {
            const next = [
              {
                name: "subagent",
                arguments: {
                  agent: "pack-worker",
                  task: "Read private guidance and run its supporting script.",
                  workspace: "scratch",
                },
              },
              { name: "hold_pack_child", arguments: {} },
              () => ({
                name: "subagent_close",
                arguments: {
                  id: JSON.parse(
                    results.find((result) => result.toolName === "subagent").content[0].text,
                  ).agent_id,
                },
              }),
            ][selectedIndex++];
            call = typeof next === "function" ? next() : next;
          }
          const stream = createAssistantMessageEventStream(),
            reason = call ? "toolUse" : "stop";
          const message: any = {
            role: "assistant",
            content: call
              ? [{ type: "toolCall", id: `parent-${calls.length}`, ...call }]
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
          queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason, message });
            stream.end();
          });
          return stream;
        },
      });
      const open = async (trusted: boolean) => {
        const settings = sdk.SettingsManager.create(project, agentDir, { projectTrusted: trusted });
        const loader = new sdk.DefaultResourceLoader({
          cwd: project,
          agentDir,
          settingsManager: settings,
          noExtensions: true,
          noPromptTemplates: true,
          noContextFiles: true,
          extensionFactories: [
            {
              path: "fixture:pack",
              factory(pi) {
                background(pi);
                const emit = pi.events.emit.bind(pi.events);
                pi.events.emit = (name, value: any) => {
                  if (name === "background:service") {
                    const respond = value.respond;
                    value.respond = (service: any) => {
                      const launch = service.launch;
                      service.launch = (spec: any, options: any) => {
                        const onData = spec.onData;
                        spec.onData = (stream: string, bytes: Buffer) => {
                          onData(stream, bytes);
                          if (stream === "stderr") stderr += bytes.toString();
                          else stdout += bytes.toString();
                          if (stdout.includes('"type":"agent_settled"')) resolveChild();
                        };
                        const run = launch(spec, options);
                        void run.done.then(resolveChild);
                        return run;
                      };
                      respond(service);
                    };
                  }
                  emit(name, value);
                };
                subagents(pi);
                resources(pi);
                context(pi);
                pi.registerTool({
                  name: "hold_pack_child",
                  label: "Wait",
                  description: "Wait for fixture child",
                  parameters: Type.Object({}),
                  async execute() {
                    await childDone;
                    return { content: [{ type: "text", text: "Child settled" }], details: {} };
                  },
                });
              },
            },
          ],
        });
        await loader.reload();
        const nativePaths = new Set(loader.getSkills().skills.map((skill) => skill.filePath));
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
        await session.bindExtensions({
          onError: (error) => {
            throw error;
          },
        });
        session.subscribe((event) => {
          if (event.type === "message_end" && event.message.role === "toolResult")
            results.push(event.message);
        });
        return { settings, loader, nativePaths };
      };
      const close = async () => {
        await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
        session?.dispose();
        session = undefined;
      };
      const first = await open(true);
      const choices = configuredSkillChoices(
        project,
        agentDir,
        first.loader
          .getSkills()
          .skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
        (await discoverResourcePackages(first.settings, project, agentDir)).packs,
      );
      const choice = choices.find((skill) => skill.name === "pack-public")!;
      assert.equal(choice.defaultSelected, true);
      assert.match(choice.packKeywords!, /bm25/);
      assert.match(choice.packKeywords!, /rpc/);
      await session!.prompt("Inspect resources before selecting the pack.");
      const offSystem = system(calls[0]);
      assert.match(offSystem, /DIRECT_NATIVE_DESCRIPTION/);
      assert.doesNotMatch(
        offSystem,
        /DIRECT_NATIVE_BODY|PACK_PUBLIC_DESCRIPTION|PACK_AGENT_DESCRIPTION|PACK_PRIVATE_DESCRIPTION|PACK_BEHAVIOR_BODY|OTHER_PRIVATE_DESCRIPTION|bm25/,
      );
      const refused = results.find((result) => result.toolName === "subagent");
      assert.equal(refused?.isError, true, JSON.stringify(results));
      assert.match(JSON.stringify(refused), /unavailable/);
      await session!.prompt("Inspect the same resources again.");
      assert.deepEqual(
        calls.at(-1)!.filter((message) => message.role === "system"),
        calls[0].filter((message) => message.role === "system"),
      );
      await assert.rejects(readFile(observed));
      await close();

      const selected = JSON.stringify({
        subagents: {
          agents: { "pack-worker": true },
          skills: { "pack-public": true, "direct-native": false },
        },
        localContext: { instructions: { [instructionId]: true } },
      });
      await put(projectPath, selected);
      mode = "untrusted";
      calls.length = 0;
      results.length = 0;
      await open(false);
      await session!.prompt("Project selections must stay inactive without project trust.");
      assert.match(system(calls[0]), /DIRECT_NATIVE_DESCRIPTION/);
      assert.doesNotMatch(
        system(calls[0]),
        /PACK_PUBLIC_DESCRIPTION|PACK_AGENT_DESCRIPTION|PACK_BEHAVIOR_BODY/,
      );
      await close();

      mode = "selected";
      calls.length = 0;
      results.length = 0;
      childDone = new Promise<void>((resolve) => {
        resolveChild = resolve;
      });
      await open(true);
      await session!.prompt("Use the selected pack resources.");
      assert.ok(
        results.every((result) => !result.isError),
        JSON.stringify(results) + stderr,
      );
      const selectedSystem = system(calls[0]);
      assert.match(selectedSystem, /PACK_PUBLIC_DESCRIPTION/);
      assert.match(selectedSystem, /PACK_AGENT_DESCRIPTION/);
      assert.match(selectedSystem, /<instructions>[\s\S]*PACK_BEHAVIOR_BODY/);
      assert.doesNotMatch(
        selectedSystem,
        /HUMAN_METADATA|PACK_PUBLIC_BODY|PACK_AGENT_BODY|PACK_PRIVATE_DESCRIPTION|PACK_PRIVATE_BODY|OTHER_PRIVATE_DESCRIPTION|OTHER_PRIVATE_BODY|bm25/,
      );
      const initialChild = JSON.parse(await readFile(observed, "utf8"));
      const childSystem = system(initialChild);
      assert.match(childSystem, /PACK_PRIVATE_DESCRIPTION/);
      assert.match(childSystem, /PACK_PUBLIC_DESCRIPTION/);
      assert.match(childSystem, /PACK_AGENT_BODY/);
      assert.match(childSystem, /PACK_BEHAVIOR_BODY/);
      assert.equal(childSystem.match(/<instructions>/g)?.length, 1);
      assert.doesNotMatch(
        childSystem,
        /PACK_PRIVATE_BODY|PACK_PUBLIC_BODY|OTHER_PRIVATE_DESCRIPTION|OTHER_PRIVATE_BODY/,
      );
      assert.match(stdout, /PACK_PRIVATE_BODY/);
      assert.match(stdout, /PRIVATE_SCRIPT_EXECUTED/);
      assert.doesNotMatch(
        JSON.stringify(calls),
        /PACK_AGENT_BODY|PACK_PRIVATE_DESCRIPTION|PACK_PRIVATE_BODY|OTHER_PRIVATE_DESCRIPTION|OTHER_PRIVATE_BODY/,
      );
      const closed = JSON.parse(
        results.find((result) => result.toolName === "subagent_close").content[0].text,
      );
      assert.equal(
        await readFile(join(closed.artifacts.directory, "pack-proof.txt"), "utf8"),
        "PRIVATE_SCRIPT_WORKSPACE_OUTPUT",
      );
      await assert.rejects(readFile(forbidden));
      assert.equal(
        await readFile(projectPath, "utf8"),
        selected,
        "Resource discovery must not rewrite project settings",
      );
      assert.equal(
        await readFile(globalPath, "utf8"),
        JSON.stringify({
          packages: [pack],
          subagents: { skills: { "direct-native": true, "pack-public": false } },
        }),
        "Resource discovery must not rewrite global settings",
      );
    } finally {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session?.dispose();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
