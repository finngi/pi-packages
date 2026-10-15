import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../../extensions/subagent.ts";
import { MESSAGE_BRIDGE } from "./messages.ts";

test("bound bidirectional and sibling messages, preflight drift, consumed-result suppression and revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-comms-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(
    join(dir, "agents/general-purpose.md"),
    "---\nname: general-purpose\ndescription: Implement delegated work\nconversation: none\n---\nKeep within the assignment.",
  );
  const saved = {
    agent: process.env.PI_CODING_AGENT_DIR,
    child: process.env.PI_SUBAGENT,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>(),
    entries: any[] = [],
    messages: any[] = [],
    runs = new Map<string, any>();
  let next = 0,
    idle = false,
    activeTools = ["read", "write", "agent_message", "agent_list", "session_setup"],
    failNextPrompt = false,
    abortNextPrompt: (() => void) | undefined;
  const emit = (run: any, value: any) =>
    run.onData("stdout", Buffer.from(`${JSON.stringify(value)}\n`));
  const transport = {
    launch(spec: any) {
      const id = `worker-${++next}`;
      let complete: Function = () => {};
      const done = new Promise((resolve) => (complete = resolve));
      const run = { ...spec, done, resolve: complete, writes: [] };
      runs.set(id, run);
      return { id, done };
    },
    async write(id: string, data: Buffer) {
      const run = runs.get(id),
        value = JSON.parse(data.toString());
      run.writes.push(value);
      if (failNextPrompt && value.type === "prompt") {
        failNextPrompt = false;
        throw Error("simulated child start failure");
      }
      if (abortNextPrompt && value.type === "prompt") {
        const abort = abortNextPrompt;
        abortNextPrompt = undefined;
        abort();
      }
      if (value.type !== "extension_ui_response")
        emit(run, {
          type: "response",
          id: value.id,
          success: true,
          data: { disposition: "queued" },
        });
    },
    cancel(id: string) {
      const run = runs.get(id);
      run.resolve?.({ id, status: "cancelled", exitCode: 0 });
    },
  };
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand() {},
    registerFlag() {},
    getFlag() {},
    registerMessageRenderer() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => activeTools,
    getAllTools: () =>
      ["read", "write", "agent_message", "agent_list", "session_setup"].map((name) => ({
        name,
        description: name,
        exposure: "direct",
      })),
    setActiveTools() {},
    getThinkingLevel: () => "off",
    getCommands: () => [],
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => messages.push({ ...message, options }),
    events: {
      on() {},
      emit: (name: string, value: any) => {
        if (name === "background:service") value.respond(transport);
      },
    },
  };
  const ctx = {
    cwd: dir,
    isProjectTrusted: () => false,
    isIdle: () => idle,
    model: { provider: "fixture", id: "fixture" },
    modelRegistry: {
      find: () => ({
        provider: "fixture",
        id: "fixture",
        api: "openai-completions",
        reasoning: false,
      }),
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getAvailableOfType: async () => [
        { provider: "fixture", id: "fixture", api: "openai-completions", reasoning: false },
      ],
    },
    sessionManager: { getBranch: () => entries, getSessionId: () => "native-parent-session" },
  };
  const call = (name: string, args: any, signal?: AbortSignal) =>
    tools.get(name).execute("tool", args, signal, undefined, ctx);
  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    extension(pi as any);
    assert.deepEqual(Object.keys(tools.get("subagent_check").parameters.properties), [
      "id",
      "after",
      "limit",
      "replySequence",
      "textOffset",
    ]);
    assert.deepEqual(Object.keys(tools.get("subagent_close").parameters.properties), [
      "id",
      "discard",
    ]);
    await handlers.get("session_start")!({}, ctx);
    const input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: dir, contextFiles: [], sections: {} },
    };
    await handlers.get("before_agent_start")!(input, ctx);
    assert.match((input.systemPromptOptions.sections as any).agents, /host permissions/);
    activeTools = ["read", "agent_message", "agent_list", "session_setup"];
    await assert.rejects(
      call("subagent", { agent: "general-purpose", task: "build" }),
      /Review tools and scope/,
    );
    assert.equal(runs.size, 0);
    activeTools = ["read", "write", "agent_message", "agent_list", "session_setup"];
    await handlers.get("before_agent_start")!(input, ctx);
    const stableSections = structuredClone(input.systemPromptOptions.sections);
    assert.ok(!("active_agents" in stableSections));
    const first = (await call("subagent", { agent: "general-purpose", task: "build frontend" }))
      .details.id;
    const second = (await call("subagent", { agent: "general-purpose", task: "build backend" }))
      .details.id;
    idle = true;
    await handlers.get("before_agent_start")!(input, ctx);
    assert.deepEqual(
      input.systemPromptOptions.sections,
      stableSections,
      "Launching children and changing busy state preserves the leading system sections",
    );
    idle = false;
    const main = (await call("agent_list", {})).details.agents[0].id;
    assert.match(first, /^agent-[a-z]+-[a-z]+-[a-z]+$/);
    assert.equal((await call("agent_list", {})).details.agents.length, 3);
    await call("agent_message", { to: first, message: "parent clarification" });
    assert(
      runs
        .get("worker-1")
        .writes.some((v: any) => v.message?.includes(`<agent_message from="${main}"`)),
    );
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "up",
      method: "select",
      options: ["Deliver"],
      title: MESSAGE_BRIDGE + JSON.stringify({ to: main, message: "child question" }),
    });
    await tick();
    assert.equal(messages.length, 1, "Busy main hands the message to the stock queue immediately");
    assert.equal(messages[0].options.deliverAs, "steer");
    assert.match(messages[0].content, /child question/);
    const receipt = JSON.parse(runs.get("worker-1").writes.find((v: any) => v.id === "up").value);
    assert(
      entries.some(
        (e) => e.data.type === "message.delivered" && e.data.messageId === receipt.message_id,
      ),
    );
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "later",
      method: "select",
      options: ["Deliver"],
      title: MESSAGE_BRIDGE + JSON.stringify({ to: main, message: "for later", mode: "followUp" }),
    });
    await tick();
    assert.equal(messages[1].options.deliverAs, "followUp");
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "now",
      method: "select",
      options: ["Deliver"],
      title:
        MESSAGE_BRIDGE + JSON.stringify({ to: main, message: "urgent correction", mode: "steer" }),
    });
    await tick();
    assert.equal(messages[2].options.deliverAs, "steer");
    assert(
      runs.get("worker-1").writes.some((v: any) => v.id === "up" && JSON.parse(v.value).accepted),
    );
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "peer",
      method: "select",
      options: ["Deliver"],
      title: MESSAGE_BRIDGE + JSON.stringify({ to: second, message: "interface ready" }),
    });
    await tick();
    assert(
      runs
        .get("worker-2")
        .writes.some((v: any) => v.message?.includes(`<agent_message from="${first}"`)),
    );
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "spoof",
      method: "select",
      options: ["Deliver"],
      title: MESSAGE_BRIDGE + JSON.stringify({ to: main, message: "spoof", from: second }),
    });
    await tick();
    assert(
      runs
        .get("worker-1")
        .writes.some((v: any) => v.id === "spoof" && JSON.parse(v.value).accepted === false),
    );
    const sourceInputs = runs
      .get("worker-1")
      .writes.filter((v: any) => ["prompt", "steer"].includes(v.type))
      .map((v: any) => v.id);
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "routine",
      method: "select",
      options: ["Deliver"],
      title:
        MESSAGE_BRIDGE +
        JSON.stringify({
          to: main,
          message: "routine telemetry",
          kind: "progress",
          emittedAt: "2026-10-13T10:00:00.000Z",
        }),
    });
    await tick();
    const progress = messages.pop();
    assert.equal(progress.options.triggerTurn, false);
    assert.equal(progress.details.kind, "progress");
    assert.deepEqual(progress.details.sourceRequestIds, sourceInputs);
    assert.match(progress.content, /emitted_at="2026-10-13T10:00:00.000Z"/);
    await assert.rejects(
      call("agent_message", { to: second, message: "routine", kind: "progress" }),
      /only be sent to the parent/,
    );
    emit(runs.get("worker-1"), {
      type: "extension_ui_request",
      id: "bad-time",
      method: "select",
      options: ["Deliver"],
      title:
        MESSAGE_BRIDGE +
        JSON.stringify({ to: main, message: "routine", kind: "progress", emittedAt: 42 }),
    });
    await tick();
    assert.equal(
      JSON.parse(runs.get("worker-1").writes.find((v: any) => v.id === "bad-time").value).accepted,
      false,
    );
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "artifact ready" }],
      stopReason: "stop",
    };
    emit(runs.get("worker-1"), { type: "message_start", message: answer });
    emit(runs.get("worker-1"), { type: "message_end", message: answer });
    emit(runs.get("worker-1"), { type: "turn_end", message: answer });
    emit(runs.get("worker-1"), { type: "agent_settled", aborted: false });
    assert.equal((await call("subagent_check", { id: first })).details.replies.length, 1);
    const consumed = entries.filter((e) => e.data.type === "result.consumed").length;
    assert.equal((await call("subagent_check", { id: first })).details.replies.length, 1);
    assert.equal(
      entries.filter((e) => e.data.type === "result.consumed").length,
      consumed,
      "Re-reading history does not consume twice",
    );
    assert.equal(
      handlers.get("turn_end")!({ outcome: "completed" }, ctx),
      undefined,
      "Checked result is not delivered again",
    );
    await call("agent_message", { to: first, message: "verify follow-up" });
    emit(runs.get("worker-1"), { type: "message_start", message: answer });
    emit(runs.get("worker-1"), { type: "message_end", message: answer });
    emit(runs.get("worker-1"), { type: "turn_end", message: answer });
    emit(runs.get("worker-1"), { type: "agent_settled", aborted: false });
    assert.equal(
      handlers.get("turn_end")!({ outcome: "aborted" }, ctx),
      undefined,
      "Do not force continuation at an aborted boundary",
    );
    idle = true;
    await handlers.get("agent_settled")!({ aborted: true }, ctx);
    assert.equal(
      messages.length,
      3,
      "An aborted run stays stopped with its pending result retained",
    );
    idle = false;
    const boundary = handlers.get("turn_end")!({ outcome: "completed" }, ctx);
    assert.equal(boundary.continue, true);
    assert.equal(boundary.entries.length, 1);
    assert.match(boundary.entries[0].content, /artifact ready/);
    assert.equal(
      handlers.get("turn_end")!({ outcome: "completed" }, ctx),
      undefined,
      "One delivery per pending result",
    );
    idle = true;
    await handlers.get("agent_settled")!({ aborted: false }, ctx);
    assert.equal(messages.length, 3, "Settlement does not replay messages or consumed results");
    failNextPrompt = true;
    await assert.rejects(
      call("subagent", { agent: "general-purpose", task: "exercise failed startup" }),
      /Could not start general-purpose/,
    );
    assert.equal(
      (await call("agent_list", {})).details.agents.length,
      3,
      "failed startup leaves no child handle",
    );
    assert.equal(
      existsSync(runs.get("worker-3").env.PI_CODING_AGENT_DIR),
      false,
      "failed startup removes native child configuration",
    );
    assert.equal(
      existsSync(runs.get("worker-3").cwd),
      false,
      "failed startup removes its scratch workspace",
    );
    const controller = new AbortController();
    abortNextPrompt = () => controller.abort();
    await assert.rejects(
      call(
        "subagent",
        { agent: "general-purpose", task: "abort during child startup" },
        controller.signal,
      ),
      /Could not start general-purpose/,
    );
    await tick();
    assert.equal(
      (await call("agent_list", {})).details.agents.length,
      3,
      "abort removes the child handle",
    );
    assert.equal(
      existsSync(runs.get("worker-4").env.PI_CODING_AGENT_DIR),
      false,
      "abort removes native child configuration",
    );
    assert.equal(
      existsSync(runs.get("worker-4").cwd),
      false,
      "abort removes its scratch workspace",
    );
    idle = false;
    const longAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(10 * 1024) }],
      stopReason: "stop",
    };
    emit(runs.get("worker-1"), { type: "message_start", message: longAnswer });
    emit(runs.get("worker-1"), { type: "message_end", message: longAnswer });
    emit(runs.get("worker-1"), { type: "turn_end", message: longAnswer });
    emit(runs.get("worker-1"), { type: "agent_settled", aborted: false });
    const closedFirst = await call("subagent_close", { id: first, discard: true });
    assert.equal(closedFirst.details.closedHistory.available, true);
    assert.equal(closedFirst.details.artifacts.discarded, true);
    assert.equal(closedFirst.details.artifacts.scope, "scratch-collection");
    assert.equal(closedFirst.details.artifacts.externalEffects, "untracked");
    assert(
      !("replies" in closedFirst.details),
      "close returns a compact summary, not a transcript",
    );
    let consumedAfterClose = entries.filter((e) => e.data.type === "result.consumed").length;
    const tailFirst = await call("subagent_check", {
      id: first,
      replySequence: 3,
      textOffset: 8 * 1024,
    });
    assert.equal(tailFirst.details.replies[0].text.length, 2 * 1024);
    assert.equal(
      entries.filter((e) => e.data.type === "result.consumed").length,
      consumedAfterClose,
      "Reading only the tail does not consume the pending notification",
    );
    const firstChunk = await call("subagent_check", { id: first, replySequence: 3 });
    assert.equal(firstChunk.details.closedHistory.available, true);
    assert.equal(firstChunk.details.replies[0].text.length, 8 * 1024);
    assert.equal(firstChunk.details.replies[0].textTruncated, true);
    assert.equal(firstChunk.details.replies[0].nextTextOffset, 8 * 1024);
    const lastChunk = await call("subagent_check", {
      id: first,
      replySequence: 3,
      textOffset: firstChunk.details.replies[0].nextTextOffset,
    });
    assert.equal(lastChunk.details.replies[0].text.length, 2 * 1024);
    assert.equal(lastChunk.details.replies[0].textTruncated, false);
    consumedAfterClose++;
    assert.equal(
      entries.filter((e) => e.data.type === "result.consumed").length,
      consumedAfterClose,
      "Reading the complete contiguous reply consumes one pending notification",
    );
    const repeatedClose = await call("subagent_close", { id: first, discard: true });
    assert.equal(repeatedClose.details.closedHistory.available, true);
    assert.equal(repeatedClose.details.artifacts.discarded, true);
    assert.equal(
      (await call("subagent_check", { id: first, replySequence: 3 })).details.replies[0].text
        .length,
      8 * 1024,
      "discarding artifacts does not remove archived reply history",
    );

    const escapedAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "\\".repeat(1536 * 1024) }],
      stopReason: "stop",
    };
    emit(runs.get("worker-2"), { type: "message_start", message: escapedAnswer });
    emit(runs.get("worker-2"), { type: "message_end", message: escapedAnswer });
    emit(runs.get("worker-2"), { type: "turn_end", message: escapedAnswer });
    emit(runs.get("worker-2"), { type: "agent_settled", aborted: false });
    const closedSecond = await call("subagent_close", { id: second });
    assert.equal(closedSecond.details.closedHistory.available, true);
    let escapedOffset = 0;
    let escapedArchiveBytes = 0;
    for (;;) {
      const page = await call("subagent_check", {
        id: second,
        replySequence: 1,
        textOffset: escapedOffset,
      });
      const archivedReply = page.details.replies[0];
      assert(archivedReply.textTruncated ? archivedReply.nextTextOffset : true);
      escapedArchiveBytes += Buffer.byteLength(archivedReply.text, "utf8");
      if (!archivedReply.textTruncated) break;
      escapedOffset = archivedReply.nextTextOffset;
    }
    assert(escapedArchiveBytes < Buffer.byteLength(escapedAnswer.content[0].text, "utf8"));
    assert.equal(
      entries.filter((e) => e.data.type === "result.consumed").length,
      consumedAfterClose,
      "Reading a JSON-escaped archive does not consume a larger pending parent reply",
    );
    const escapedDelivery = handlers.get("turn_end")!({ outcome: "completed" }, ctx);
    assert.equal(escapedDelivery.continue, true);
    assert.match(escapedDelivery.entries[0].content, /<agent_result/);
    assert.equal(
      escapedDelivery.entries[0].details.text,
      escapedAnswer.content[0].text,
      "The full pending text remains available for ordinary parent delivery",
    );
    await call("subagent_close", { id: second });
    await handlers.get("before_agent_start")!(input, ctx);
    assert.deepEqual(
      input.systemPromptOptions.sections,
      stableSections,
      "Closing a child preserves the leading system sections",
    );
    await assert.rejects(
      call("agent_message", { to: second, message: "late" }),
      /unknown, closed or revoked/,
    );
    await handlers.get("session_shutdown")!();
    assert.equal((await call("agent_list", {})).details.agents.length, 1);
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", saved.agent],
      ["PI_SUBAGENT", saved.child],
    ])
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
