import assert from "node:assert/strict";
import test from "node:test";
import { restrictionSpec } from "./child-launch.ts";
import { resolveSettings } from "./settings.ts";

const agent = {
  name: "fixture",
  description: "fixture",
  body: "trusted-body",
  filePath: "/fixture",
};
test("instructions and task stay separate and explicit empty resources are preserved", () => {
  assert.deepEqual(restrictionSpec({ ...agent, tools: [], skills: [] }, "untrusted-task"), {
    task: "untrusted-task",
    instructions: "trusted-body",
    tools: [],
    skills: [],
  });
  assert.deepEqual(restrictionSpec(agent, "task"), {
    task: "task",
    instructions: "trusted-body",
  });
});

test("omitted agent skills are made explicit from the selected parent skills", () => {
  const effective = resolveSettings(agent, {
    model: { provider: "fixture", id: "model" },
    available: [{ provider: "fixture", id: "model" }],
    tools: ["read"],
    skills: ["project-selected"],
  });
  assert.deepEqual(restrictionSpec(agent, "task", effective).skills, ["project-selected"]);
});

test("selected behavioral instructions pass separately from project context and agent instructions", () => {
  const staticContext = {
    originalCwd: "/parent/project",
    files: [],
    instructions: '<instruction path="/rules/careful.md">Check assumptions.</instruction>',
  };
  assert.deepEqual(restrictionSpec(agent, "task", undefined, staticContext), {
    task: "task",
    instructions: agent.body,
    staticContext,
  });
});

test("session expiry during async preparation refuses before transport spawn and cleans prepared state", async () => {
  let current = true,
    cleanups = 0,
    launches = 0;
  const security = {
    prepareChildLaunch: async () => {
      current = false;
      return {
        id: "launch",
        argv: ["pi"],
        env: {},
        cwd: "/fixture",
        tmp: "/fixture",
        cleanup: async () => {
          cleanups++;
        },
      };
    },
  } as unknown as import("pi-contracts").ChildLaunchService;
  const transport = {
    launch() {
      launches++;
      throw Error("should not spawn");
    },
  } as unknown as import("../background/service.ts").BackgroundService;
  const { launchChild } = await import("./child-launch.ts");
  await assert.rejects(
    launchChild({ launcher: security, transport, spec: {}, isCurrent: () => current }),
    /expired before spawn/,
  );
  assert.equal(cleanups, 1);
  assert.equal(launches, 0);
});

test("completed child cleanup tolerates an evicted private background-process record", async () => {
  let cleanupCallback: (() => Promise<void>) | undefined,
    cleanups = 0;
  const snapshot = {
    id: "process-chain-release-library",
    owner: "subagent",
    label: "fixture agent",
    mode: "",
    status: "completed" as const,
    exitCode: 0,
    signal: null,
    outputBytes: 0,
    retainedFrom: 0,
    executionExited: true,
    streamsClosed: true,
  };
  const launcher = {
    prepareChildLaunch: async () => ({
      id: "launch",
      argv: ["pi"],
      env: {},
      cwd: "/fixture",
      tmp: "/fixture",
      beforeCleanup(callback: () => Promise<void>) {
        cleanupCallback = callback;
      },
      async cleanup() {
        cleanups++;
        await cleanupCallback?.();
      },
    }),
  } as unknown as import("pi-contracts").ChildLaunchService;
  const transport = {
    launch: () => ({ id: snapshot.id, done: Promise.resolve(snapshot) }),
    cancel(id: string) {
      throw Error(`Unknown background process: ${id}`);
    },
  } as unknown as import("../background/service.ts").BackgroundService;
  const { launchChild } = await import("./child-launch.ts");

  const child = await launchChild({ launcher, transport, spec: {}, isCurrent: () => true });
  await assert.doesNotReject(() => child.close());
  assert.equal(cleanups, 1);
});

test("artifact collection failure still invokes child cleanup", async () => {
  let cleanupCallback: (() => Promise<void>) | undefined,
    cleanups = 0;
  const snapshot = {
    id: "process-quiet-river-lantern",
    owner: "subagent",
    label: "fixture agent",
    mode: "",
    status: "completed" as const,
    exitCode: 0,
    signal: null,
    outputBytes: 0,
    retainedFrom: 0,
    executionExited: true,
    streamsClosed: true,
  };
  const launcher = {
    prepareChildLaunch: async () => ({
      id: "launch",
      argv: ["pi"],
      env: {},
      cwd: "/fixture",
      tmp: "/fixture",
      workspaceKind: "scratch" as const,
      beforeCleanup(callback: () => Promise<void>) {
        cleanupCallback = callback;
      },
      async cleanup() {
        cleanups++;
        await cleanupCallback?.();
      },
    }),
  } as unknown as import("pi-contracts").ChildLaunchService;
  const transport = {
    launch: () => ({ id: snapshot.id, done: Promise.resolve(snapshot) }),
    cancel() {},
  } as unknown as import("../background/service.ts").BackgroundService;
  const { launchChild } = await import("./child-launch.ts");

  const child = await launchChild({
    launcher,
    transport,
    spec: {},
    isCurrent: () => true,
    artifactDirectory: "/fixture/artifacts",
  });
  await assert.rejects(child.close(), /Child artifact collection and cleanup failed/);
  assert.equal(cleanups, 1);
});

for (const lifecycle of ["session_shutdown", "session_start"]) {
  test(`shared background ${lifecycle} collects artifacts and removes child scratch state`, async () => {
    const { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { default: background } = await import(
      "../../../pi-background/extensions/background-process.ts"
    );
    const { cleanupNativeLaunch } = await import("./native-launcher.ts");
    const { launchChild } = await import("./child-launch.ts");
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-child-shared-shutdown-")));
    const scratch = join(root, "child"),
      workspace = join(scratch, "workspace"),
      configuration = join(scratch, "launch"),
      agentDir = join(scratch, "agent");
    const handlers = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, (value: any) => void>();
    const pi = {
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, handler);
      },
      events: {
        on(name: string, handler: (value: any) => void) {
          listeners.set(name, handler);
        },
        emit(name: string, value: any) {
          listeners.get(name)?.(value);
        },
      },
      registerTool() {},
      registerCommand() {},
      getActiveTools: () => ["bash"],
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
    background(pi);
    try {
      await Promise.all(
        [workspace, configuration, agentDir].map((path) => mkdir(path, { recursive: true })),
      );
      await writeFile(join(workspace, "answer.txt"), "retained child answer");
      await writeFile(join(configuration, "auth.json"), "synthetic credentials");
      await handlers.get("session_start")!();
      let transport!: import("../background/service.ts").BackgroundService;
      pi.events.emit("background:service", {
        respond(value: typeof transport) {
          transport = value;
        },
      });
      let beforeCleanup: (() => Promise<void>) | undefined;
      const info = await lstat(workspace);
      const launcher = {
        async prepareChildLaunch() {
          return {
            id: "child",
            argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            env: process.env,
            cwd: workspace,
            tmp: workspace,
            workspaceKind: "scratch",
            workspaceIdentity: { path: workspace, dev: info.dev, ino: info.ino },
            beforeCleanup(callback: () => Promise<void>) {
              beforeCleanup = callback;
            },
            cleanup() {
              return cleanupNativeLaunch({
                root: scratch,
                privateTmp: workspace,
                configuration,
                agentDir,
                beforeCleanup,
              });
            },
          };
        },
      } as unknown as import("pi-contracts").ChildLaunchService;
      const child = await launchChild({
        launcher,
        transport,
        spec: {},
        isCurrent: () => true,
        artifactDirectory: join(root, "artifacts"),
      });
      await handlers.get(lifecycle)!();
      await child.close();
      assert.throws(() => transport.status(child.id), /belongs to an ended session/);
      assert.equal(
        await readFile(join(child.artifacts()!.directory, "answer.txt"), "utf8"),
        "retained child answer",
      );
      await assert.rejects(lstat(scratch), { code: "ENOENT" });
    } finally {
      await handlers.get("session_shutdown")!();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
}

async function uiBridgeFixture(
  onSelect?: Parameters<typeof import("./child-launch.ts").launchChild>[0]["onSelect"],
) {
  let current = true,
    receive: (stream: "stdout", data: Buffer) => void = () => {},
    finish: (value: any) => void = () => {};
  const writes: any[] = [];
  let cancelled = false;
  const transport = {
    launch(spec: any) {
      receive = spec.onData;
      return {
        id: "native-ui-child",
        done: new Promise((resolve) => {
          finish = resolve;
        }),
      };
    },
    async write(_id: string, data: Buffer) {
      const value = JSON.parse(data.toString());
      writes.push(value);
      if (value.type !== "extension_ui_response")
        receive(
          "stdout",
          Buffer.from(
            JSON.stringify({ type: "response", id: value.id, success: true, data: {} }) + "\n",
          ),
        );
    },
    cancel() {
      cancelled = true;
      finish({ id: "native-ui-child", status: "cancelled", exitCode: 0 });
    },
  };
  const { launchChild } = await import("./child-launch.ts");
  const child = await launchChild({
    launcher: {
      version: 1,
      describeChild: async () => ({}),
      prepareChildLaunch: async () => ({
        id: "native-ui-child",
        argv: ["pi"],
        env: {},
        cwd: "/fixture",
        tmp: "/fixture",
        cleanup: async () => {},
      }),
    },
    transport: transport as any,
    spec: {},
    isCurrent: () => current,
    onSelect,
  });
  const tick = async () => {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    child,
    writes,
    tick,
    get cancelled() {
      return cancelled;
    },
    expire() {
      current = false;
    },
    request() {
      receive(
        "stdout",
        Buffer.from(
          JSON.stringify({
            type: "extension_ui_request",
            method: "select",
            id: "permission",
            title: "Allow write?",
            options: ["Allow once", "Deny"],
          }) + "\n",
        ),
      );
    },
  };
}

for (const answer of ["Allow once", "Deny", undefined])
  test(`native child select forwards ${answer ?? "cancellation"} without a security service`, async () => {
    const f = await uiBridgeFixture(async ({ title, options, signal }) => {
      assert.equal(title, "Allow write?");
      assert.deepEqual(options, ["Allow once", "Deny"]);
      assert.equal(signal.aborted, false);
      return answer;
    });
    try {
      f.request();
      await f.tick();
      assert.deepEqual(
        f.writes.find((value) => value.id === "permission"),
        {
          type: "extension_ui_response",
          id: "permission",
          ...(answer === undefined ? {} : { value: answer }),
        },
      );
    } finally {
      await f.child.close();
    }
  });

test("a headless parent cancels a native child selection explicitly", async () => {
  const f = await uiBridgeFixture();
  try {
    f.request();
    await f.tick();
    assert.deepEqual(
      f.writes.find((value) => value.id === "permission"),
      { type: "extension_ui_response", id: "permission" },
    );
  } finally {
    await f.child.close();
  }
});

test("a stale native child selection cannot send approval and cancels pending UI", async () => {
  let resolve!: (value: string) => void;
  let selectionSignal: AbortSignal | undefined;
  const pending = new Promise<string>((answer) => {
    resolve = answer;
  });
  const f = await uiBridgeFixture(async ({ signal }) => {
    selectionSignal = signal;
    return pending;
  });
  try {
    f.request();
    await f.tick();
    f.expire();
    resolve("Allow once");
    await f.tick();
    assert.equal(
      f.writes.some((value) => value.id === "permission"),
      false,
    );
    assert.equal(f.cancelled, true);
    assert.equal(selectionSignal?.aborted, true);
  } finally {
    await f.child.close();
  }
});
