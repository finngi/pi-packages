import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runToolCall } from "@earendil-works/pi-agent-core";
import security from "../../src/extension.ts";
import { policy } from "../skeleton/fixture.mjs";

const auditType = "pi-security.audit.v1";
const addHandler = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
const callHandlers = async (map, name, ...args) => {
  let result;
  for (const handler of map.get(name) ?? []) {
    const next = await handler(...args);
    if (next !== undefined && result === undefined) result = next;
  }
  return result;
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-audit-")));
  const saved = { env: { ...process.env }, cwd: process.cwd() };
  const dirs = Object.fromEntries(
    ["home", "agent", "project", "tmp", "sessions"].map((name) => [name, join(root, name)]),
  );
  try {
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir)));
    Object.assign(process.env, {
      HOME: dirs.home,
      PI_CODING_AGENT_DIR: dirs.agent,
      PI_SECURITY_ACTIVATION: "active",
      PI_SECURITY_PLACEMENT: "host",
      PI_SECURITY_TRANSPORT: "internal",
      PI_SECURITY_POLICY: join(dirs.agent, "policy.json"),
      PI_SECURITY_TMP: dirs.tmp,
      XDG_CONFIG_HOME: join(dirs.home, ".config"),
    });
    delete process.env.PI_SUBAGENT;
    delete process.env.PI_POLICY_LAUNCH;
    process.chdir(dirs.project);
    await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(policy()));
    await run(dirs);
  } finally {
    process.chdir(saved.cwd);
    process.env = saved.env;
    await rm(root, { recursive: true, force: true });
  }
}
async function capture(run) {
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  let out = "",
    err = "";
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    const callback = rest.find((x) => typeof x === "function");
    callback?.();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    err += String(chunk);
    const callback = rest.find((x) => typeof x === "function");
    callback?.();
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.equal(out, "", "healthy tool calls must not write raw stdout");
  assert.equal(err, "", "healthy tool calls must not write raw stderr");
}

test("stock tool calls persist bounded audit entries without terminal output, UI renderer or model context", async () =>
  fixture(async (dirs) => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const runtime = await sdk.ModelRuntime.create({
      modelsPath: null,
      modelsStorePath: join(dirs.tmp, "models.json"),
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
      cwd: dirs.project,
      agentDir: dirs.agent,
      settingsManager: settings,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../src/extension.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = sdk.SessionManager.create(dirs.project, dirs.sessions);
    manager.appendMessage({
      role: "user",
      content: "offline audit fixture",
      timestamp: Date.now(),
    });
    const { session } = await sdk.createAgentSession({
      cwd: dirs.project,
      agentDir: dirs.agent,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: manager,
      noTools: "builtin",
    });
    const events = [],
      notices = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "entry_appended") events.push(event.entry);
    });
    try {
      await capture(async () => {
        await session.bindExtensions({
          onError: (error) => {
            throw Error(JSON.stringify(error));
          },
          uiContext: {
            select: async () => {
              throw Error("unexpected approval");
            },
            notify: (...args) => notices.push(args),
            setStatus() {},
            setWidget() {},
          },
        });
        for (const [id, command, isError] of [
          ["allowed", "touch audit-file", false],
          ["denied", "cat secret.txt", true],
          ["executed", "cat audit-file", false],
        ]) {
          const tools = session.agent.state.tools;
          const call = { type: "toolCall", id, name: "bash", arguments: { command } };
          const assistantMessage = {
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
            tools,
            assistantMessage,
            context: { messages: [], tools },
            beforeToolCall: session.agent.beforeToolCall,
          });
          assert.equal(outcome.isError, isError, JSON.stringify(outcome.result));
        }
      });
      assert.deepEqual(notices, [
        [
          "MCP servers need attention:\n  config: Native MCP is disabled. Restart Pi with --security-mcp to enable secured HTTP MCP.\nRun /mcp to fix.",
          "warning",
        ],
      ]);
      assert.equal(session.extensionRunner.getEntryRenderer(auditType), undefined);
      const entries = manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === auditType);
      assert.equal(entries.length, 6);
      assert.deepEqual(
        entries.map((entry) => entry.data.event),
        ["initialized", "decision", "execution", "decision", "decision", "execution"],
      );
      assert.equal(entries[3].data.verdict, "deny");
      assert.deepEqual(entries[3].data.ruleIds, ["deny-cat-secret"]);
      assert.equal(
        events.filter((entry) => entry.type === "custom" && entry.customType === auditType).length,
        6,
      );
      for (const entry of entries) {
        assert.match(entry.data.policyHash, /^[a-f0-9]{12}$/);
        if (entry.data.event === "decision") assert.match(entry.data.inputHash, /^[a-f0-9]{12}$/);
        assert.deepEqual(
          Object.keys(entry.data).filter(
            (key) =>
              ![
                "event",
                "policyHash",
                "toolCallId",
                "toolName",
                "verdict",
                "permissions",
                "extraWritePathCount",
                "ruleIds",
                "inputHash",
                "exitCode",
              ].includes(key),
          ),
          [],
        );
      }
      const persisted = (await readFile(manager.getSessionFile(), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "custom" && entry.customType === auditType);
      assert.equal(persisted.length, 6);
      assert(!JSON.stringify(persisted).includes("secret.txt"));
      assert(!JSON.stringify(persisted).includes(dirs.project));
      const context = manager.buildSessionContext();
      assert(!JSON.stringify(context.messages).includes(auditType));
      assert(!JSON.stringify(context.messages).includes("inputHash"));
    } finally {
      unsubscribe();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
  }));

for (const failAt of ["initialization", "decision"])
  test(`audit failure during ${failAt} notifies UI and blocks effect dispatch`, async () =>
    fixture(async (dirs) => {
      const handlers = new Map(),
        tools = [],
        notices = [];
      let fail = failAt === "initialization",
        executions = 0;
      tools.push({ name: "tool_search", exposure: "visible", sourceInfo: { path: "builtin" } });
      const pi = {
        on: (name, fn) => addHandler(handlers, name, fn),
        events: {
          emit() {},
          on() {},
        },
        registerToolRenderer() {},
        registerFlag() {},
        registerCommand() {},
        getFlag(name) {
          return name === "security-mcp" ? true : undefined;
        },
        registerTool(tool) {
          tools.push({
            ...tool,
            sourceInfo: { path: fileURLToPath(new URL("../../src/extension.ts", import.meta.url)) },
          });
        },
        getAllTools: () => tools,
        getActiveTools: () => tools.map((tool) => tool.name),
        getMcpServers: () => [],
        registerMcpServer() {},
        setActiveTools() {},
        appendEntry() {
          if (fail) throw Error("private storage error");
        },
      };
      const ctx = {
        cwd: dirs.project,
        isProjectTrusted: () => true,
        sessionManager: {
          getEntries: () => [],
          getBranch: () => [],
          getSessionId: () => "fixture",
        },
        modelRegistry: { getAvailable: () => [], getModelsOfType: () => [], getAll: () => [] },
        ui: { notify: (...args) => notices.push(args), setStatus() {} },
      };
      security(pi);
      try {
        await capture(async () => {
          await callHandlers(handlers, "session_start", {}, ctx);
          fail = true;
          const refusal = await callHandlers(
            handlers,
            "tool_call",
            { toolName: "bash", toolCallId: "blocked", input: { command: "touch audit-file" } },
            ctx,
          );
          assert.equal(refusal.block, true);
          assert.match(refusal.reason, /audit unavailable/);
          if (!refusal.block) executions++;
        });
        assert.equal(executions, 0);
        assert(notices.some(([text]) => text.includes("audit unavailable")));
        assert(!JSON.stringify(notices).includes("private storage error"));
      } finally {
        await callHandlers(handlers, "session_shutdown");
      }
    }));

test("shadow comparisons keep hashes and verdicts without serializing inputs or printing logs", async () =>
  fixture(async (dirs) => {
    process.env.PI_SECURITY_ACTIVATION = "shadow";
    const handlers = new Map(),
      entries = [];
    const pi = {
      registerCommand() {},
      on: (name, fn) => addHandler(handlers, name, fn),
      events: { emit() {}, on() {} },
      getAllTools: () => [],
      getFlag() {},
      appendEntry: (type, data) => entries.push({ type, data }),
    };
    const ctx = {
      cwd: dirs.project,
      sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "fixture" },
      ui: {
        notify() {
          throw Error("unexpected notification");
        },
        setStatus() {},
      },
    };
    security(pi);
    try {
      await capture(async () => {
        await callHandlers(handlers, "session_start", {}, ctx);
        assert.equal(
          await callHandlers(
            handlers,
            "tool_call",
            { toolName: "bash", toolCallId: "shadow", input: { command: "cat secret.txt" } },
            ctx,
          ),
          undefined,
        );
      });
      assert.deepEqual(
        entries.map((entry) => entry.data.event),
        ["initialized", "shadow"],
      );
      assert.equal(entries[1].data.verdict, "deny");
      assert.equal(entries[1].type, auditType);
      assert(!JSON.stringify(entries).includes("secret.txt"));
    } finally {
      await callHandlers(handlers, "session_shutdown");
    }
  }));
