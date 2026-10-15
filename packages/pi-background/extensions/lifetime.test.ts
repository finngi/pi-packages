import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./background-process.ts";

type Handler = (value: any) => unknown;
function harness(options: { activeTools?: string[]; defaultTools?: string[] } = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  let prepared: any;
  let prepareHook: (() => Promise<unknown>) | undefined;
  let released = 0;
  let activeTools = options.activeTools ?? ["bash"];
  const addHandler = (name: string, handler: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  const events = {
    on: addHandler,
    emit(name: string, value: any) {
      if (name === "pi-security:presence:v1") {
        value.respond(false);
        return;
      }
      if (name === "pi-security:service:v1") {
        value.respond({
          version: 1,
          prepareShell: async () => {
            if (prepareHook) await prepareHook();
            return prepared;
          },
          prepareChildLaunch: async () => {
            throw new Error("unused");
          },
          handleChildAsk: async () => {
            throw new Error("unused");
          },
        });
        return;
      }
      for (const handler of handlers.get(name) ?? []) handler(value);
    },
  };
  const api = {
    on: addHandler,
    events,
    registerTool(tool: any) {
      tools.push(tool);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getSettings() {
      return { defaultTools: options.defaultTools };
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return {
    emit: (name: string, value: unknown) => events.emit(name, value),
    async start() {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
    },
    events,
    tools,
    get activeTools() {
      return [...activeTools];
    },
    commands,
    prepare(command: string, script: string) {
      prepared = {
        argv: [command, "-e", script],
        env: process.env,
        cwd: process.cwd(),
        assertCurrent() {},
        release: async () => {
          released++;
        },
      };
    },
    delayPreparation(hook: () => Promise<unknown>) {
      prepareHook = hook;
    },
    get released() {
      return released;
    },
  };
}

const getTool = (app: ReturnType<typeof harness>) =>
  app.tools.find((entry) => entry.name === "background_process");
const wait = async (fn: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};

test("resource discovery does not install process lifetime handlers before a session starts", () => {
  const before = process.listenerCount("exit");
  harness();
  assert.equal(process.listenerCount("exit"), before);
});

test("security-off Bash uses managed host execution and preserves result accounting", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  delete process.env.PI_SECURITY_TRANSPORT;
  const app = harness();
  await app.start();
  const bash = app.tools.find((entry) => entry.name === "bash");
  assert.ok(bash, "pi-background must replace the stock bash tool when security is off");
  try {
    const result = await bash.execute(
      "plain-bash",
      { command: "printf 'host-out\\n'; printf 'host-err\\n' >&2; exit 7" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
      },
    );
    assert.equal(result.structuredContent.exit_code, 7);
    assert.equal(typeof result.structuredContent.wall_time_seconds, "number");
    assert.match(result.structuredContent.output, /host-out/);
    assert.match(result.structuredContent.output, /host-err/);
    const jobs = await getTool(app).execute("jobs", { action: "list" });
    assert.equal(jobs.details[0].mode, "host");
    assert.equal(jobs.details[0].status, "failed");
  } finally {
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});

test("security-off Bash yields on abort without killing its managed host process", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  delete process.env.PI_SECURITY_TRANSPORT;
  const app = harness();
  await app.start();
  const bash = app.tools.find((entry) => entry.name === "bash");
  const controller = new AbortController();
  let id: string | undefined;
  try {
    const resultPromise = bash.execute(
      "yield-bash",
      { command: "printf 'ready\\n'; sleep 1; printf 'finished\\n'" },
      controller.signal,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
      },
    );
    await wait(async () => {
      const jobs = await getTool(app).execute("jobs", { action: "list" });
      id = jobs.details[0]?.id;
      if (!id) return false;
      const read = await getTool(app).execute("read", { action: "read", id });
      return /ready/.test(read.content[0]?.text ?? "");
    });
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.structuredContent.exit_code, 0);
    assert.match(result.structuredContent.output, /continuing in the background/);
    const status = await getTool(app).execute("status", { action: "status", id });
    assert.equal(status.details.status, "running");
    assert.equal(status.details.mode, "host");
    const read = await getTool(app).execute("read-again", { action: "read", id });
    assert.match(read.content[0]?.text ?? "", /ready/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const finished = await getTool(app).execute("finished", { action: "status", id });
    assert.equal(finished.details.status, "completed");
    assert.ok(finished.details.outputBytes > status.details.outputBytes);
  } finally {
    if (id)
      await getTool(app)
        .execute("cleanup", { action: "cancel", id })
        .catch(() => {});
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});

test("selected security without a secured Bash provider refuses instead of falling back", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  process.env.PI_SECURITY_TRANSPORT = "extensions";
  const app = harness();
  await app.start();
  const bash = app.tools.find((entry) => entry.name === "bash");
  assert.ok(bash);
  try {
    await assert.rejects(
      bash.execute("no-fallback", { command: "printf 'must not execute'" }, undefined, undefined, {
        cwd: process.cwd(),
      }),
      /Security is selected, but the secured Bash tool is unavailable/,
    );
  } finally {
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});

test("late tools remain inactive and preserve the complete existing tool selection", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  const oldArgs = [...process.argv];
  delete process.env.PI_SECURITY_TRANSPORT;
  const app = harness({ activeTools: ["read"] });
  process.argv.push("--tools", "read");
  try {
    await app.start();
    assert.deepEqual(app.activeTools, ["read"]);
    assert.equal(app.tools.find((tool) => tool.name === "bash")?.defaultActive, false);
    assert.equal(
      app.tools.find((tool) => tool.name === "background_process")?.defaultActive,
      false,
    );
  } finally {
    process.argv.splice(0, process.argv.length, ...oldArgs);
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});

test("native defaultTools are not treated as an allowlist by the extension", async () => {
  const app = harness({ activeTools: ["read", "write", "agent_message", "goal_tool"] });
  await app.start();
  assert.deepEqual(app.activeTools, ["read", "write", "agent_message", "goal_tool"]);
  assert.equal(app.tools.find((tool) => tool.name === "bash")?.defaultActive, false);
  assert.equal(app.tools.find((tool) => tool.name === "background_process")?.defaultActive, false);
});

async function startLongShell() {
  const old = process.env.PI_SECURITY_TRANSPORT;
  process.env.PI_SECURITY_TRANSPORT = "extensions";
  const app = harness();
  await app.start();
  app.prepare(
    process.execPath,
    "console.log(process.pid); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
  );
  let transport: any;
  app.emit("pi-security:transport:v1", {
    version: 1,
    respond: (value: any) => (transport = value),
  });
  const controller = new AbortController();
  const shellPromise = transport.startShell({
    toolCallId: "call-1",
    input: { command: "long-running fixture" },
    cwd: process.cwd(),
    foreground: true,
    signal: controller.signal,
  });
  await wait(async () => {
    const jobs = app.tools.find((entry) => entry.name === "background_process");
    return Boolean(jobs);
  });
  return {
    app,
    shellPromise,
    controller,
    deferPrepare(prepare: () => Promise<unknown>) {
      const prior = prepared;
      prepared = undefined;
      return {
        prior,
        set: (value: unknown) => {
          prepared = value;
        },
      };
    },
    get released() {
      return app.released;
    },
    restore() {
      if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
      else process.env.PI_SECURITY_TRANSPORT = old;
    },
  };
}

test("steer input yields a live shell, keeps output and security lease, then cancel cleans up", async () => {
  const run = await startLongShell();
  let id: string | undefined;
  try {
    await wait(async () => {
      const listed = await getTool(run.app).execute("find", { action: "list" });
      id = listed.details[0]?.id;
      if (!id) return false;
      const status = await getTool(run.app).execute("status", { id, action: "status" });
      if (status.details.outputBytes === 0) return false;
      const output = await getTool(run.app).execute("read", { id, action: "read" });
      return /ready/.test(output.content[0]?.text ?? "");
    });
    run.app.emit("input", {
      source: "interactive",
      streamingBehavior: "steer",
      text: "inspect this",
    });
    const result = await run.shellPromise;
    id = result.details.id;
    assert.equal(result.details.yielded, true);
    const status = await getTool(run.app).execute("tool-1", { id, action: "status" });
    assert.equal(status.details.status, "running");
    const output = await getTool(run.app).execute("tool-2", { id, action: "read" });
    assert.match(output.content[0].text, /ready/);
    assert.equal(run.released, 0);
    await getTool(run.app).execute("tool-3", { id, action: "cancel" });
    await wait(() => run.released > 0);
    const final = await getTool(run.app).execute("tool-4", { id, action: "status" });
    assert.equal(final.details.status, "cancelled");
  } finally {
    if (id) {
      try {
        await getTool(run.app).execute("cleanup", { id, action: "cancel" });
      } catch {}
    }
    await wait(() => run.released > 0).catch(() => {});
    run.restore();
  }
});

test("abort after spawn yields without killing the process", async () => {
  const run = await startLongShell();
  let id: string | undefined;
  try {
    run.controller.abort();
    const result = await run.shellPromise;
    id = result.details.id;
    assert.equal(result.details.yielded, true);
    const status = await getTool(run.app).execute("tool-1", { id, action: "status" });
    assert.equal(status.details.status, "running");
    await getTool(run.app).execute("tool-2", { id, action: "cancel" });
    await wait(() => run.released > 0);
  } finally {
    if (id) {
      try {
        await getTool(run.app).execute("cleanup", { id, action: "cancel" });
      } catch {}
    }
    await wait(() => run.released > 0).catch(() => {});
    run.restore();
  }
});

test("foreground shell reports the underlying spawn failure", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  process.env.PI_SECURITY_TRANSPORT = "extensions";
  const app = harness();
  app.prepare("/no-such-pi-security-shell-fixture", "");
  let transport: any;
  app.emit("pi-security:transport:v1", {
    version: 1,
    respond: (value: any) => (transport = value),
  });
  try {
    const result = await transport.startShell({
      toolCallId: "spawn-error",
      input: { command: "missing executable" },
      cwd: process.cwd(),
      foreground: true,
    });
    assert.equal(result.details.exit_code, 1);
    assert.match(result.details.reason, /ENOENT/);
    assert.match(result.content[0].text, /Process detail: .*ENOENT/);
    await wait(() => app.released > 0);
  } finally {
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});

test("session replacement during security preparation cannot launch into the replacement session", async () => {
  const old = process.env.PI_SECURITY_TRANSPORT;
  process.env.PI_SECURITY_TRANSPORT = "extensions";
  const app = harness();
  app.prepare(process.execPath, "process.stdout.write('must not run')");
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.delayPreparation(async () => {
    entered();
    await gate;
  });
  let transport: any;
  app.emit("pi-security:transport:v1", {
    version: 1,
    respond: (value: any) => {
      transport = value;
    },
  });
  try {
    const request = transport.startShell({
      toolCallId: "stale-shell",
      input: { command: "ignored" },
      cwd: process.cwd(),
      foreground: true,
    });
    request.catch(() => {});
    await preparing;
    await app.emit("session_start", {});
    release();
    await assert.rejects(request, /ended session/);
    assert.equal(app.released, 1);
  } finally {
    release();
    await app.emit("session_shutdown", {});
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
  }
});
