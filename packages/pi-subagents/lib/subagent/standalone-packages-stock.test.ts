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
    assert.match(receipt.effects.packages, /registered resource kinds: skills, agents/);
    assert.match(receipt.effects.packages, /Missing providers are not activated/);
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
