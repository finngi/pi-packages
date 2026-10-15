import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHILD_LAUNCH_CONTRIBUTIONS } from "pi-contracts";
import permissions from "../extensions/permissions.ts";

interface Harness {
  call(toolName: string, input: Record<string, unknown>): Promise<any>;
  command(args: string): Promise<void>;
  input(): void;
  child(): any;
  answers: string[];
  prompts: Array<{ title: string; options: string[] }>;
  statuses: string[];
  entries: any[];
}

async function harness(
  settings: unknown,
  { hasUI = true, complete }: { hasUI?: boolean; complete?: (prompt: string) => string } = {},
): Promise<Harness & { done(): Promise<void> }> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-permissions-ext-"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ permissions: settings }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const hooks = new Map<string, Function>();
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const state = {
    answers: [] as string[],
    prompts: [] as any[],
    statuses: [] as string[],
    entries: [] as any[],
  };
  const model = { id: "judge", provider: "fixture", api: "fixture" };
  const ctx: any = {
    cwd: agentDir,
    hasUI,
    signal: undefined,
    ui: {
      setStatus: (_key: string, text: string) => state.statuses.push(text),
      notify() {},
      select: async (title: string, options: string[]) => {
        state.prompts.push({ title, options });
        return state.answers.shift();
      },
    },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Tidy the repo" } },
        ...state.entries,
      ],
      getSessionId: () => "session-1",
    },
    modelRegistry: {
      getModelsOfType: () => [],
      getAll: () => [model],
      complete: async (_model: unknown, context: any) => ({
        stopReason: "stop",
        content: [{ type: "text", text: complete?.(context.messages[0].content) ?? "" }],
      }),
    },
  };
  const pi: any = {
    on: (name: string, fn: Function) => hooks.set(name, fn),
    events: {
      on: (name: string, fn: Function) => events.set(name, fn),
      emit: (name: string, value: unknown) => events.get(name)?.(value),
    },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      state.entries.push({ type: "custom", customType, data }),
  };
  permissions(pi);
  await hooks.get("session_start")!({}, ctx);
  let toolCallId = 0;
  return {
    ...state,
    call: (toolName, input) =>
      hooks.get("tool_call")!({ toolName, input, toolCallId: `c${++toolCallId}` }, ctx),
    command: (args) => commands.get("permissions").handler(args, ctx),
    input: () => hooks.get("input")!({}),
    child() {
      let contribution: any;
      events.get(CHILD_LAUNCH_CONTRIBUTIONS)!({
        version: 1,
        ctx,
        contribute: (value: unknown) => {
          contribution = value;
        },
        reject: (reason: string) => assert.fail(reason),
      });
      return JSON.parse(contribution.env.PI_CHILD_EXTENSION_PERMISSIONS);
    },
    restart: () => hooks.get("session_start")!({}, ctx),
    async done() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(agentDir, { recursive: true, force: true });
    },
  } as Harness & { done(): Promise<void>; restart(): Promise<void> };
}

test("ask mode prompts for unmatched calls and remembers session allows", async () => {
  const h = await harness({ mode: "ask", deny: ["bash:sudo"] });
  try {
    assert.equal(await h.call("read", { path: "a" }), undefined);
    assert.match(
      (await h.call("bash", { command: "sudo ls" })).reason,
      /denied by rule "bash:sudo"/,
    );
    h.answers.push("Deny");
    assert.match((await h.call("bash", { command: "npm test" })).reason, /user denied/);
    assert.deepEqual(h.prompts[0].options, [
      "Allow once",
      'Allow "npm" commands for this session',
      "Deny",
    ]);
    h.answers.push('Allow "npm" commands for this session');
    assert.equal(await h.call("bash", { command: "npm test" }), undefined);
    assert.equal(await h.call("bash", { command: "npm run lint" }), undefined);
    assert.equal(h.prompts.length, 2);
    assert.ok(h.child().settings.allow.includes("bash:npm"));
  } finally {
    await h.done();
  }
});

test("/permissions switches mode for the session and survives restart", async () => {
  const h = (await harness({ mode: "ask" })) as Awaited<ReturnType<typeof harness>> & {
    restart(): Promise<void>;
  };
  try {
    await h.command("off");
    assert.equal(await h.call("write", { path: "x" }), undefined);
    assert.equal(h.statuses.at(-1), "permissions: off");
    await (h as any).restart();
    assert.equal(h.statuses.at(-1), "permissions: off");
    assert.equal(h.child().settings.mode, "off");
  } finally {
    await h.done();
  }
});

test("auto mode follows the classifier and asks when it is unsure", async () => {
  let verdict = "allow";
  const h = await harness(
    { mode: "auto", model: "fixture/judge" },
    { complete: () => JSON.stringify({ reason: "because", verdict }) },
  );
  try {
    assert.equal(await h.call("write", { path: "x" }), undefined);
    verdict = "deny";
    assert.match(
      (await h.call("write", { path: "x" })).reason,
      /classifier blocked this call: because/,
    );
    verdict = "unsure";
    h.answers.push("Allow once");
    assert.equal(await h.call("write", { path: "x" }), undefined);
    assert.match(h.prompts[0].title, /The classifier was unsure: because/);
  } finally {
    await h.done();
  }
});

test("without a UI, calls that need a person are blocked", async () => {
  const h = await harness({ mode: "auto", model: "fixture/missing" }, { hasUI: false });
  try {
    const result = await h.call("write", { path: "x" });
    assert.match(result.reason, /fixture\/missing is unavailable; no one is available to ask/);
  } finally {
    await h.done();
  }
});

test("a new user message cancels an approval in flight", async () => {
  const h = await harness({ mode: "ask" });
  try {
    h.answers.push("Allow once");
    const pending = h.call("write", { path: "x" });
    h.input();
    assert.match((await pending).reason, /new user message/);
  } finally {
    await h.done();
  }
});

test("children get the newest user messages within the environment size limit", async () => {
  const h = await harness({ mode: "auto", model: "fixture/judge" });
  let child: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    for (let index = 0; index < 300; index++)
      h.entries.push({
        type: "message",
        message: { role: "user", content: `${index} ${"\n".repeat(7_000)}` },
      });
    h.entries.push({ type: "message", message: { role: "user", content: "latest" } });
    const value = h.child();
    // Linux refuses to start a process with an environment string over 128 KiB.
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
    assert.equal(value.userMessages.at(-1), "latest");
    assert.equal(value.userMessagesOmitted, true);

    process.env.PI_SUBAGENT = "1";
    process.env.PI_CHILD_EXTENSION_PERMISSIONS = JSON.stringify(value);
    let prompt = "";
    child = await harness(undefined, {
      complete: (text) => {
        prompt = text;
        return JSON.stringify({ reason: "ok", verdict: "allow" });
      },
    });
    assert.equal(await child.call("write", { path: "x" }), undefined);
    assert.match(prompt, /^\[earlier user messages omitted\]/);
    assert.match(prompt, /User: latest/);
  } finally {
    delete process.env.PI_SUBAGENT;
    delete process.env.PI_CHILD_EXTENSION_PERMISSIONS;
    await child?.done();
    await h.done();
  }
});
