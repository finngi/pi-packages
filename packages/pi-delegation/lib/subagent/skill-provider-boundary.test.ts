import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SESSION_SETUP_STATE } from "pi-contracts";
import resources from "../../../pi-resources/extensions/resources.ts";
import delegation from "../../extensions/subagent.ts";

for (const scenario of [
  {
    name: "delegation alone ignores a parent session empty selection",
    provider: false,
    explicitEmpty: false,
    expected: ["check"],
  },
  {
    name: "a skills provider's parent session empty selection does not remove saved child skills",
    provider: true,
    explicitEmpty: false,
    expected: ["check"],
  },
  {
    name: "an explicit empty child skill list excludes native skills without a provider",
    provider: false,
    explicitEmpty: true,
    expected: [],
  },
]) {
  test(scenario.name, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-skill-provider-boundary-"));
    const agentDir = join(root, "agent"),
      cwd = join(root, "project");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(agentDir, "skills", "check"), { recursive: true });
    mkdirSync(cwd);
    const skillPath = join(agentDir, "skills", "check", "SKILL.md");
    writeFileSync(skillPath, "---\nname: check\ndescription: Check evidence\n---\nLAZY_SKILL_BODY");
    writeFileSync(
      join(agentDir, "agents", "worker.md"),
      `---\nname: worker\ndescription: Worker\nmodel: fixture\n${scenario.explicitEmpty ? "skills: []\n" : ""}---\nWork carefully.`,
    );
    const hooks = new Map<string, Function[]>(),
      events = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    let launched: any,
      finish: Function = () => {};
    const nativeTransport = {
      launch(spec: any) {
        launched = spec;
        return {
          id: "worker",
          done: new Promise((resolve) => {
            finish = resolve;
          }),
        };
      },
      async write(_id: string, bytes: Buffer) {
        const value = JSON.parse(bytes.toString());
        launched.onData(
          "stdout",
          Buffer.from(
            JSON.stringify({
              type: "response",
              id: value.id,
              success: true,
              data: { disposition: "queued" },
            }) + "\n",
          ),
        );
      },
      cancel() {
        finish({ id: "worker", status: "cancelled", exitCode: 0 });
      },
      status() {
        return { id: "worker", status: "running" };
      },
      read() {
        return { chunks: [], nextCursor: 0, retainedFrom: 0, gap: false };
      },
    };
    const entries: any[] = [
      {
        type: "custom",
        customType: SESSION_SETUP_STATE,
        data: { version: 1, overrides: { skills: [] }, baseTools: ["read", "session_setup"] },
      },
    ];
    let activeTools = ["read", "session_setup"];
    const add = (map: Map<string, Function[]>, name: string, fn: Function) =>
      map.set(name, [...(map.get(name) ?? []), fn]);
    const pi = {
      on: (name: string, fn: Function) => {
        add(hooks, name, fn);
      },
      registerCommand() {},
      registerFlag() {},
      getFlag() {},
      registerMessageRenderer() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      appendEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data }),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names;
      },
      getAllTools: () =>
        [...new Set(["read", ...tools.keys()])].map((name) => ({
          name,
          description: name,
          exposure: "direct",
        })),
      getThinkingLevel: () => "off",
      getCommands: () => [
        {
          name: "skill:check",
          description: "Check evidence",
          source: "skill",
          sourceInfo: { path: skillPath, scope: "user" },
        },
      ],
      events: {
        on: (name: string, fn: Function) => {
          add(events, name, fn);
        },
        emit: (name: string, value: any) => {
          for (const handler of events.get(name) ?? []) handler(value);
          if (name === "background:service") value.respond(nativeTransport);
        },
      },
    };
    const ctx = {
      cwd,
      ui: { setStatus() {}, notify() {} },
      hasUI: false,
      isProjectTrusted: () => false,
      isIdle: () => true,
      sessionManager: {
        getBranch: () => entries,
        getEntries: () => entries,
        getSessionId: () => "skill-provider-fixture",
      },
      model: { provider: "fixture", id: "fixture" },
      modelRegistry: {
        find: () => ({
          provider: "fixture",
          id: "fixture",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        getAvailableOfType: async () => [
          { provider: "fixture", id: "fixture", api: "openai-responses", reasoning: false },
        ],
        getRegisteredNativeProvider: () => undefined,
        getRegisteredProviderConfig: () => ({ api: "openai-responses", apiKey: "fixture" }),
      },
    };
    const emit = async (name: string, input: unknown) => {
      for (const handler of hooks.get(name) ?? []) await handler(input, ctx);
    };
    try {
      delegation(pi as any);
      if (scenario.provider) resources(pi as any);
      await emit("session_start", {});
      await emit("resources_discover", {});
      await emit("before_agent_start", {
        systemPromptOptions: { cwd, sections: {}, skills: [{ name: "check" }] },
      });
      await tools
        .get("subagent")
        .execute("launch", { agent: "worker", task: "Check evidence" }, undefined, undefined, ctx);
      const childSkills = launched.args.flatMap((value: string, index: number) =>
        value === "--skill" ? [launched.args[index + 1]] : [],
      );
      assert.deepEqual(
        childSkills.map((file: string) => /^name: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1]),
        scenario.expected,
      );
      assert.equal(tools.has("subagent"), true);
      assert.deepEqual(
        entries[0].data.overrides.skills,
        [],
        "the old persisted record is not rewritten to make the test pass",
      );
    } finally {
      await emit("session_shutdown", {});
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
