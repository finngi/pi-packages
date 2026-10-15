import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECURITY_SERVICE, SESSION_SETUP_STATE } from "pi-contracts";
import resources from "../../../pi-resources/extensions/resources.ts";
import delegation from "../../extensions/subagent.ts";

for (const scenario of [
  {
    name: "delegation alone inherits native skills despite an old empty selection",
    provider: false,
    explicitEmpty: false,
    expected: ["check"],
  },
  {
    name: "a skills provider's explicit empty selection excludes inherited native skills",
    provider: true,
    explicitEmpty: false,
    expected: [],
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
    const transport = process.env.PI_SECURITY_TRANSPORT;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SECURITY_TRANSPORT = "extensions";
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
    const tools = new Map<string, any>(),
      described: any[] = [];
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
          if (name === SECURITY_SERVICE)
            value.respond({
              version: 1,
              prepareShell() {},
              prepareChildLaunch() {},
              async describeChild(spec: any) {
                described.push(spec);
                return {
                  tools: ["read"],
                  skills: spec.skills,
                  scope: { mode: "auto", read: "fixture", write: "fixture", network: [] },
                };
              },
            });
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
        getAvailable: () => [],
        getAvailableOfType: async () => [{ provider: "fixture", id: "fixture" }],
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
        systemPromptOptions: { sections: {}, skills: [{ name: "check" }] },
      });
      assert.equal(
        described.length,
        1,
        "the real delegation hook validates the effective child preview",
      );
      assert.deepEqual(described[0].skills, scenario.expected);
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
      if (transport === undefined) delete process.env.PI_SECURITY_TRANSPORT;
      else process.env.PI_SECURITY_TRANSPORT = transport;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
