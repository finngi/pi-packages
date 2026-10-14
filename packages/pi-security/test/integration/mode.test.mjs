import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import security from "../../src/extension.ts";
import { policy } from "../skeleton/fixture.mjs";

function api(selectedMode) {
  const handlers = new Map(),
    events = new Map(),
    tools = [];
  let mcpEnabled = false,
    renderers = 0;
  const addHandler = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  const callHandlers = async (map, name, ...args) => {
    let result;
    for (const handler of map.get(name) ?? []) {
      const next = await handler(...args);
      if (next !== undefined && result === undefined) result = next;
    }
    return result;
  };
  const pi = {
    on: (name, fn) => addHandler(handlers, name, fn),
    events: {
      on: (name, fn) => addHandler(events, name, fn),
      emit: (name, value) =>
        (events.get(name) ?? []).forEach((handler) => {
          handler(value);
        }),
    },
    registerToolRenderer() {
      renderers++;
    },
    registerFlag() {},
    registerCommand() {},
    getFlag: (name) =>
      name === "permissions" ? selectedMode : name === "security-mcp" ? mcpEnabled : undefined,
    appendEntry() {},
    registerTool(tool) {
      tools.push({
        ...tool,
        sourceInfo: { path: fileURLToPath(new URL("../../src/extension.ts", import.meta.url)) },
      });
    },
    getAllTools: () => tools,
    getActiveTools: () => tools.map((tool) => tool.name),
    getCommands: () => [],
    getThinkingLevel: () => "off",
    setActiveTools() {},
    getMcpServers: () => [],
    registerMcpServer() {},
  };
  tools.push({ name: "tool_search", exposure: "visible", sourceInfo: { path: "builtin" } });
  security(pi);
  return {
    handlers,
    call: (name, ...args) => callHandlers(handlers, name, ...args),
    enableMcp: () => (mcpEnabled = true),
    rendererCount: () => renderers,
    service() {
      let value;
      for (const handler of events.get("pi-security:service:v1") ?? [])
        handler({ version: 1, respond: (service) => (value = service) });
      assert(value);
      return value;
    },
  };
}
async function fixture(mode, run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-mode-"))),
    saved = { env: { ...process.env }, cwd: process.cwd() };
  const project = join(root, "project"),
    tmp = join(root, "tmp"),
    agent = join(root, "agent");
  try {
    await Promise.all([project, tmp, agent].map((dir) => mkdir(dir)));
    Object.assign(process.env, {
      HOME: root,
      PI_SECURITY_ACTIVATION: "active",
      PI_SECURITY_PLACEMENT: "host",
      PI_SECURITY_TRANSPORT: "internal",
      PI_CODING_AGENT_DIR: agent,
      PI_SECURITY_POLICY: join(agent, "policy.json"),
      PI_SECURITY_TMP: tmp,
    });
    delete process.env.PI_SUBAGENT;
    delete process.env.PI_POLICY_LAUNCH;
    process.chdir(project);
    const value = policy();
    value.mode = mode;
    await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(value));
    await run(project);
  } finally {
    process.chdir(saved.cwd);
    process.env = saved.env;
    await rm(root, { recursive: true, force: true });
  }
}
function context(cwd, counters = { asks: 0, lookups: 0 }) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify() {
        // The native MCP factory may surface a diagnostic while the fixture has no configured servers.
      },
      setStatus() {},
      select: async () => {
        counters.asks++;
        return "Deny";
      },
    },
    modelRegistry: {
      getAvailable: () => [],
      getModelsOfType: () => {
        counters.lookups++;
        return [];
      },
      getAll: () => [],
    },
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "fixture" },
    isProjectTrusted: () => true,
  };
}

test("parent explicit auto/manual modes override policy and choose the matching resolver without inference", async () => {
  for (const [configured, selected, expected] of [
    ["manual", "auto", "auto"],
    ["auto", "manual", "manual"],
    ["auto", undefined, "auto"],
    ["manual", undefined, "manual"],
  ])
    await fixture(configured, async (cwd) => {
      const counters = { asks: 0, lookups: 0 },
        ctx = context(cwd, counters),
        extension = api(selected);
      try {
        assert.equal(
          extension.rendererCount(),
          1,
          "active host composes native MCP before CLI flags parse",
        );
        extension.enableMcp();
        await extension.call("session_start", {}, ctx);
        const launch = await extension
          .service()
          .prepareChildLaunch({ task: "mode inheritance fixture" });
        assert.equal(launch.parentLoaded.policy.mode, expected);
        assert.equal(launch.childLoaded.policy.mode, expected);
        const refusal = await extension.call(
          "tool_call",
          { toolName: "bash", toolCallId: "unmatched", input: { command: "printf fixture" } },
          ctx,
        );
        assert.equal(refusal.block, true);
        assert.equal(counters.asks, expected === "manual" ? 1 : 0);
        assert.equal(counters.lookups, expected === "auto" ? 1 : 0);
        await launch.cleanup();
      } finally {
        await extension.call("session_shutdown");
      }
    });
});

test("child argv modes cannot alter protected inherited or manually narrowed policy", async () => {
  for (const [configured, narrowed, childFlag, expected] of [
    ["manual", undefined, "auto", "manual"],
    ["auto", "manual", "auto", "manual"],
    ["auto", undefined, "manual", "auto"],
  ])
    await fixture(configured, async (cwd) => {
      const parent = api(undefined);
      let child, launch, grandchild;
      try {
        assert.equal(parent.rendererCount(), 1);
        parent.enableMcp();
        await parent.call("session_start", {}, context(cwd));
        launch = await parent.service().prepareChildLaunch({
          task: "protected child",
          ...(narrowed ? { permissionMode: narrowed } : {}),
        });
        Object.assign(process.env, launch.env);
        process.chdir(launch.cwd);
        child = api(childFlag);
        assert.equal(child.rendererCount(), 0, "subagent does not compose host MCP factory");
        child.enableMcp();
        await child.call("session_start", {}, context(launch.cwd));
        grandchild = await child
          .service()
          .prepareChildLaunch({ task: "inspect protected mode through actual launch" });
        assert.equal(grandchild.parentLoaded.policy.mode, expected);
        assert.equal(grandchild.childLoaded.policy.mode, expected);
      } finally {
        await grandchild?.cleanup();
        await child?.call("session_shutdown");
        await launch?.cleanup();
        await parent.call("session_shutdown");
      }
    });
});

test("shadow placement never composes the native MCP factory", async () =>
  fixture("auto", async () => {
    process.env.PI_SECURITY_ACTIVATION = "shadow";
    const extension = api(undefined);
    assert.equal(extension.rendererCount(), 0);
  }));
