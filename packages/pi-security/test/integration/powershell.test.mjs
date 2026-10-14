import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { policy } from "../skeleton/fixture.mjs";

test("stock native PowerShell cannot execute or ask even with explicit policy allow", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-native-powershell-")));
  const saved = { env: { ...process.env }, cwd: process.cwd() };
  let session,
    executions = 0,
    asks = 0;
  try {
    const home = join(root, "home"),
      agentDir = join(root, "agent"),
      cwd = join(root, "project"),
      tmp = join(root, "tmp");
    await Promise.all([home, agentDir, cwd, tmp].map((dir) => mkdir(dir)));
    Object.assign(process.env, {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SECURITY_ACTIVATION: "active",
      PI_SECURITY_PLACEMENT: "host",
      PI_SECURITY_TRANSPORT: "internal",
      PI_SECURITY_POLICY: join(agentDir, "policy.json"),
      PI_SECURITY_TMP: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
    });
    delete process.env.PI_SUBAGENT;
    delete process.env.PI_POLICY_LAUNCH;
    process.chdir(cwd);
    const fixture = policy();
    fixture.mode = "manual";
    fixture.deny = [];
    fixture.allow = [
      { id: "allow-powershell", tool: "powershell", permissions: { write: true, network: [] } },
    ];
    await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(fixture));
    const sdk = await import("@earendil-works/pi-coding-agent");
    const runtime = await sdk.ModelRuntime.create({
      modelsPath: null,
      modelsStorePath: join(tmp, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
      credentials: {
        async read() {},
        async list() {
          return [];
        },
        async modify() {},
        async delete() {},
      },
    });
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../src/extension.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      noTools: "builtin",
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
      },
    });
    session.setActiveToolsByName(["powershell"]);
    const info = session.getAllTools().find((tool) => tool.name === "powershell");
    assert.equal(info.sourceInfo.path, "builtin:powershell");
    const native = session.agent.state.tools.find((tool) => tool.name === "powershell");
    assert(native);
    const probe = {
      ...native,
      execute: async () => {
        executions++;
        throw Error("native dispatch must not occur");
      },
    };
    for (const id of ["direct", "nested"]) {
      const call = {
        type: "toolCall",
        id,
        name: "powershell",
        arguments: { command: "Write-Output fixture" },
      };
      const message = {
        role: "assistant",
        content: [call],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const outcome = await runToolCall(call, {
        tools: [probe],
        assistantMessage: message,
        context: { messages: [], tools: [probe] },
        beforeToolCall:
          id === "direct"
            ? session.agent.beforeToolCall
            : (context) =>
                session.extensionRunner.emitToolCall({
                  type: "tool_call",
                  toolName: context.toolCall.name,
                  toolCallId: context.toolCall.id,
                  parentToolCallId: "outer-tool",
                  input: context.args,
                }),
      });
      assert.equal(outcome.isError, true);
      assert.match(JSON.stringify(outcome.result), /native PowerShell is disabled/);
    }
    assert.equal(executions, 0);
    assert.equal(asks, 0);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    process.chdir(saved.cwd);
    process.env = saved.env;
    await rm(root, { recursive: true, force: true });
  }
});
