import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSessionSetupRequest } from "../../pi-runtime/src/session-setup.ts";
import { decide } from "../src/gate.ts";
import { loadPolicy } from "../src/policy.ts";

test("session setup stays inside Pi's tool pool and does not widen security policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-session-setup-"));
  const prior = { cwd: process.cwd(), env: { ...process.env } };
  let session: any;
  try {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const agentDir = path.join(root, "agent");
    const tmp = path.join(root, "tmp");
    await Promise.all([project, home, agentDir, tmp].map((dir) => mkdir(dir, { recursive: true })));
    Object.assign(process.env, {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SECURITY_TMP: tmp,
      PI_SECURITY_POLICY: path.join(agentDir, "policy.json"),
      TMPDIR: `${tmp}/`,
    });
    process.chdir(project);
    await writeFile(path.join(agentDir, "auth.json"), "session-setup-secret-canary");

    const hostPolicy = JSON.parse(
      await readFile(new URL("../src/host-policy.json", import.meta.url), "utf8"),
    );
    assert.equal(
      hostPolicy.allow.some((rule: { tool: string }) => rule.tool === "session_setup"),
      false,
    );
    await writeFile(process.env.PI_SECURITY_POLICY!, JSON.stringify(hostPolicy));
    const unmatchedPolicy = await loadPolicy(process.env.PI_SECURITY_POLICY!, { project, tmp });
    assert.equal(decide("session_setup", { op: "list" }, unmatchedPolicy).verdict, "ask");
    unmatchedPolicy.policy.deny.push({ tool: "session_setup" });
    assert.equal(decide("session_setup", { op: "list" }, unmatchedPolicy).verdict, "deny");
    // The fixture opts in; production setup does not rewrite a user's permission policy.
    hostPolicy.allow.push({ tool: "session_setup", permissions: { write: false, network: [] } });
    await writeFile(process.env.PI_SECURITY_POLICY!, JSON.stringify(hostPolicy));

    const sdk = await import("@earendil-works/pi-coding-agent");
    const ai = await import("@earendil-works/pi-ai/compat");
    const runtimePath = fileURLToPath(
      new URL("../../pi-runtime/src/session-setup.ts", import.meta.url),
    );
    const typeboxPath = fileURLToPath(import.meta.resolve("typebox"));
    const setupExtension = path.join(root, "session-setup-extension.mjs");
    await writeFile(
      setupExtension,
      `import { Type } from ${JSON.stringify(pathToFileURL(typeboxPath).href)};
import { installSessionSetup } from ${JSON.stringify(pathToFileURL(runtimePath).href)};
export default function(pi) {
  const setup = installSessionSetup(pi);
  pi.on("session_start", (_event, ctx) => setup.restore(ctx));
  pi.registerTool({
    name: "hidden_fixture",
    label: "Hidden fixture",
    description: "Must remain unavailable to setup.",
    exposure: "hidden",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "unexpected" }] }; },
  });
  pi.registerTool({
    name: "outside_fixture",
    label: "Outside fixture",
    description: "Must remain outside the CLI tool pool.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "unexpected" }] }; },
  });
}`,
    );

    const calls = [
      { name: "session_setup", arguments: { op: "apply", tools: ["read"] } },
      { name: "session_setup", arguments: { op: "apply", tools: ["outside_fixture"] } },
      { name: "session_setup", arguments: { op: "apply", tools: ["hidden_fixture"] } },
      { name: "read", arguments: { path: path.join(agentDir, "auth.json") } },
    ];
    let index = 0;
    const model = {
      id: "scripted",
      name: "Scripted",
      api: "pi-security-session-setup",
      provider: "local-script",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const streamSimple = () => {
      const stream = ai.createAssistantMessageEventStream();
      const next = calls[index++];
      const content = next
        ? [{ type: "toolCall", id: `session-setup-${index}`, ...next }]
        : [{ type: "text", text: "done" }];
      const stopReason = next ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      });
      return stream;
    };
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "scripted-test-only",
      baseUrl: model.baseUrl,
      models: [
        {
          id: model.id,
          name: model.name,
          reasoning: false,
          input: ["text"],
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
      streamSimple,
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
        setupExtension,
      ],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await sdk.createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime,
      resourceLoader: loader,
      settingsManager: sdk.SettingsManager.inMemory(),
      sessionManager: sdk.SessionManager.inMemory(),
      tools: [
        "bash",
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "write",
        "session_setup",
        "hidden_fixture",
      ],
      model,
      thinkingLevel: "off",
    });
    session = created.session;
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error: unknown) => extensionErrors.push(error) });
    assert.deepEqual(extensionErrors, []);
    assert.ok(
      session.getAllTools().some((tool: { name: string }) => tool.name === "hidden_fixture"),
    );
    assert.ok(
      !session.getAllTools().some((tool: { name: string }) => tool.name === "outside_fixture"),
    );

    const results: Array<{ toolName: string; result: unknown; isError: boolean }> = [];
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end")
        results.push({ toolName: event.toolName, result: event.result, isError: event.isError });
    });
    await session.prompt("Apply a narrow tool selection, then test the policy boundary.");
    assert.equal(index, calls.length + 1);
    assert.equal(results.length, calls.length, JSON.stringify(results));
    assert.equal(results[0]?.toolName, "session_setup");
    assert.equal(results[0]?.isError, false, JSON.stringify(results[0]));
    assert.match(JSON.stringify(results[0]?.result), /"tools":\["read","session_setup"\]/);
    assert.equal(results[1]?.isError, true, JSON.stringify(results[1]));
    assert.match(
      JSON.stringify(results[1]?.result),
      /Unknown or unavailable tools IDs: outside_fixture/,
    );
    assert.equal(results[2]?.isError, true, JSON.stringify(results[2]));
    assert.match(
      JSON.stringify(results[2]?.result),
      /Unknown or unavailable tools IDs: hidden_fixture/,
    );
    assert.equal(results[3]?.toolName, "read");
    assert.equal(results[3]?.isError, true, JSON.stringify(results[3]));
    assert.match(JSON.stringify(results[3]?.result), /pi-security|deny|blocked/i);
    assert.doesNotMatch(JSON.stringify(results[3]?.result), /session-setup-secret-canary/);
    assert.throws(
      () =>
        validateSessionSetupRequest({ op: "apply", tools: ["read"], permissions: { write: true } }),
      /Unknown session_setup field/,
    );
    assert.throws(
      () => validateSessionSetupRequest({ op: "apply", tools: ["read"], mcp: ["private-server"] }),
      /Unknown session_setup field/,
    );
  } finally {
    session?.dispose();
    process.chdir(prior.cwd);
    process.env = prior.env;
    await rm(root, { recursive: true, force: true });
  }
});
