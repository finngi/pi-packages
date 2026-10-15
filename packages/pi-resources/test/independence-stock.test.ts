import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import { sessionSetupService, type SessionSetupService } from "pi-resources/session-setup";
import resources from "../extensions/resources.ts";
import context from "../../pi-context/extensions/context.ts";
import delegation from "../../pi-delegation/extensions/subagent.ts";

const providers = { resources, context, delegation };
const scenarios: Array<Array<keyof typeof providers>> = [
  ["resources"],
  ["context"],
  ["delegation"],
  ["resources", "context", "delegation"],
  ["delegation", "context", "resources"],
];
for (const names of scenarios)
  test(`stock Pi independent providers: ${names.join(" + ")}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-boundary-"));
    const agentDir = join(root, "agent"),
      cwd = join(root, "project"),
      pack = join(root, "package");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const put = async (path: string, body: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    };
    let session: sdk.AgentSession | undefined, api: sdk.ExtensionAPI, ctx: sdk.ExtensionContext;
    let setup: SessionSetupService;
    const settingsFile = join(agentDir, "settings.json");
    const defaults = {
      packages: [pack],
      subagents: { skills: { check: false }, agents: { worker: false } },
      localContext: { instructions: {} },
    };
    try {
      await mkdir(cwd);
      await put(settingsFile, JSON.stringify(defaults));
      await put(
        join(pack, "package.json"),
        JSON.stringify({
          name: "fixture-resources",
          version: "1.0.0",
          description: "Research helpers",
          keywords: ["bibliography"],
          pi: {
            extensions: [],
            skills: ["skills"],
            agents: ["agents"],
            instructions: ["instructions"],
          },
        }),
      );
      await put(
        join(pack, "skills/check/SKILL.md"),
        "---\nname: check\ndescription: CHECK_DESCRIPTION\n---\nLAZY_SKILL_BODY",
      );
      await put(
        join(pack, "agents/worker/worker.md"),
        "---\nname: worker\ndescription: WORKER_DESCRIPTION\nskills: []\n---\nCHILD_BODY",
      );
      await put(join(pack, "instructions/evidence.md"), "# Evidence\nEAGER_INSTRUCTION_BODY");
      const runtime = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const model: any = {
        id: "resource-fixture",
        name: "Resource fixture",
        api: "resource-fixture",
        provider: "resource-fixture",
        baseUrl: "http://invalid.local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      };
      runtime.registerProvider(model.provider, {
        api: model.api,
        apiKey: "fixture",
        baseUrl: model.baseUrl,
        models: [model],
        streamSimple() {
          const stream = createAssistantMessageEventStream();
          const message: any = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "stop",
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
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          });
          return stream;
        },
      });
      const open = async (manager: sdk.SessionManager) => {
        const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noContextFiles: true,
          extensionFactories: [
            {
              path: "fixture:independent",
              factory(pi) {
                api = pi;
                for (const name of names) providers[name](pi);
                setup = sessionSetupService(pi.events)!;
                pi.on("session_start", (_event, current) => {
                  ctx = current;
                });
              },
            },
          ],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await sdk.createAgentSession({
          cwd,
          agentDir,
          settingsManager,
          resourceLoader: loader,
          modelRuntime: runtime,
          model,
          thinkingLevel: "off",
          sessionManager: manager,
        }));
        await session.bindExtensions({
          mode: "print",
          onError(error) {
            throw error;
          },
          uiContext: { notify() {}, setStatus() {}, setWidget() {} },
        });
      };
      const close = async () => {
        await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
        session?.dispose();
        session = undefined;
      };
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      const commands = api!.getCommands().map((command) => command.name);
      assert.equal(commands.includes("packages"), names.includes("resources"));
      assert.equal(commands.includes("skills"), names.includes("resources"));
      assert.equal(commands.includes("agents"), names.includes("delegation"));
      assert.equal(commands.includes("instructions"), names.includes("context"));
      assert.equal(
        session!.getAllTools().filter((tool) => tool.name === "session_setup").length,
        1,
      );
      assert.equal(
        session!.getAllTools().some((tool) => tool.name === "subagent"),
        names.includes("delegation"),
      );
      const initial = setup!.execute({ op: "list" }, ctx!);
      if (!names.includes("resources")) assert.equal(initial.overrides.skills, undefined);
      const tools = session!.getActiveToolNames();
      const selected = setup!.execute({ op: "apply", packages: ["fixture-resources"] }, ctx!);
      assert.deepEqual(selected.selected.skills, names.includes("resources") ? ["check"] : []);
      assert.deepEqual(selected.selected.agents, names.includes("delegation") ? ["worker"] : []);
      assert.equal(selected.selected.instructions.length, names.includes("context") ? 1 : 0);
      assert.deepEqual(session!.getActiveToolNames(), tools);
      const prompt = await session!.extensionRunner!.emitBeforeAgentStart(
        { messageType: "user", prompt: "Check evidence" },
        session!._baseSystemPromptOptions,
      );
      const options = JSON.stringify(prompt?.systemPromptOptions);
      if (names.includes("context")) assert.match(options, /EAGER_INSTRUCTION_BODY/);
      assert.doesNotMatch(options, /LAZY_SKILL_BODY|CHILD_BODY/);
      assert.equal(await readFile(settingsFile, "utf8"), JSON.stringify(defaults));
      assert.equal(
        await readFile(join(cwd, ".pi/settings.json")).catch(() => undefined),
        undefined,
      );
      // Pi persists an initially buffered session once the first assistant message arrives.
      await session!.prompt("Persist this selected session.");
      const file = session!.sessionManager.getSessionFile()!;
      await close();
      // Resume must retain choices rather than reapply the saved empty defaults.
      await open(sdk.SessionManager.open(file));
      assert.deepEqual(setup!.execute({ op: "list" }, ctx!).selected, selected.selected);
      await close();
    } finally {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
