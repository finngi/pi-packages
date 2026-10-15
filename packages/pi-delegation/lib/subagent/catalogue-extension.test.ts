import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../../extensions/subagent.ts";

test("parent hook refreshes validated discovery, excludes untrusted agents and diagnoses unavailable names", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-catalogue-"));
  const agentDir = join(root, "global"),
    project = join(root, "project");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(project, ".pi/agents"), { recursive: true });
  const put = (dir: string, name: string) =>
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} description\nmodel: fixture\nnotes: private metadata\n---\nprivate child body`,
    );
  put(join(agentDir, "agents"), "available");
  put(join(agentDir, "agents"), "not_selected");
  put(join(project, ".pi/agents"), "untrusted");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      subagents: { agents: { available: true, not_selected: false, newly_added: false } },
    }),
  );
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let modelAvailabilityCalls = 0;
  let failOnAvailabilityCall = -1;
  let hostileFailure = false;
  let activeTools = ["read", "session_setup"];
  let availableModels = [{ provider: "fixture", id: "fixture", reasoning: false }];
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: () => {},
    registerFlag() {},
    getFlag() {},
    registerMessageRenderer: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: () => {},
    getActiveTools: () => activeTools,
    getAllTools: () =>
      ["read", "write", "session_setup"].map((name) => ({
        name,
        description: name,
        exposure: "direct",
      })),
    setActiveTools() {},
    getThinkingLevel: () => "off",
    getCommands: () => [],
    events: { on() {}, emit() {} },
  };
  const ctx = {
    cwd: project,
    isProjectTrusted: () => false,
    isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => "catalogue-fixture" },
    model: { provider: "fixture", id: "fixture" },
    modelRegistry: {
      async getAvailableOfType() {
        modelAvailabilityCalls++;
        if (modelAvailabilityCalls === failOnAvailabilityCall) {
          if (hostileFailure)
            throw {
              toString() {
                throw Error("private skill body at /private/agent/skills/private-review/SKILL.md");
              },
            };
          throw Error("private-review at /private/agent/skills/private-review/SKILL.md");
        }
        return availableModels;
      },
    },
  };
  try {
    extension(pi as any);
    const hook = handlers.get("before_agent_start")!;
    await handlers.get("session_start")!({}, ctx);
    let input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    assert.equal(await hook(input, ctx), undefined);
    let prompt = (input.systemPromptOptions.sections as any).agents;
    assert.match(prompt, /available description/);
    for (const excluded of ["untrusted", "private metadata", "private child body"])
      assert.ok(!prompt.includes(excluded));
    put(join(agentDir, "agents"), "newly_added");
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    prompt = (input.systemPromptOptions.sections as any).agents;
    assert.ok(!prompt.includes("newly_added description"));
    assert.ok(!prompt.includes("not_selected description"));
    await handlers.get("session_start")!({}, ctx);
    await assert.rejects(
      tools
        .get("subagent")
        .execute("call", { agent: "guessed", task: "task" }, undefined, undefined, ctx),
      /Available named agents:[\s\S]*available/,
    );
    assert.ok(
      tools.get("subagent").parameters.properties.model,
      "model selection is a real tool parameter",
    );
    availableModels = [
      { provider: "fixture", id: "fixture", reasoning: false },
      { provider: "fixture", id: "alternate", reasoning: false },
    ];
    await assert.rejects(
      tools
        .get("subagent")
        .execute(
          "locked",
          { agent: "available", task: "task", model: "fixture/alternate" },
          undefined,
          undefined,
          ctx,
        ),
      /user-configured model "fixture\/fixture".*conflicts/,
    );
    const descriptionsBeforeRejectedLaunch = modelAvailabilityCalls;
    await assert.rejects(
      tools
        .get("subagent")
        .execute("call", { agent: "not_selected", task: "task" }, undefined, undefined, ctx),
      /Available named agents:[\s\S]*available/,
    );
    assert.equal(
      modelAvailabilityCalls,
      descriptionsBeforeRejectedLaunch,
      "a deselected agent is rejected before child preparation",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ subagents: { agents: { not_selected: true } } }),
    );
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    assert.ok(
      !(input.systemPromptOptions.sections as any).agents.includes("not_selected description"),
    );
    await handlers.get("session_start")!({}, ctx);
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    assert.match((input.systemPromptOptions.sections as any).agents, /not_selected description/);

    const bundle = join(agentDir, "agents", "private-worker");
    mkdirSync(join(bundle, "skills", "private-review"), { recursive: true });
    writeFileSync(
      join(bundle, "private-worker.md"),
      "---\nname: private-worker\ndescription: Project worker\n---\nPrivate worker instructions.",
    );
    const privateSkill = join(bundle, "skills", "private-review", "SKILL.md");
    writeFileSync(
      privateSkill,
      "---\nname: private-review\ndescription: Child-only checklist.\n---\nPrivate checklist instructions.",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ subagents: { agents: { not_selected: true, "private-worker": true } } }),
    );
    await handlers.get("session_start")!({}, ctx);
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    const refreshedPrompt = (input.systemPromptOptions.sections as any).agents as string;
    assert.match(refreshedPrompt, /private-worker/);
    for (const hidden of [
      "private-review",
      "Child-only checklist",
      "Private checklist instructions",
      privateSkill,
    ])
      assert.ok(!refreshedPrompt.includes(hidden), `parent catalogue leaked ${hidden}`);
    assert.doesNotMatch(refreshedPrompt, /capabilities unavailable/);
    assert.match(refreshedPrompt, /host permissions/);
    activeTools = ["read", "write", "session_setup"];
    await assert.rejects(
      tools
        .get("subagent")
        .execute("call", { agent: "private-worker", task: "task" }, undefined, undefined, ctx),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Review tools and scope before launching private-worker/);
        for (const hidden of [
          "private-review",
          "/private/agent/skills",
          "/private/parent-secret",
          "/private/trusted-code",
        ])
          assert.ok(!message.includes(hidden), `preview error leaked ${hidden}`);
        return true;
      },
    );

    failOnAvailabilityCall = modelAvailabilityCalls + 3;
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    const failedPrompt = (input.systemPromptOptions.sections as any).agents as string;
    for (const hidden of [
      "private-review",
      "/private/agent/skills",
      "/private/parent-secret",
      "/private/trusted-code",
    ])
      assert.ok(!failedPrompt.includes(hidden), `preview failure prompt leaked ${hidden}`);
    assert.match(failedPrompt, /Run \/agents to inspect diagnostics/);

    failOnAvailabilityCall = modelAvailabilityCalls + 2;
    hostileFailure = true;
    await assert.rejects(
      tools
        .get("subagent")
        .execute("call", { agent: "private-worker", task: "task" }, undefined, undefined, ctx),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Could not inspect private-worker capabilities/);
        assert.ok(!message.includes("private skill body"));
        assert.ok(!message.includes("/private/agent/skills"));
        return true;
      },
    );
    ctx.modelRegistry.getAvailableOfType = async () => {
      throw Error("private auth diagnostic");
    };
    input = {
      systemPrompt: "base",
      systemPromptOptions: { cwd: project, contextFiles: [], sections: {} },
    };
    await hook(input, ctx);
    assert.match(
      (input.systemPromptOptions.sections as any).agents,
      /Run \/agents to inspect diagnostics/,
    );
    assert.ok(
      !(input.systemPromptOptions.sections as any).agents.includes("private auth diagnostic"),
    );
  } finally {
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgent;
    rmSync(root, { recursive: true });
  }
});
