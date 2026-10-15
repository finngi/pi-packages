import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import background from "../../../pi-background/extensions/background-process.ts";
import context from "../../../pi-context/extensions/context.ts";
import subagents from "../../extensions/subagent.ts";

const system = (messages: any[]) => {
  const current = getCurrentSystemMessage(messages);
  return current ? getSystemMessageText(current) : "";
};

test(
  "stock session setup keeps catalogue metadata lazy, applies lookups now and prompt instructions next run, and restores a native branch",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-session-setup-stock-")),
      project = join(root, "project"),
      agentDir = join(root, "agent"),
      catalogue = join(root, "packages"),
      pack = join(catalogue, "fixture-pack"),
      worker = join(pack, "io.github.finngi2.pi/agents/worker");
    const globalPath = join(agentDir, "settings.json"),
      projectPath = join(project, ".pi/settings.json"),
      observed = join(root, "child-first.json"),
      provider = join(root, "provider.mjs");
    const put = async (file: string, value: string) => {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, value);
    };
    await mkdir(project);
    const global = JSON.stringify({ packages: [pack], subagents: { skills: ["native"] } }),
      local = JSON.stringify({ keep: "native" });
    await put(globalPath, global);
    await put(projectPath, local);
    await put(
      join(agentDir, "skills/native/SKILL.md"),
      "---\nname: native\ndescription: NATIVE_DESCRIPTION\n---\nNATIVE_BODY",
    );
    await put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "fixture-pack",
        version: "0.1.0",
        description: "Fixture metadata",
        keywords: ["bm25"],
        pi: {
          extensions: [],
          skills: ["skills"],
          agents: ["./io.github.finngi2.pi/agents"],
          instructions: ["./io.github.finngi2.pi/instructions"],
        },
      }),
    );
    const publicPath = join(pack, "skills/pack-public/SKILL.md");
    const publicBody = "---\nname: pack-public\ndescription: PACK_DESCRIPTION\n---\nPACK_BODY";
    await put(publicPath, publicBody);
    await put(
      join(worker, "worker.md"),
      "---\nname: worker\ndescription: WORKER_DESCRIPTION\ntools: [read, bash]\nconversation: none\n---\nWORKER_BODY",
    );
    await put(
      join(worker, "skills/private-check/SKILL.md"),
      "---\nname: private-check\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY\nRun scripts/proof.mjs.",
    );
    await put(
      join(worker, "skills/private-check/scripts/proof.mjs"),
      "import{writeFileSync}from'node:fs';writeFileSync('proof.txt','PRIVATE_SCRIPT_OUTPUT');console.log('PRIVATE_SCRIPT_EXECUTED');",
    );
    await put(
      join(pack, "io.github.finngi2.pi/instructions/behavior.md"),
      "---\ndescription: Evidence behavior\n---\n# Behavior\nPACK_INSTRUCTION_BODY",
    );
    const model: any = {
      id: "session-fixture",
      name: "Session fixture",
      provider: "session-fixture",
      api: "session-fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await put(
      provider,
      `import{existsSync,writeFileSync}from'node:fs';import{dirname,resolve}from'node:path';import{createAssistantMessageEventStream,getSystemMessageText}from${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};export default function(pi){let step=0;const model=${JSON.stringify(model)};pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx)=>{const text=ctx.messages.filter(m=>m.role==='system').map(getSystemMessageText).join('\\n');if(step===0)writeFileSync(${JSON.stringify(observed)},JSON.stringify(ctx.messages));const skill=text.split('<name>private-check</name>')[1]?.split('<location>')[1]?.split('</location>')[0];const call=[{name:'read',arguments:{path:skill}},{name:'bash',arguments:{command:JSON.stringify(process.execPath)+' '+JSON.stringify(resolve(dirname(skill),'scripts/proof.mjs'))}}][step++];const stream=createAssistantMessageEventStream(),reason=call?'toolUse':'stop',message={role:'assistant',content:call?[{type:'toolCall',id:'child-'+step,...call}]:[{type:'text',text:'CHILD_DONE'}],api:model.api,provider:model.provider,model:model.id,stopReason:reason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};const deliver=()=>{if(step===2&&process.env.PI_SETUP_WAIT_MARKER&&!existsSync(process.env.PI_SETUP_WAIT_MARKER)){setTimeout(deliver,5);return;}stream.push({type:'start',partial:message});stream.push({type:'done',reason,message});stream.end();};queueMicrotask(deliver);return stream;}});}`,
    );
    const saved = { ...process.env };
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_FIXTURE_EXTENSION: provider,
    });
    delete process.env.PI_SECURITY_TRANSPORT;
    delete process.env.PI_SUBAGENT;
    let session: sdk.AgentSession | undefined,
      mode = "off",
      step = 0,
      resolveChild!: () => void;
    let childDone = new Promise<void>((resolve) => {
      resolveChild = resolve;
    });
    const calls: any[][] = [],
      results: any[] = [];
    let stdout = "";
    const last = (name: string) => results.filter((result) => result.toolName === name).at(-1);
    const lastSuccess = (name: string) =>
      results.filter((result) => result.toolName === name && !result.isError).at(-1);
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
        models: [model, { ...model, id: "alternate-fixture" }],
        streamSimple: (_m: any, ctx: any) => {
          calls.push(structuredClone(ctx.messages));
          let call: any;
          if (mode === "apply")
            call = [
              {
                name: "session_setup",
                arguments: {
                  op: "apply",
                  packages: ["fixture-pack"],
                  skills: ["native"],
                  tools: [
                    "read",
                    "bash",
                    "subagent",
                    "subagent_check",
                    "subagent_close",
                    "hold_child",
                  ],
                },
              },
              {
                name: "subagent",
                arguments: {
                  agent: "worker",
                  task: "Read private guidance and run its supporting script.",
                  workspace: "scratch",
                },
              },
              { name: "hold_child", arguments: {} },
              () => ({
                name: "subagent_close",
                arguments: { id: JSON.parse(last("subagent").content[0].text).agent_id },
              }),
            ][step++];
          if (mode === "fresh-child")
            call = [
              {
                name: "subagent",
                arguments: {
                  agent: "worker",
                  task: "Use selected guidance.",
                  workspace: "scratch",
                },
              },
              {
                name: "session_setup",
                arguments: {
                  op: "apply",
                  tools: ["read", "subagent", "subagent_check", "subagent_close", "hold_child"],
                },
              },
              () => ({
                name: "subagent_check",
                arguments: { id: JSON.parse(lastSuccess("subagent").content[0].text).agent_id },
              }),
              { name: "hold_child", arguments: {} },
              {
                name: "subagent",
                arguments: { agent: "worker", task: "Must not regain removed bash" },
              },
              () => ({
                name: "subagent_close",
                arguments: { id: JSON.parse(lastSuccess("subagent").content[0].text).agent_id },
              }),
            ][step++];
          if (mode === "clear")
            call = [
              {
                name: "session_setup",
                arguments: { op: "apply", skills: [], agents: [], instructions: [] },
              },
              {
                name: "subagent",
                arguments: { agent: "worker", task: "Must refuse unselected worker" },
              },
            ][step++];
          if (mode === "pinned")
            call = [
              { name: "session_setup", arguments: { op: "apply", agents: ["worker"] } },
              {
                name: "subagent",
                arguments: {
                  agent: "worker",
                  task: "Must reject override of fixed role model",
                  model: "session-fixture/alternate-fixture",
                },
              },
            ][step++];
          if (mode === "reset" && step++ === 0)
            call = { name: "session_setup", arguments: { op: "reset" } };
          if (mode === "late" && step++ === 0)
            call = { name: "session_setup", arguments: { op: "apply", skills: ["late-skill"] } };
          if (mode === "replaced" && step++ === 0)
            call = { name: "session_setup", arguments: { op: "apply", skills: ["pack-public"] } };
          if (typeof call === "function") call = call();
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
      const open = async (manager = sdk.SessionManager.inMemory(project)) => {
        const settings = sdk.SettingsManager.create(project, agentDir, { projectTrusted: true });
        const loader = new sdk.DefaultResourceLoader({
          cwd: project,
          agentDir,
          settingsManager: settings,
          noExtensions: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [
            {
              path: "fixture:session",
              factory(pi) {
                background(pi);
                const emit = pi.events.emit.bind(pi.events);
                pi.events.emit = (name, value: any) => {
                  if (name === "background:service") {
                    const respond = value.respond;
                    value.respond = (service: any) => {
                      const launch = service.launch;
                      service.launch = (spec: any, options: any) => {
                        let childOutput = "";
                        const onData = spec.onData;
                        spec.onData = (stream: string, bytes: Buffer) => {
                          onData(stream, bytes);
                          if (stream === "stdout") {
                            stdout += bytes.toString();
                            childOutput += bytes.toString();
                            if (childOutput.includes('"type":"agent_settled"')) resolveChild();
                          }
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
                context(pi);
                pi.registerTool({
                  name: "hold_child",
                  label: "Wait",
                  description: "Wait for the owned fixture child",
                  parameters: Type.Object({}),
                  async execute() {
                    if (process.env.PI_SETUP_WAIT_MARKER)
                      await writeFile(process.env.PI_SETUP_WAIT_MARKER, "parent narrowed");
                    let timer: NodeJS.Timeout;
                    try {
                      await Promise.race([
                        childDone,
                        new Promise((_, reject) => {
                          timer = setTimeout(
                            () => reject(Error("Fixture child did not settle")),
                            5000,
                          );
                        }),
                      ]);
                    } finally {
                      clearTimeout(timer!);
                    }
                    return { content: [{ type: "text", text: "settled" }], details: {} };
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
          settingsManager: settings,
          resourceLoader: loader,
          sessionManager: manager,
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
        return manager;
      };
      const close = async () => {
        await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
        session?.dispose();
        session = undefined;
      };
      const run = async (next: string) => {
        mode = next;
        step = 0;
        calls.length = 0;
        results.length = 0;
        await session!.prompt("Inspect session resources.");
      };
      const manager = await open();
      const baselineTools = session!.getActiveToolNames();
      await run("off");
      assert.match(system(calls[0]), /NATIVE_DESCRIPTION/);
      assert.doesNotMatch(
        system(calls[0]),
        /PACK_DESCRIPTION|PACK_BODY|PRIVATE_DESCRIPTION|PRIVATE_BODY|WORKER_DESCRIPTION|PACK_INSTRUCTION_BODY/,
      );
      const beforeManual = calls.length;
      await session!.prompt("/skill:pack-public must be refused");
      assert.equal(calls.length, beforeManual);
      await run("apply");
      assert.ok(results.every((result) => !result.isError));
      const receipt = JSON.parse(last("session_setup").content[0].text);
      assert.deepEqual(receipt.selected.skills, ["pack-public", "native"]);
      assert.equal(receipt.effectivePreviews[0].id, "worker");
      assert.equal(receipt.effectivePreviews[0].locked, false);
      assert.ok(receipt.effectivePreviews[0].tools.includes("read"));
      assert.match(receipt.effects.children, /last parent prompt until the parent runs again/);
      assert.ok(
        receipt.candidates
          .filter(
            (candidate: any) => candidate.kind === "agents" || candidate.kind === "instructions",
          )
          .every((candidate: any) => candidate.path === undefined),
      );
      assert.doesNotMatch(system(calls.at(-1)!), /PACK_DESCRIPTION|PACK_INSTRUCTION_BODY/);
      const firstChild = system(JSON.parse(await readFile(observed, "utf8")));
      assert.match(firstChild, /PACK_DESCRIPTION|PRIVATE_DESCRIPTION/);
      assert.match(firstChild, /WORKER_BODY/);
      assert.doesNotMatch(firstChild, /PRIVATE_BODY|PACK_BODY|PACK_INSTRUCTION_BODY|session_setup/);
      assert.match(stdout, /PRIVATE_SCRIPT_EXECUTED/);
      const artifact = JSON.parse(last("subagent_close").content[0].text).artifacts;
      assert.equal(
        await readFile(join(artifact.directory, "proof.txt"), "utf8"),
        "PRIVATE_SCRIPT_OUTPUT",
      );
      const branch = [manager.getHeader()!, ...manager.getBranch()];
      const selectedTools = session!.getActiveToolNames();
      assert.equal(selectedTools.includes("write"), false);
      await session!.reload();
      await run("off");
      assert.deepEqual(session!.getActiveToolNames(), selectedTools);
      assert.match(system(calls[0]), /WORKER_DESCRIPTION/);
      assert.match(system(calls[0]), /PACK_DESCRIPTION/);
      assert.match(system(calls[0]), /PACK_INSTRUCTION_BODY/);
      childDone = new Promise((resolve) => {
        resolveChild = resolve;
      });
      process.env.PI_SETUP_WAIT_MARKER = join(root, "parent-narrowed.txt");
      await run("fresh-child");
      assert.deepEqual(
        results.filter((result) => result.isError).map((result) => result.toolName),
        ["subagent"],
      );
      assert.match(last("subagent").content[0].text, /bash.*unavailable/);
      assert.ok(JSON.parse(lastSuccess("subagent").content[0].text).tools.includes("bash"));
      assert.equal(JSON.parse(last("subagent_check").content[0].text).status, "busy");
      assert.equal(session!.getActiveToolNames().includes("bash"), false);
      const continued = JSON.parse(last("subagent_close").content[0].text).artifacts;
      assert.equal(
        await readFile(join(continued.directory, "proof.txt"), "utf8"),
        "PRIVATE_SCRIPT_OUTPUT",
      );
      delete process.env.PI_SETUP_WAIT_MARKER;
      assert.match(system(calls[0]), /PACK_DESCRIPTION/);
      assert.match(system(calls[0]), /PACK_INSTRUCTION_BODY/);
      const freshChild = system(JSON.parse(await readFile(observed, "utf8")));
      assert.match(freshChild, /PACK_INSTRUCTION_BODY/);
      assert.equal(freshChild.match(/<instructions>/g)?.length, 1);
      await run("clear");
      assert.equal(last("subagent").isError, true);
      const beforeClearedManual = calls.length;
      await session!.prompt("/skill:pack-public must remain refused");
      assert.equal(calls.length, beforeClearedManual);
      await close();
      await open(sdk.SessionManager.inMemory(project, undefined, branch));
      assert.deepEqual(session!.getActiveToolNames(), selectedTools);
      await run("off");
      assert.match(system(calls[0]), /PACK_DESCRIPTION|PACK_INSTRUCTION_BODY/);
      await run("reset");
      assert.deepEqual(session!.getActiveToolNames(), baselineTools);
      await run("off");
      assert.match(system(calls[0]), /NATIVE_DESCRIPTION/);
      assert.doesNotMatch(
        system(calls[0]),
        /PACK_DESCRIPTION|PACK_INSTRUCTION_BODY|WORKER_DESCRIPTION/,
      );
      await put(
        join(worker, "worker.md"),
        "---\nname: worker\ndescription: PINNED_WORKER_DESCRIPTION\nmodel: session-fixture/session-fixture\ntools: [read, bash]\nconversation: none\n---\nWORKER_BODY",
      );
      await run("pinned");
      const pinned = JSON.parse(last("session_setup").content[0].text);
      assert.equal(pinned.effectivePreviews[0].locked, true);
      assert.equal(
        pinned.candidates.find(
          (candidate: any) => candidate.kind === "agents" && candidate.id === "worker",
        ).description,
        "PINNED_WORKER_DESCRIPTION",
      );
      assert.equal(
        pinned.candidates.find(
          (candidate: any) => candidate.kind === "agents" && candidate.id === "worker",
        ).modelLocked,
        true,
      );
      assert.equal(last("subagent").isError, true);
      assert.match(last("subagent").content[0].text, /requested.*conflicts/);
      await put(
        join(pack, "skills/late-skill/SKILL.md"),
        "---\nname: late-skill\ndescription: Late metadata\n---\nLATE_BODY",
      );
      await run("late");
      assert.equal(last("session_setup").isError, true);
      assert.match(last("session_setup").content[0].text, /Unknown or unavailable/);
      await put(`${publicPath}.replacement`, publicBody);
      await rename(`${publicPath}.replacement`, publicPath);
      await run("replaced");
      assert.equal(last("session_setup").isError, true);
      await session!.reload();
      await run("late");
      assert.equal(last("session_setup").isError, false);
      await session!.reload();
      await run("off");
      assert.match(system(calls[0]), /Late metadata/);
      assert.doesNotMatch(system(calls[0]), /PACK_DESCRIPTION|NATIVE_DESCRIPTION/);
      mode = "off";
      step = 0;
      calls.length = 0;
      await session!.prompt("/skill:late-skill now registered and selected");
      assert.match(JSON.stringify(calls), /LATE_BODY/);
      assert.equal(await readFile(globalPath, "utf8"), global);
      assert.equal(await readFile(projectPath, "utf8"), local);
    } finally {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session?.dispose();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
