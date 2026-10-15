import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { sessionSetupService, type SessionSetupService } from "pi-runtime";
import subagents from "../../extensions/subagent.ts";

test("stock Pi selects an agent-only package without an instructions provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-package-alone-")),
    agentDir = join(root, "agent"),
    pack = join(root, "package");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const put = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  let session: sdk.AgentSession | undefined,
    setup: SessionSetupService | undefined,
    ctx: sdk.ExtensionContext | undefined;
  try {
    await put(join(agentDir, "settings.json"), JSON.stringify({ packages: [pack] }));
    await put(
      join(pack, "package.json"),
      JSON.stringify({ name: "agent-only", version: "1.0.0", pi: { agents: ["agents"] } }),
    );
    await put(
      join(pack, "agents/worker/worker.md"),
      "---\nname: worker\ndescription: Independent worker\n---\nWorker instructions",
    );
    const settingsManager = sdk.SettingsManager.create(root, agentDir),
      runtime = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [
        {
          path: "fixture:agents-only",
          factory(pi) {
            subagents(pi);
            setup = sessionSetupService(pi.events);
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
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: sdk.SessionManager.inMemory(root),
    }));
    await session.bindExtensions({
      mode: "print",
      uiContext: { notify() {}, setStatus() {}, setWidget() {} },
    });
    const before = setup!.execute({ op: "list" }, ctx!).overrides.instructions;
    const receipt = setup!.execute({ op: "apply", packages: ["agent-only"] }, ctx!);
    assert.deepEqual(receipt.selected.agents, ["worker"]);
    assert.deepEqual(receipt.overrides.instructions, before);
    assert.match(receipt.effects.packages, /Available resource types: skills, agents/);
    assert.match(receipt.effects.packages, /Unloaded extensions stay off/);
    assert.equal(
      session.getAllTools().some((tool) => tool.name === "background_process"),
      false,
    );
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("stock Pi discovers temporary package skills, agents and instructions without settings or project trust", async () => {
  const { default: context } = await import("../../../pi-context/extensions/context.ts");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-temporary-package-")),
    agentDir = join(root, "agent"),
    pack = join(root, "package"),
    cwd = join(root, "unrelated-project");
  const previous = process.env.PI_CODING_AGENT_DIR,
    argv = process.argv;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = [...argv, "-e", pack, "--", "-e", join(root, "not-a-package")];
  const put = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  let session: sdk.AgentSession | undefined,
    setup: SessionSetupService | undefined,
    ctx: sdk.ExtensionContext | undefined;
  try {
    await mkdir(cwd);
    await put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "temporary-resources",
        version: "1.0.0",
        pi: {
          extensions: [],
          skills: ["skills"],
          agents: ["agents"],
          instructions: ["instructions"],
        },
      }),
    );
    await put(
      join(pack, "agents/worker/worker.md"),
      "---\nname: worker\ndescription: Independent worker\n---\nWorker instructions",
    );
    await put(
      join(pack, "skills/check/SKILL.md"),
      "---\nname: check\ndescription: Check evidence\n---\nLAZY_SKILL_BODY",
    );
    await put(
      join(pack, "instructions/evidence.md"),
      "---\nnotes: HUMAN_ONLY\n---\n# Evidence\nTEMPORARY_INSTRUCTION",
    );
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: [pack],
      extensionFactories: [
        {
          path: "fixture:temporary-package",
          factory(pi) {
            context(pi);
            subagents(pi);
            setup = sessionSetupService(pi.events);
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
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
    }));
    await session.bindExtensions({
      mode: "print",
      uiContext: { notify() {}, setStatus() {}, setWidget() {} },
    });
    const receipt = setup!.execute({ op: "apply", packages: ["temporary-resources"] }, ctx!);
    assert.deepEqual(receipt.selected.agents, ["worker"]);
    assert.deepEqual(receipt.selected.skills, ["check"]);
    assert.equal(receipt.selected.instructions.length, 1);
    const prompt = await session.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Check the package." },
      session._baseSystemPromptOptions,
    );
    assert.match(JSON.stringify(prompt?.systemPromptOptions), /TEMPORARY_INSTRUCTION/);
    assert.doesNotMatch(JSON.stringify(prompt?.systemPromptOptions), /HUMAN_ONLY|LAZY_SKILL_BODY/);
    assert.equal(ctx!.isProjectTrusted(), false);
    assert.deepEqual(settingsManager.getGlobalSettings(), {});
    assert.deepEqual(settingsManager.getProjectSettings(), {});
    assert.equal(await readFile(join(agentDir, "settings.json")).catch(() => undefined), undefined);
    assert.equal(await readFile(join(cwd, ".pi/settings.json")).catch(() => undefined), undefined);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session?.dispose();
    process.argv = argv;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
