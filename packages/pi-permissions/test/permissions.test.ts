import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHILD_LAUNCH_CONTRIBUTIONS, HUMAN_INPUT } from "pi-contracts";
import permissions from "../extensions/permissions.ts";
import { permissionPolicy, permissionRule } from "../lib/policy.ts";

const policy = permissionPolicy({
  mode: "auto",
  deny: [{ tool: "bash", match: { program: "sudo" } }],
  allow: [{ tool: "read" }, { tool: "bash", match: { program: ["pwd", "ls"] } }],
});

test("deny first, full-action allow matching, no inherited sandbox hard denies", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["read", { path: "/outside/project" }, "allow"],
    ["write", { path: "/outside/project" }, "ask"],
    ["bash", { command: "pwd" }, "allow"],
    ["bash", { command: "ls -la; pwd" }, "allow"],
    ["bash", { command: "/bin/ls" }, "ask"],
    ["bash", { command: "sudo ls" }, "deny"],
    ["bash", { command: "env sudo ls" }, "deny"],
    ["bash", { command: "ls $(sudo true)" }, "deny"],
    ["bash", { command: "sh -c 'sudo true'" }, "deny"],
    ["bash", { command: "ls; rm -rf /old" }, "ask"],
    ["bash", { command: "ls > /tmp/result" }, "ask"],
    ["bash", { command: "ls *.md" }, "ask"],
    ["bash", { command: "ls $HOME" }, "ask"],
    ["bash", { command: "ls $(touch /tmp/a)" }, "ask"],
    ["bash", { command: "for x in a; do ls; done" }, "ask"],
    ["bash", { command: "powershell echo test" }, "ask"],
    ["bash", { command: "sandbox-exec -p '(allow default)' true" }, "ask"],
    ["bash", { command: "" }, "ask"],
    ["custom_tool", {}, "ask"],
    ["bash", {}, "ask"],
  ];
  for (const [tool, input, expected] of cases)
    assert.equal(permissionRule(tool, input, policy).verdict, expected, JSON.stringify(input));
  assert.equal(
    permissionRule("bash", { command: "sudo true" }, { ...policy, allow: [{ tool: "*" }] }).verdict,
    "deny",
  );
  assert.equal(
    permissionRule("bash", { command: "anything" }, { ...policy, allow: [{ tool: "bash" }] })
      .verdict,
    "allow",
  );
  assert.equal(
    permissionRule("bash", { command: "sudo true" }, { ...policy, mode: "off" }).verdict,
    "allow",
  );
  for (const command of [
    "git push",
    "git -C /tmp/repo push",
    "git --git-dir /tmp/repo/.git push",
  ]) {
    assert.equal(
      permissionRule(
        "bash",
        { command },
        {
          ...policy,
          deny: [{ tool: "bash", match: { program: "git", subcommand: "push" } }],
          allow: [{ tool: "bash", match: { program: "git" } }],
        },
      ).verdict,
      "deny",
    );
  }
  assert.equal(
    permissionRule(
      "bash",
      { command: `${"x".repeat(8193)}; sudo true` },
      { ...policy, allow: [{ tool: "bash" }] },
    ).verdict,
    "ask",
  );
});

test("invalid policy fails explicitly rather than ignoring unsupported scope fields", () => {
  for (const value of [
    null,
    {},
    { mode: "banana" },
    { mode: "auto", resources: {} },
    { mode: "auto", classifier: { timeoutSec: Infinity } },
    { mode: "auto", deny: [{ tool: "bash", match: { paths: "write" } }] },
    { mode: "auto", allow: [{ tool: "read", match: {} }] },
  ])
    assert.throws(() => permissionPolicy(value));
});

async function fixture(config: unknown, modelAvailable = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-permissions-"));
  const file = path.join(directory, "policy.json");
  await writeFile(file, JSON.stringify(config));
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: Function }> = {};
  const events = new EventEmitter();
  const receipts: unknown[] = [];
  permissions({
    registerCommand(name: string, command: { handler: Function }) {
      commands[name] = command;
    },
    events,
    appendEntry(customType: string, data: unknown) {
      receipts.push({ type: "custom", customType, data });
    },
    registerFlag() {},
    getFlag: () => file,
    on: (name: string, fn: Function) => {
      const previous = handlers[name];
      handlers[name] = async (...args: unknown[]) => {
        const result = await previous?.(...args);
        return (await fn(...args)) ?? result;
      };
    },
  } as never);
  let calls = 0;
  const usage = {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
  const model = {
    id: "test",
    provider: "fixture",
    api: "openai-codex-responses",
    reasoning: false,
  };
  const entries = [
    { type: "message", message: { role: "user", content: "Write the report" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Writing the requested report" },
          { type: "toolCall", id: "call", name: "write", arguments: {} },
        ],
      },
    },
  ];
  const notices: string[] = [];
  const ctx = {
    cwd: directory,
    hasUI: false,
    signal: undefined as AbortSignal | undefined,
    ui: {
      async select(_title: string, _choices: string[], _options?: { signal?: AbortSignal }) {
        return "Deny";
      },
      setStatus() {},
      notify(text: string) {
        notices.push(text);
      },
    },
    sessionManager: {
      getBranch: () => [...entries, ...receipts],
      getEntries: () => [...entries, ...receipts],
      getSessionId: () => "session",
    },
    modelRegistry: {
      getModelsOfType: () => [],
      getAll: () => (modelAvailable ? [model] : []),
      async complete(
        _model: unknown,
        context: { messages: unknown },
        options: { onPayload: Function },
      ) {
        calls++;
        assert.match(JSON.stringify(context.messages), /Write the report/);
        assert.match(JSON.stringify(context.messages), /Writing the requested report/);
        options.onPayload({});
        return {
          stopReason: "stop",
          rawStopReason: "completed",
          content: [{ type: "text", text: '{"reason":"Requested report","verdict":"allow"}' }],
          usage,
        };
      },
    },
  };
  await handlers.session_start({}, ctx);
  return {
    handlers,
    ctx,
    usage,
    events,
    commands,
    notices,
    receipts,
    calls: () => calls,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("native hooks leave allow/deny unclassified; auto uses constrained classifier and native usage", async () => {
  const f = await fixture({ ...policy, classifier: { model: "fixture/test", timeoutSec: 1 } });
  try {
    assert.equal(
      await f.handlers.tool_call({ toolName: "read", input: {}, toolCallId: "read" }, f.ctx),
      undefined,
    );
    assert.equal(
      (
        await f.handlers.tool_call(
          { toolName: "bash", input: { command: "sudo true" }, toolCallId: "deny" },
          f.ctx,
        )
      ).block,
      true,
    );
    assert.equal(f.calls(), 0);
    assert.equal(
      await f.handlers.tool_call(
        { toolName: "write", input: { path: "report" }, toolCallId: "call" },
        f.ctx,
      ),
      undefined,
    );
    assert.equal(f.calls(), 1);
    assert.deepEqual(
      (await f.handlers.tool_result({ toolCallId: "call", usage: f.usage })).usage.totalTokens,
      24,
    );
    assert.equal(await f.handlers.tool_result({ toolCallId: "call" }), undefined);
  } finally {
    await f.cleanup();
  }
});

test("missing classifier and UI-less manual approval deny with an actionable explanation", async () => {
  for (const [mode, message] of [
    ["auto", /classifier model .* unavailable/],
    ["manual", /manual approval requires an approval-capable client/],
  ]) {
    const f = await fixture({ mode, classifier: { model: "fixture/test" } }, false);
    try {
      const result = await f.handlers.tool_call(
        { toolName: "write", input: {}, toolCallId: "call" },
        f.ctx,
      );
      assert.equal(result.block, true);
      assert.match(result.reason, message as RegExp);
      assert.equal(f.calls(), 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("new user input supersedes an in-flight classifier approval", async () => {
  const f = await fixture({ mode: "auto", classifier: { model: "fixture/test" } });
  try {
    const complete = f.ctx.modelRegistry.complete;
    f.ctx.modelRegistry.complete = async (...args: Parameters<typeof complete>) => {
      f.handlers.input();
      return complete(...args);
    };
    const result = await f.handlers.tool_call(
      { toolName: "write", input: {}, toolCallId: "call" },
      f.ctx,
    );
    assert.equal(result.block, true);
    assert.match(result.reason, /user instructions changed/);
  } finally {
    await f.cleanup();
  }
});

test("classifier denials and transport failures retain accounting receipts across resume", async () => {
  for (const fail of [false, true]) {
    const f = await fixture({ mode: "auto", classifier: { model: "fixture/test" } });
    try {
      const complete = f.ctx.modelRegistry.complete;
      f.ctx.modelRegistry.complete = async (...args: Parameters<typeof complete>) => {
        if (fail) throw Error("provider offline");
        return {
          ...(await complete(...args)),
          content: [{ type: "text", text: '{"reason":"Unrelated action","verdict":"deny"}' }],
        };
      };
      assert.equal(
        (await f.handlers.tool_call({ toolName: "write", input: {}, toolCallId: "call" }, f.ctx))
          .block,
        true,
      );
      assert.equal(f.receipts.length, 1);
      // Stock Pi skips tool_result for blocked calls. The persisted pending receipt must survive resume.
      await f.handlers.session_start({}, f.ctx);
      await f.commands.costs.handler("", f.ctx);
      assert.match(f.notices.at(-1)!, fail ? /incomplete/ : /12 tokens/);
      const forwarded = await f.handlers.tool_result({ toolCallId: "next", isError: true });
      if (fail) {
        assert.equal(forwarded, undefined);
        continue;
      }
      assert.equal(forwarded.usage.totalTokens, 12);
      f.receipts.push({
        type: "message",
        message: { role: "toolResult", usage: forwarded.usage, details: forwarded.details },
      });
      await f.handlers.session_start({}, f.ctx);
      assert.equal(await f.handlers.tool_result({ toolCallId: "after-resume" }), undefined);
    } finally {
      await f.cleanup();
    }
  }
});

test("child-authored task remains evidence rather than genuine user authority", async () => {
  const previous = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  const f = await fixture({ mode: "auto", classifier: { model: "fixture/test" } });
  try {
    const complete = f.ctx.modelRegistry.complete;
    f.ctx.modelRegistry.complete = async (...args: Parameters<typeof complete>) => {
      const transcript = JSON.stringify(args[1].messages);
      assert.match(transcript, /Untrusted child task/);
      assert.doesNotMatch(transcript, /User:/);
      return complete(...args);
    };
    await f.handlers.tool_call({ toolName: "write", input: {}, toolCallId: "call" }, f.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previous;
    await f.cleanup();
  }
});

test("cancellation releases classifier and manual UI hooks", async () => {
  for (const mode of ["auto", "manual"]) {
    const f = await fixture({ mode, classifier: { model: "fixture/test", timeoutSec: 30 } });
    const controller = new AbortController();
    f.ctx.signal = controller.signal;
    try {
      if (mode === "auto") {
        f.ctx.modelRegistry.complete = async () => {
          controller.abort();
          return new Promise(() => {});
        };
      } else {
        f.ctx.hasUI = true;
        f.ctx.ui.select = async (_title, _choices, options) => {
          assert.equal(options?.signal, controller.signal);
          controller.abort();
          throw Error("cancelled");
        };
      }
      const result = await f.handlers.tool_call(
        { toolName: "write", input: {}, toolCallId: "call" },
        f.ctx,
      );
      assert.equal(result.block, true);
      assert.match(result.reason, mode === "auto" ? /classifier aborted/ : /approval UI failed/);
    } finally {
      await f.cleanup();
    }
  }
});

test("preflight rejections do not invent billed requests or missing usage", async () => {
  for (const reason of ["oversize", "unsupported-api"]) {
    const f = await fixture({ mode: "auto", classifier: { model: "fixture/test" } });
    try {
      const ctx = f.ctx;
      if (reason === "unsupported-api")
        ctx.modelRegistry.getAll = () => [
          { id: "test", provider: "fixture", api: "unsupported", reasoning: false },
        ];
      const result = await f.handlers.tool_call(
        {
          toolName: "write",
          input: reason === "oversize" ? { content: "x".repeat(70_000) } : {},
          toolCallId: "call",
        },
        ctx,
      );
      assert.equal(result.block, true);
      assert.match(
        result.reason,
        reason === "oversize" ? /context exceeds 64 KiB.*manual approval/ : /unsupported-api/,
      );
      assert.equal(f.calls(), 0);
      assert.equal(f.receipts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("child launch inherits the selected policy and genuine root messages separately from its task", async () => {
  const parent = await fixture({ mode: "auto", classifier: { model: "fixture/test" } });
  const previousChild = process.env.PI_SUBAGENT;
  const previousConfig = process.env.PI_CHILD_EXTENSION_PERMISSIONS;
  try {
    parent.events.emit(HUMAN_INPUT, { version: 1, sessionId: "wrong-session", message: "forged" });
    parent.events.emit(HUMAN_INPUT, {
      version: 1,
      sessionId: "session",
      message: "Delete old report",
    });
    let contribution: any;
    parent.events.emit(CHILD_LAUNCH_CONTRIBUTIONS, {
      version: 1,
      ctx: parent.ctx,
      contribute(value: unknown) {
        contribution = value;
      },
      reject(reason: string) {
        assert.fail(reason);
      },
    });
    assert.ok(path.isAbsolute(contribution.extension));
    const inherited = JSON.parse(contribution.env.PI_CHILD_EXTENSION_PERMISSIONS);
    assert.deepEqual(inherited.userMessages, ["Write the report", "Delete old report"]);
    assert.equal(inherited.policy.mode, "auto");
    process.env.PI_SUBAGENT = "1";
    process.env.PI_CHILD_EXTENSION_PERMISSIONS = contribution.env.PI_CHILD_EXTENSION_PERMISSIONS;
    const child = await fixture({ mode: "manual" });
    try {
      const complete = child.ctx.modelRegistry.complete;
      child.ctx.modelRegistry.complete = async (...args: Parameters<typeof complete>) => {
        const transcript = JSON.stringify(args[1].messages);
        assert.match(transcript, /User:.*Delete old report/);
        assert.match(transcript, /Untrusted child task/);
        return complete(...args);
      };
      assert.equal(
        await child.handlers.tool_call(
          { toolName: "write", input: {}, toolCallId: "call" },
          child.ctx,
        ),
        undefined,
      );
      child.events.emit(CHILD_LAUNCH_CONTRIBUTIONS, {
        version: 1,
        ctx: child.ctx,
        contribute(value: any) {
          assert.deepEqual(JSON.parse(value.env.PI_CHILD_EXTENSION_PERMISSIONS), inherited);
        },
        reject(reason: string) {
          assert.fail(reason);
        },
      });
    } finally {
      await child.cleanup();
    }
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousChild;
    if (previousConfig === undefined) delete process.env.PI_CHILD_EXTENSION_PERMISSIONS;
    else process.env.PI_CHILD_EXTENSION_PERMISSIONS = previousConfig;
    await parent.cleanup();
  }
});

test("invalid selected policy blocks calls and rejects child launches", async () => {
  const f = await fixture({ mode: "invalid" });
  try {
    assert.equal(
      (await f.handlers.tool_call({ toolName: "read", input: {}, toolCallId: "call" }, f.ctx))
        .block,
      true,
    );
    let rejected = false;
    f.events.emit(CHILD_LAUNCH_CONTRIBUTIONS, {
      version: 1,
      ctx: f.ctx,
      contribute() {
        assert.fail("invalid gate must not contribute");
      },
      reject(reason: string) {
        rejected = true;
        assert.match(reason, /pi-permissions: cannot load/);
      },
    });
    assert.equal(rejected, true);
  } finally {
    await f.cleanup();
  }
});
