import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./background-process.ts";

type Handler = (...args: any[]) => unknown;
function harness(activeTools = ["bash"]) {
  const handlers = new Map<string, Handler[]>(),
    tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const add = (name: string, handler: Handler) =>
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  const events = {
    on: add,
    emit(name: string, value: any) {
      for (const handler of handlers.get(name) ?? []) handler(value);
    },
  };
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined },
    ui: { notify() {} },
  };
  const pi = {
    on: add,
    events,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getActiveTools: () => [...activeTools],
    sendMessage() {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return {
    tools,
    commands,
    ctx,
    events,
    async hook(name: string) {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
    service() {
      let service: any;
      events.emit("background:service", {
        respond: (value: any) => {
          service = value;
        },
      });
      return service;
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Timed out waiting for process state");
}
const jobs = (app: ReturnType<typeof harness>, input: any) =>
  app.tools.get("background_process").execute("jobs", input);
const bash = (
  app: ReturnType<typeof harness>,
  command: string,
  signal?: AbortSignal,
  background = false,
) => app.tools.get("bash").execute("shell", { command, background }, signal, undefined, app.ctx);

test("discovery installs no exit listener before the native session starts", () => {
  const before = process.listenerCount("exit");
  harness();
  assert.equal(process.listenerCount("exit"), before);
});

test("native Bash retains stdout, stderr, exit code and timing", async () => {
  const app = harness();
  await app.hook("session_start");
  try {
    const result = await bash(app, "printf 'host-out\\n'; printf 'host-err\\n' >&2; exit 7");
    assert.equal(result.structuredContent.exit_code, 7);
    assert.equal(typeof result.structuredContent.wall_time_seconds, "number");
    assert.match(result.structuredContent.output, /host-out/);
    assert.match(result.structuredContent.output, /host-err/);
    const listed = await jobs(app, { action: "list" });
    assert.equal(listed.details[0].owner, "bash");
    assert.equal(listed.details[0].status, "failed");
  } finally {
    await app.hook("session_shutdown");
  }
});

for (const mode of ["abort", "steer", "command"] as const) {
  test(`${mode} yields a foreground command without killing its job`, async () => {
    const app = harness();
    await app.hook("session_start");
    const controller = new AbortController();
    let id: string | undefined;
    try {
      const running = bash(app, "printf 'ready\\n'; sleep 60", controller.signal);
      await until(async () => {
        const listed = await jobs(app, { action: "list" });
        id = listed.details[0]?.id;
        return !!id && /ready/.test((await jobs(app, { action: "read", id })).content[0].text);
      });
      if (mode === "abort") controller.abort();
      else if (mode === "steer")
        app.events.emit("input", {
          source: "interactive",
          streamingBehavior: "steer",
          text: "inspect this",
        });
      else await app.commands.get("background").handler("", app.ctx);
      const result = await running;
      assert.match(result.structuredContent.output, /continuing in the background/);
      assert.equal((await jobs(app, { action: "status", id })).details.status, "running");
      assert.match((await jobs(app, { action: "read", id })).content[0].text, /ready/);
      await jobs(app, { action: "cancel", id });
      await until(
        async () => (await jobs(app, { action: "status", id })).details.status === "cancelled",
      );
    } finally {
      await app.hook("session_shutdown");
    }
  });
}

test("native tool filters keep late registrations inactive", async () => {
  const app = harness(["read", "write", "agent_message"]);
  await app.hook("session_start");
  try {
    assert.equal(app.tools.get("bash").defaultActive, false);
    assert.equal(app.tools.get("background_process").defaultActive, false);
  } finally {
    await app.hook("session_shutdown");
  }
});

test("session replacement closes jobs and stale services cannot affect new work", async () => {
  const app = harness();
  await app.hook("session_start");
  const old = app.service();
  try {
    const first = await bash(app, "printf first; sleep 60", undefined, true);
    await app.hook("session_start");
    assert.throws(() => old.status(first.details.id), /ended session/);
    assert.throws(() => old.launch({}), /ended session/);
    await assert.rejects(jobs(app, { action: "read", id: first.details.id }), /Unknown|unknown/);
    const next = await bash(app, "printf next; sleep 60", undefined, true);
    await old.close();
    assert.equal(
      (await jobs(app, { action: "status", id: next.details.id })).details.status,
      "running",
    );
  } finally {
    await app.hook("session_shutdown");
  }
  await assert.rejects(jobs(app, { action: "list" }), /closed/);
});

test("trusted process service preserves spawn failures", async () => {
  const app = harness();
  await app.hook("session_start");
  try {
    const run = app.service().launch(
      {
        command: "/no-such-pi-background-executable",
        args: [],
        cwd: process.cwd(),
        owner: "fixture",
        label: "missing",
      },
      { notify: false },
    );
    const result = await run.done;
    assert.equal(result.status, "failed");
    assert.match(result.reason, /ENOENT/);
  } finally {
    await app.hook("session_shutdown");
  }
});
