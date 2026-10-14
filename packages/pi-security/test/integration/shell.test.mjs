import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import security from "../../src/extension.ts";
import { wallScope } from "../../src/wall-scope.ts";
import { policy } from "../skeleton/fixture.mjs";

test("initialized shell capability consumes exact binding, protects profiles and scrubs launch controls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-i-shell-")),
    saved = { ...process.env };
  const project = path.join(root, "project"),
    tmp = path.join(root, "tmp"),
    agent = path.join(root, "agent");
  await Promise.all([project, tmp, agent].map((p) => mkdir(p, { recursive: true })));
  Object.assign(process.env, {
    HOME: root,
    PI_SECURITY_ACTIVATION: "active",
    PI_SECURITY_PLACEMENT: "host",
    PI_CODING_AGENT_DIR: agent,
    PI_SECURITY_POLICY: path.join(agent, "policy.json"),
    PI_SECURITY_TMP: tmp,
    PI_SECURITY_MCP: path.join(agent, "mcp-fixture.json"),
    DUMMY_API_KEY: "fixture-secret-that-must-not-reach-shell-tools",
    DATABASE_URL: "postgres://fixture:secret@localhost/private",
    REDIS_URL: "redis://fixture:secret@localhost/0",
    SENTRY_DSN: "https://fixture-secret@example.invalid/1",
    STRIPE_KEY: "sk_fixture_secret",
    AWS_SECRET_ACCESS_KEY: "fixture-secret",
    MONGODB_URI: "mongodb://fixture:secret@localhost/private",
    GITHUB_PAT: "fixture-personal-access-token",
    PIP_INDEX_URL: "https://user:dummy-password@example.invalid/simple",
    PIP_EXTRA_INDEX_URL: "https://user:dummy-password@example.invalid/extra",
    UV_INDEX_URL: "https://user:dummy-password@example.invalid/simple",
    UV_EXTRA_INDEX_URL: "https://user:dummy-password@example.invalid/extra",
    PGPASSWORD: "fixture-postgres-password",
    MYSQL_PWD: "fixture-mysql-password",
    CUDA_VISIBLE_DEVICES: "7",
    LD_PRELOAD: "/tmp/untrusted-preload.so",
    LD_AUDIT: "/tmp/untrusted-audit.so",
    LD_LIBRARY_PATH: "/tmp/untrusted-libraries",
    LD_ORIGIN_PATH: "/tmp/untrusted-origin",
  });
  delete process.env.PI_POLICY_LAUNCH;
  delete process.env.PI_SUBAGENT;
  const alias = path.join(root, "security-entry.mjs");
  await symlink(fileURLToPath(new URL("../../src/extension.ts", import.meta.url)), alias);
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
      emit(name, value) {
        for (const handler of events.get(name) ?? []) handler(value);
      },
      on: (name, fn) => addHandler(events, name, fn),
    },
    registerToolRenderer() {
      renderers++;
    },
    registerFlag() {},
    registerCommand() {},
    getFlag(name) {
      return name === "security-mcp" ? mcpEnabled : undefined;
    },
    appendEntry() {},
    registerTool(t) {
      tools.push({ ...t, sourceInfo: { path: alias } });
    },
    getAllTools: () => tools,
    getActiveTools: () =>
      tools.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name),
    getMcpServers: () => [],
    registerMcpServer() {},
    setActiveTools() {},
  };
  tools.push({ name: "tool_search", sourceInfo: { path: "builtin" } });
  try {
    await writeFile(process.env.PI_SECURITY_POLICY, JSON.stringify(policy()));
    await writeFile(process.env.PI_SECURITY_MCP, '{"servers":{}}');
    security(pi);
    assert.equal(renderers, 1, "active host composes MCP before the flag value is available");
    mcpEnabled = true;
    let service;
    const discover = () => {
      for (const handler of events.get("pi-security:service:v1") ?? [])
        handler({ version: 1, respond: (s) => (service = s) });
    };
    discover();
    assert.equal(service, undefined);
    const ctx = {
      cwd: project,
      ui: { setStatus() {}, notify() {} },
      sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "fixture" },
      modelRegistry: { getAvailable: () => [], getModelsOfType: () => [], getAll: () => [] },
      isProjectTrusted: () => true,
    };
    await callHandlers(handlers, "session_start", {}, ctx);
    discover();
    assert.ok(service);
    const input = { command: "touch inside" };
    await callHandlers(
      handlers,
      "tool_call",
      { toolName: "bash", toolCallId: "bound", input },
      ctx,
    );
    process.env.PI_POLICY_LAUNCH = "must-not-inherit";
    const capability = await service.prepareShell({ toolCallId: "bound", input, cwd: project });
    assert.equal(capability.argv[0], "/usr/bin/sandbox-exec");
    assert.ok(capability.argv[2].includes("launch"));
    assert.equal(capability.env.PI_POLICY_LAUNCH, undefined);
    assert.equal(capability.env.DUMMY_API_KEY, undefined, "common credential names are filtered");
    for (const name of [
      "DATABASE_URL",
      "REDIS_URL",
      "SENTRY_DSN",
      "STRIPE_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "MONGODB_URI",
      "GITHUB_PAT",
      "PIP_INDEX_URL",
      "PIP_EXTRA_INDEX_URL",
      "UV_INDEX_URL",
      "UV_EXTRA_INDEX_URL",
      "PGPASSWORD",
      "MYSQL_PWD",
      "LD_PRELOAD",
      "LD_AUDIT",
      "LD_LIBRARY_PATH",
      "LD_ORIGIN_PATH",
    ])
      assert.equal(capability.env[name], undefined, `${name} is not inherited by shell tools`);
    assert.equal(capability.env.CUDA_VISIBLE_DEVICES, "7", "GPU selection remains available");
    await access(capability.argv[2]);
    await capability.release();
    await assert.rejects(access(capability.argv[2]));
    await capability.release();
    await assert.rejects(service.prepareShell({ toolCallId: "bound", input, cwd: project }));
    await callHandlers(
      handlers,
      "tool_call",
      { toolName: "bash", toolCallId: "mutated", input },
      { cwd: project },
    );
    await assert.rejects(
      service.prepareShell({
        toolCallId: "mutated",
        input: { command: "touch other" },
        cwd: project,
      }),
    );
    await assert.rejects(
      service.prepareShell({
        toolCallId: "x",
        input,
        cwd: project,
        decision: { permissions: { write: true, network: [["example.com"]] } },
      }),
    );
    await callHandlers(
      handlers,
      "tool_call",
      { toolName: "bash", toolCallId: "revoked", input },
      ctx,
    );
    const revoked = await service.prepareShell({ toolCallId: "revoked", input, cwd: project });
    await callHandlers(handlers, "input", {
      source: "interactive",
      text: "Stop; do not run that command.",
    });
    assert.throws(() => revoked.assertCurrent(), /user instructions changed/);
    await revoked.release();
    await callHandlers(
      handlers,
      "tool_call",
      { toolName: "bash", toolCallId: "pending-revoked", input },
      ctx,
    );
    await callHandlers(handlers, "input", { source: "interactive", text: "Stop again." });
    await assert.rejects(
      service.prepareShell({ toolCallId: "pending-revoked", input, cwd: project }),
      /input differs/,
    );
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(project, "link"));
    await assert.rejects(
      wallScope(
        "write",
        { path: "link/file" },
        { project, filesystem: { writeAllow: [project], writeDeny: [], readDeny: [] } },
      ),
    );
  } finally {
    await callHandlers(handlers, "session_shutdown");
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test("wall file admission applies the shared Git and explicit-denial policy", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-wall-git-")));
  try {
    const loaded = {
      project: root,
      filesystem: { writeAllow: [root], writeDeny: [], readDeny: [] },
    };
    await wallScope("write", { path: path.join(root, ".git/config") }, loaded);
    await wallScope("write", { path: path.join(root, ".git/hooks/pre-commit") }, loaded);
    loaded.filesystem.writeDeny.push(path.join(root, ".git"));
    await assert.rejects(
      wallScope("write", { path: path.join(root, ".git/config") }, loaded),
      /wall path denied/,
    );
    await assert.rejects(
      wallScope("write", { path: path.join(root, "AGENTS.md") }, loaded),
      /outside permitted/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
