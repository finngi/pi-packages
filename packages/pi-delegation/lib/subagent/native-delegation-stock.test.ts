import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import subagents from "../../extensions/subagent.ts";

for (const [workspace, inheritProjectContext] of [
  ["scratch", true],
  ["project", false],
] as const)
  test(
    `stock child ${workspace} without pi-background keeps static context and excludes temporary instructions, communicates and preserves output`,
    { timeout: 30000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-unrestricted-stock-")),
        agentDir = join(root, "agent"),
        project = join(root, "project"),
        authoredBundle = join(root, "authored", "general-purpose"),
        observed = join(root, "child-prompt.json"),
        firstObserved = join(root, "child-first-prompt.json"),
        settled = join(root, "child-settled");
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await mkdir(project);
      await mkdir(join(authoredBundle, "skills", "private-review"), { recursive: true });
      await mkdir(join(authoredBundle, "references"), { recursive: true });
      await mkdir(join(authoredBundle, "scripts"));
      await writeFile(
        join(authoredBundle, "general-purpose.md"),
        "---\nname: general-purpose\ndescription: Fixture worker\ntools: [read, write, bash]\nconversation: none\n---\nComplete the assigned work. Run scripts/check.mjs to create script-proof.txt in your workspace.",
      );
      await writeFile(
        join(authoredBundle, "skills/private-review/SKILL.md"),
        "---\nname: private-review\ndescription: Use the bundled review checklist.\n---\nPrivate child-only instruction.\nSee ../../references/checklist.md.\n",
      );
      await writeFile(
        join(authoredBundle, "references/checklist.md"),
        "Bundled relative checklist.",
      );
      await writeFile(
        join(authoredBundle, "scripts/check.mjs"),
        "import {writeFileSync} from 'node:fs'; writeFileSync('script-proof.txt','PRIVATE_SCRIPT_OUTPUT'); console.log('PRIVATE_SCRIPT_EXECUTED');",
      );
      await symlink(authoredBundle, join(agentDir, "agents/general-purpose"));
      const siblingBundle = join(agentDir, "agents", "sibling");
      await mkdir(join(siblingBundle, "skills", "sibling-secret"), { recursive: true });
      await writeFile(
        join(siblingBundle, "sibling.md"),
        "---\nname: sibling\ndescription: Another worker\n---\nSibling instructions.",
      );
      await writeFile(
        join(siblingBundle, "skills/sibling-secret/SKILL.md"),
        "---\nname: sibling-secret\ndescription: SIBLING_PRIVATE_DESCRIPTION\n---\nSIBLING_PRIVATE_BODY",
      );
      const saved = { ...process.env };
      let session: sdk.AgentSession | undefined;
      const calls: any[] = [],
        results: any[] = [];
      let index = 0;
      let stderr = "",
        stdout = "";
      const model: any = {
        id: "fixture",
        name: "Fixture",
        api: "unrestricted-fixture",
        provider: "fixture",
        baseUrl: "http://invalid.local",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const outside = join(root, "outside.txt"),
        provider = join(root, "provider.mjs");
      await writeFile(
        provider,
        `import {createAssistantMessageEventStream} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
import {writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {getSystemMessageText} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {let i=0; const model=${JSON.stringify(model)}; pi.registerProvider(model.provider,{api:model.api,apiKey:'fixture',baseUrl:model.baseUrl,models:[model],streamSimple:(m,ctx)=>{
writeFileSync(${JSON.stringify(observed)},JSON.stringify(ctx.messages));
if(i===0) writeFileSync(${JSON.stringify(firstObserved)},JSON.stringify(ctx.messages));
const all=JSON.stringify(ctx.messages), parent=all.match(/<parent_id>([^<]+)<\\/parent_id>/)?.[1], skill=all.match(/<location>([^<]+)\\<\\/location>/)?.[1];
const system=ctx.messages.filter(x=>x.role==='system').map(getSystemMessageText).join('\\n'), bundle=system.match(/<agent_bundle path="([^"<>]+)" \\/>/)?.[1];
const steps=[{name:'bash',arguments:{command:${JSON.stringify(process.execPath)}+' '+JSON.stringify(resolve(bundle,'scripts/check.mjs'))}},{name:'read',arguments:{path:skill}},{name:'read',arguments:{path:resolve(dirname(skill),'../../references/checklist.md')}},{name:'write',arguments:{path:'answer.txt',content:'preserved child artifact'}},{name:'write',arguments:{path:${JSON.stringify(outside)},content:'host permissions verified'}},{name:'agent_message',arguments:{to:parent,message:'LIVE_COST_STATUS'}}];
const next=steps[i++],reason=next?'toolUse':'stop',stream=createAssistantMessageEventStream();if(!next)writeFileSync(${JSON.stringify(settled)},'ready');
const message={role:'assistant',content:next?[{type:'toolCall',id:'fixture-'+i,...next}]:[{type:'text',text:'CHILD_READY'}],api:model.api,provider:model.provider,model:model.id,stopReason:reason,timestamp:Date.now(),usage:{input:10,output:2,cacheRead:3,cacheWrite:0,totalTokens:15,cost:{input:0.01,output:0.02,cacheRead:0,cacheWrite:0,total:0.03}}};
queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason,message});stream.end();});return stream;}});}`,
      );
      Object.assign(process.env, {
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_PROVIDER_EXTENSION: provider,
      });
      delete process.env.PI_SUBAGENT;
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
          streamSimple: (_model: any, context: any) => {
            calls.push(context.messages);
            const next = [
              {
                name: "subagent",
                arguments: {
                  agent: "general-purpose",
                  task: "Create an artifact and send a progress message.",
                  model: `${model.provider}/${model.id}`,
                  workspace,
                },
              },
              { name: "hold_child", arguments: {} },
              () => ({
                name: "subagent_close",
                arguments: {
                  id: JSON.parse(
                    results.find((result) => result.toolName === "subagent").content[0].text,
                  ).agent_id,
                },
              }),
            ][index++];
            const call = typeof next === "function" ? next() : next;
            const stream = createAssistantMessageEventStream(),
              reason = call ? "toolUse" : "stop";
            const message: any = {
              role: "assistant",
              content: call
                ? [{ type: "toolCall", id: `parent-${index}`, ...call }]
                : [{ type: "text", text: "Parent complete" }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: reason,
              timestamp: Date.now(),
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
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
        const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
        const loader = new sdk.DefaultResourceLoader({
          cwd: project,
          agentDir,
          settingsManager: settings,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          agentsFilesOverride: (current) => ({
            agentsFiles: inheritProjectContext
              ? [
                  ...current.agentsFiles,
                  {
                    path: "/fixture/global/AGENTS.md",
                    content: "---\nowner: parent\n---\nGlobal parent instruction.",
                  },
                  { path: join(project, "AGENTS.md"), content: "Project parent instruction." },
                  { path: join(project, "AGENTS.local.md"), content: "Local overlay instruction." },
                ]
              : [],
          }),
          extensionFactories: [
            {
              path: "fixture:bg",
              factory(pi) {
                pi.on("before_agent_start", (input: any) => {
                  input.systemPromptOptions.sections.instructions = "EARLY_BEHAVIOR_SENTINEL";
                });
                subagents(pi);
                pi.on("before_agent_start", (input: any) => {
                  if (inheritProjectContext)
                    input.systemPromptOptions.contextFiles.push({
                      path: "/fixture/late/AGENTS.md",
                      content: "Later hook context instruction.",
                    });
                  input.systemPromptOptions.sections = {
                    ...input.systemPromptOptions.sections,
                    instructions:
                      '<instruction path="/fixture/selected/careful.md">LATE_BEHAVIOR_SENTINEL</instruction>',
                    goal: "DYNAMIC_GOAL_SENTINEL",
                    active_agents: "DYNAMIC_AGENTS_SENTINEL",
                    counters: "DYNAMIC_COUNTERS_SENTINEL",
                  };
                });
                pi.registerTool({
                  name: "hold_child",
                  label: "Hold child",
                  description: "Wait for the fixture child",
                  parameters: Type.Object({}),
                  async execute() {
                    const deadline = Date.now() + 20000;
                    while (Date.now() < deadline) {
                      if (await readFile(settled, "utf8").catch(() => "")) break;
                      await new Promise((resolve) => setTimeout(resolve, 25));
                    }
                    assert.equal(await readFile(settled, "utf8"), "ready");
                    stdout = await readFile(observed, "utf8");
                    return { content: [{ type: "text", text: "Child settled" }], details: {} };
                  },
                });
              },
            },
          ],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.deepEqual(loader.getSkills().skills, [], "Parent selects no skills");
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
        await session.prompt("Delegate fixture work.");
        assert(
          results.every((result) => !result.isError),
          JSON.stringify(results) + "\n" + stderr,
        );
        const launched = JSON.parse(
          results.find((result) => result.toolName === "subagent").content[0].text,
        );
        assert.match(launched.agent_id, /^agent-[a-z]+-[a-z]+-[a-z]+$/);
        assert.equal(launched.scope.execution, "host permissions");
        assert.equal(launched.workspace_mode, workspace);
        const childPrompt = JSON.parse(await readFile(observed, "utf8"));
        const firstChildPrompt = await readFile(firstObserved, "utf8");
        const childSystem = JSON.parse(firstChildPrompt)
          .filter((message: any) => message.role === "system")
          .map(getSystemMessageText)
          .join("\n");
        assert.doesNotMatch(
          childSystem,
          /<instructions>|EARLY_BEHAVIOR_SENTINEL|LATE_BEHAVIOR_SENTINEL|DYNAMIC_GOAL_SENTINEL|DYNAMIC_AGENTS_SENTINEL|DYNAMIC_COUNTERS_SENTINEL/,
        );
        assert.match(JSON.stringify(calls[0]), /DYNAMIC_GOAL_SENTINEL/);
        const projectContext = childSystem.match(
          /<inherited_static_context[^>]*>([\s\S]*?)<\/inherited_static_context>/,
        )?.[1];
        assert.ok(!projectContext?.includes("LATE_BEHAVIOR_SENTINEL"));
        if (!inheritProjectContext) assert.equal(projectContext, undefined);
        assert.match(firstChildPrompt, /private-review/);
        assert.match(firstChildPrompt, /Use the bundled review checklist/);
        assert.doesNotMatch(
          firstChildPrompt,
          /Private child-only instruction|Bundled relative checklist/,
        );
        assert.match(firstChildPrompt, /Use the read tool to load a skill/);
        assert.doesNotMatch(
          firstChildPrompt,
          /sibling-secret|SIBLING_PRIVATE_DESCRIPTION|SIBLING_PRIVATE_BODY/,
        );
        assert.match(JSON.stringify(childPrompt), /PRIVATE_SCRIPT_EXECUTED/);
        assert.doesNotMatch(
          JSON.stringify(childPrompt),
          /sibling-secret|SIBLING_PRIVATE_DESCRIPTION|SIBLING_PRIVATE_BODY/,
        );
        assert.match(JSON.stringify(childPrompt), /private-review/);
        assert.match(JSON.stringify(childPrompt), /Private child-only instruction/);
        assert.match(JSON.stringify(childPrompt), /Bundled relative checklist/);
        if (inheritProjectContext) {
          assert.match(JSON.stringify(childPrompt), /original_project/);
          assert.match(JSON.stringify(childPrompt), /Global parent instruction/);
          assert.match(JSON.stringify(childPrompt), /Project parent instruction/);
          assert.match(JSON.stringify(childPrompt), /Local overlay instruction/);
          assert.match(JSON.stringify(childPrompt), /Later hook context instruction/);
        } else
          assert.doesNotMatch(
            JSON.stringify(childPrompt),
            /Global parent instruction|Project parent instruction|Local overlay instruction|Later hook context instruction/,
          );
        assert.doesNotMatch(JSON.stringify(childPrompt), /owner: parent/);
        assert.doesNotMatch(JSON.stringify(calls[0]), /private-review/);
        assert.doesNotMatch(
          JSON.stringify(calls[0]),
          /sibling-secret|SIBLING_PRIVATE_DESCRIPTION|SIBLING_PRIVATE_BODY/,
        );
        assert.ok(
          !session.resourceLoader
            .getSkills()
            .skills.some((skill) => skill.name === "private-review"),
        );
        assert.equal(
          await readFile(outside, "utf8").catch(() => "missing"),
          "host permissions verified",
          stderr + "\n" + stdout,
        );
        assert.match(JSON.stringify(calls.at(-1)), /LIVE_COST_STATUS/);
        const entries: any[] = session.sessionManager.getEntries();
        const usage = entries
          .filter((entry) => entry.customType === "pi-runtime.usage.v1")
          .map((entry) => entry.data);
        assert.equal(
          usage
            .filter((record) => record.kind === "child" && record.usage)
            .reduce((sum, record) => sum + record.usage.totalTokens, 0),
          105,
        );
        assert.equal(
          results.reduce((sum, result) => sum + (result.usage?.totalTokens ?? 0), 0),
          105,
        );
        assert.match(JSON.stringify(entries), /CHILD_READY/, stderr);
        const closed = JSON.parse(
          results.find((result) => result.toolName === "subagent_close").content[0].text,
        );
        assert.match(closed.artifacts.id, /^artifact-[a-z]+-[a-z]+-[a-z]+$/);
        assert.equal(
          await readFile(join(closed.artifacts.directory, "answer.txt"), "utf8"),
          "preserved child artifact",
        );
        assert.equal(
          await readFile(join(closed.artifacts.directory, "script-proof.txt"), "utf8"),
          "PRIVATE_SCRIPT_OUTPUT",
        );
        assert.equal(
          await readFile(join(launched.workspace, "answer.txt"), "utf8").catch(() => null),
          workspace === "project" ? "preserved child artifact" : null,
        );
        assert.equal(closed.artifacts.owned, workspace === "scratch");
        assert.equal(
          closed.artifacts.scope,
          workspace === "scratch" ? "scratch-collection" : "project-reference",
        );
        assert.equal(closed.artifacts.externalEffects, "untracked");
        if (workspace === "project") assert.deepEqual(closed.artifacts.files, []);
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
