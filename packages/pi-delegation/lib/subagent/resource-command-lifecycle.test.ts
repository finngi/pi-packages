import resources from "../../../pi-resources/extensions/resources.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ResourceBrowser } from "./resource-browser.ts";

initTheme("dark", false);

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/subagent.ts";
import { sessionSetupService } from "pi-resources/session-setup";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-command-lifecycle-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));

  const commands = new Map<string, { handler: Function }>();
  const tools = new Map<string, { execute: Function }>();
  const handlers = new Map<string, Function>();
  const eventListeners = new Map<string, Function[]>();
  let started = false;
  const loadedSkills: Array<{
    name: string;
    description: string;
    source: string;
    sourceInfo: { path: string; scope?: string };
  }> = [];
  const pi = {
    on(name: string, handler: Function) {
      const previous = handlers.get(name);
      handlers.set(name, async (...args: any[]) => {
        if (name === "session_start") started = true;
        await previous?.(...args);
        const result = await handler(...args);
        return result;
      });
    },
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, {
        handler: async (args: string, ctx: any) => {
          if (!started) {
            await handlers.get("session_start")?.({}, ctx);
            await handlers.get("resources_discover")?.({}, ctx);
          }
          return command.handler(args, ctx);
        },
      });
    },
    registerFlag() {},
    getFlag() {},
    registerMessageRenderer() {},
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    appendEntry() {},
    getActiveTools: () => ["read", "session_setup"],
    getAllTools: () =>
      ["read", "session_setup"].map((name) => ({ name, description: name, exposure: "direct" })),
    setActiveTools() {},
    getThinkingLevel: () => "low",
    getCommands: () => loadedSkills,
    events: {
      on(name: string, handler: Function) {
        eventListeners.set(name, [...(eventListeners.get(name) ?? []), handler]);
      },
      emit(name: string, value: { respond?: (present: boolean) => void }) {
        for (const listener of eventListeners.get(name) ?? []) listener(value);
      },
    },
  };
  extension(pi as any);
  resources(pi as any);

  return {
    pi,
    root,
    project,
    agentDir,
    commands,
    tools,
    handlers,
    loadedSkills,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function guardedContext(
  project: string,
  selections: string[] = [],
  browserAction?: (browser: ResourceBrowser) => Promise<void>,
) {
  let stale = false;
  let reloads = 0;
  const notifications: string[] = [];
  const selectionCalls: Array<{ title: string; choices: string[] }> = [];
  const assertCurrent = () => {
    if (stale) throw Error("stale context accessed after reload");
  };
  const ui = new Proxy(
    {
      setStatus() {},
      notify(message: string) {
        notifications.push(message);
      },
      async confirm() {
        return true;
      },
      async select(title: string, choices: string[]) {
        assertCurrent();
        selectionCalls.push({ title, choices });
        return selections.shift();
      },
      ...(browserAction
        ? {
            async custom(factory: Function) {
              assertCurrent();
              let finish!: (changed: boolean) => void;
              const result = new Promise<boolean>((resolve) => {
                finish = resolve;
              });
              const browser = await factory(
                { terminal: { rows: 42 }, requestRender() {} },
                {
                  fg: (_color: string, text: string) => text,
                  bg: (_color: string, text: string) => text,
                  bold: (text: string) => text,
                },
                {},
                finish,
              );
              try {
                await browserAction(browser);
                browser.handleInput("\x1b");
                return await result;
              } finally {
                browser.dispose();
              }
            },
          }
        : {}),
    },
    {
      get(target, property, receiver) {
        assertCurrent();
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const target = {
    cwd: project,
    hasUI: true,
    ui,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    reload: async () => {
      reloads++;
      stale = true;
    },
    model: { provider: "fixture", id: "fixture-model" },
    modelRegistry: { getAvailableOfType: async () => [] },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "command-fixture",
    },
    isIdle: () => true,
  };
  const context = new Proxy(target, {
    get(object, property, receiver) {
      assertCurrent();
      return Reflect.get(object, property, receiver);
    },
  });
  return {
    context: context as unknown as ExtensionCommandContext,
    notifications,
    selectionCalls,
    get reloads() {
      return reloads;
    },
  };
}

function addSkill(root: string, name: string) {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} fixture skill\n---\nInstructions.`);
  return file;
}

async function withAgentDir<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("agent selection is session-only until explicitly saved to the project", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      await f.commands.get("agents")!.handler("none", context.context);
      assert.equal(context.reloads, 0);
      assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
      await f.commands
        .get("agents")!
        .handler("", guardedContext(f.project, ["Save project defaults", "Done"]).context);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.equal(projectSettings.subagents, undefined);
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("session agent reset preserves saved project choices and ignores unavailable names", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const bundle = join(f.agentDir, "agents", "reviewer");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, "reviewer.md"),
    "---\nname: reviewer\ndescription: Review the work\n---\nReview independently.",
  );
  const savedAgents = { "missing-agent": true, reviewer: true };
  writeFileSync(
    join(f.project, ".pi/settings.json"),
    JSON.stringify({ subagents: { agents: savedAgents } }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      await f.handlers.get("session_start")!({}, context.context);
      await f.handlers.get("resources_discover")!({}, context.context);
      await f.commands.get("agents")!.handler("none", context.context);
      const inspect = async () => {
        const result = await f.tools
          .get("session_setup")!
          .execute(
            "selection-proof",
            { op: "list", kinds: ["agents"] },
            undefined,
            undefined,
            context.context,
          );
        return result.details.selected.agents;
      };
      assert.deepEqual(await inspect(), [], "None changes this session's effective selection");
      await f.commands.get("agents")!.handler("inherit", context.context);
      assert.deepEqual(
        await inspect(),
        ["reviewer"],
        "Inherit restores the available project default",
      );
      assert.ok(
        !context.notifications.some((message) =>
          message.includes("unknown or untrusted names: missing-agent"),
        ),
        "Unavailable saved names do not leave a stale diagnostic",
      );
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.deepEqual(
        projectSettings.subagents.agents,
        savedAgents,
        "Session commands never delete saved project choices",
      );
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("agent selection does not discard an ancestor trusted for the current session", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const source = join(f.root, ".agents", "agents");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "reviewer.md"),
    "---\nname: reviewer\ndescription: A trusted reviewer\n---\nPrivate instructions.",
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      await f.commands.get("agents")!.handler(`trust ${f.root}`, context.context);
      await f.commands.get("agents")!.handler("enable reviewer", context.context);
      await f.commands.get("agents")!.handler("inspect reviewer", context.context);
      assert.equal(context.reloads, 0);
      assert.ok(context.notifications.some((message) => message.includes("A trusted reviewer")));
      assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
      await f.commands
        .get("agents")!
        .handler("", guardedContext(f.project, ["Save project defaults", "Done"]).context);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.deepEqual(projectSettings.subagents.agents, { reviewer: true });
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("re-trusting an ancestor restores a saved selection after session-start discovery", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const source = join(f.root, ".agents", "agents");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "reviewer.md"),
    "---\nname: reviewer\ndescription: A trusted reviewer\n---\nPrivate instructions.",
  );
  writeFileSync(
    join(f.project, ".pi/settings.json"),
    JSON.stringify({ subagents: { agents: { reviewer: true } } }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project, ["Done"]);
      await f.handlers.get("session_start")!({}, context.context);
      await f.commands.get("agents")!.handler(`trust ${f.root}`, context.context);

      const chooser = context.selectionCalls.find((call) => call.title === "Agents");
      assert.ok(chooser);
      assert.ok(chooser.choices.includes("[x] reviewer"));
      assert.equal(context.reloads, 0);
      assert.ok(
        !context.notifications.some((message) =>
          message.includes("unknown or untrusted names: reviewer"),
        ),
      );
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("launch lookup repairs a cached missing-name selection and browse shows the new agent selected", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  writeFileSync(
    join(f.project, ".pi/settings.json"),
    JSON.stringify({ subagents: { agents: { "late-agent": true } } }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project, ["Done"]);
      await f.handlers.get("session_start")!({}, context.context);

      const bundle = join(f.project, ".pi/agents/late-agent");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        join(bundle, "late-agent.md"),
        "---\nname: late-agent\ndescription: Created during this session\n---\nInstructions.",
      );

      await assert.rejects(
        f.tools
          .get("subagent")!
          .execute(
            "call",
            { agent: "late-agent", task: "task" },
            undefined,
            undefined,
            context.context,
          ),
        /Could not inspect late-agent capabilities\. Run \/agents to inspect diagnostics\./,
      );
      await f.commands.get("agents")!.handler("", context.context);
      assert.ok(
        context.notifications.some((message) =>
          message.includes("child model unavailable: fixture/fixture-model"),
        ),
        "the human-facing diagnostics retain the underlying launch failure",
      );
      const chooser = context.selectionCalls.find((call) => call.title === "Agents");
      assert.ok(chooser);
      assert.ok(chooser.choices.includes("[x] late-agent"));

      assert.equal(context.reloads, 0);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.deepEqual(projectSettings.subagents.agents, { "late-agent": true });
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("a direct public-skill change updates the session without a reload or settings write", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const catalogue = join(f.root, "catalogue");
  const skillPath = addSkill(catalogue, "one");
  registerNativeSkill(f, skillPath);
  writeFileSync(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        skills: Object.fromEntries(
          f.loadedSkills.map((skill) => [skill.name.replace(/^skill:/, ""), false]),
        ),
      },
    }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      await f.commands.get("skills")!.handler("enable one", context.context);
      assert.equal(context.reloads, 0);
      assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
      await f.commands
        .get("skills")!
        .handler("", guardedContext(f.project, ["Save project defaults", "Done"]).context);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.deepEqual(projectSettings.subagents.skills, { one: true });
      assert.equal(projectSettings.subagents.skillPaths, undefined);
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("skill inheritance restores saved defaults without changing their files or reloading", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const catalogue = join(f.root, "catalogue");
  const skillPath = addSkill(catalogue, "one");
  registerNativeSkill(f, skillPath);
  writeFileSync(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        skills: Object.fromEntries(
          f.loadedSkills.map((skill) => [skill.name.replace(/^skill:/, ""), false]),
        ),
      },
    }),
  );
  writeFileSync(
    join(f.project, ".pi/settings.json"),
    JSON.stringify({
      theme: "dark",
      skills: [skillPath],
      subagents: { skills: { one: true } },
    }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      await f.commands.get("skills")!.handler("inherit", context.context);
      assert.equal(context.reloads, 0);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.equal(projectSettings.theme, "dark");
      assert.deepEqual(projectSettings.subagents.skills, { one: true });
      assert.deepEqual(projectSettings.skills, [skillPath]);
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("interactive skill changes reuse one context and save only explicitly", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const catalogue = join(f.root, "catalogue");
  const alphaPath = addSkill(catalogue, "alpha");
  registerNativeSkill(f, alphaPath);
  const betaPath = addSkill(catalogue, "beta");
  registerNativeSkill(f, betaPath);
  writeFileSync(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        skills: Object.fromEntries(
          f.loadedSkills.map((skill) => [skill.name.replace(/^skill:/, ""), false]),
        ),
      },
    }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project, ["[ ] alpha", "[ ] beta", "Done"]);
      await f.commands.get("skills")!.handler("", context.context);
      assert.equal(context.reloads, 0);
      assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
      await f.commands
        .get("skills")!
        .handler("", guardedContext(f.project, ["Save project defaults", "Done"]).context);
      const projectSettings = JSON.parse(
        readFileSync(join(f.project, ".pi/settings.json"), "utf8"),
      );
      assert.deepEqual(projectSettings.subagents.skills, { alpha: true, beta: true });
      assert.equal(projectSettings.subagents.skillPaths, undefined);
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});

test("custom skill browser keeps toggles in the session and Ctrl+S saves without reloading", async () => {
  const f = fixture();
  const previous = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const catalogue = join(f.root, "catalogue");
  const alphaPath = addSkill(catalogue, "alpha"),
    betaPath = addSkill(catalogue, "beta");
  registerNativeSkill(f, alphaPath);
  registerNativeSkill(f, betaPath);
  writeFileSync(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        skills: Object.fromEntries(
          f.loadedSkills.map((skill) => [skill.name.replace(/^skill:/, ""), false]),
        ),
      },
    }),
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project, [], async (browser) => {
        await browser.toggleCurrent();
        assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
        browser.handleInput("\x1b[B");
        await browser.toggleCurrent();
        assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
        await browser.saveDefaults();
        const saved = JSON.parse(readFileSync(join(f.project, ".pi/settings.json"), "utf8"));
        assert.deepEqual(saved.subagents.skills, { alpha: true, beta: true });
        assert.equal(saved.skills, undefined);
        assert.equal(context.reloads, 0);
      });
      await f.commands.get("skills")!.handler("", context.context);
      assert.equal(context.reloads, 0);
      assert.equal(
        context.selectionCalls.length,
        0,
        "the browser must not open nested selection dialogs",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previous;
    f.dispose();
  }
});

test("custom agent browser saves only on Ctrl+S without changing context ownership", async () => {
  const f = fixture();
  const previous = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  mkdirSync(join(f.agentDir, "agents"));
  writeFileSync(
    join(f.agentDir, "agents/reviewer.md"),
    "---\nname: reviewer\ndescription: Review connected code\n---\nRead callers first.",
  );
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project, [], async (browser) => {
        await browser.toggleCurrent();
        assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
        await browser.saveDefaults();
        const saved = JSON.parse(readFileSync(join(f.project, ".pi/settings.json"), "utf8"));
        assert.deepEqual(saved.subagents.agents, { reviewer: false });
        assert.equal(context.reloads, 0);
      });
      await f.commands.get("agents")!.handler("", context.context);
      assert.equal(context.reloads, 0);
      assert.equal(context.selectionCalls.length, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previous;
    f.dispose();
  }
});

test("native temporary skills stay selected in this session but are excluded from personal saves", async () => {
  const f = fixture();
  try {
    const path = addSkill(f.root, "temporary-skill");
    f.loadedSkills.push({
      name: "temporary-skill",
      description: "CLI-only skill",
      source: "skill",
      sourceInfo: { path, scope: "temporary" },
    });
    await withAgentDir(f.agentDir, async () => {
      await f.commands
        .get("skills")!
        .handler(
          "",
          guardedContext(f.project, ["Save personal defaults (all projects)", "Done"]).context,
        );
      const personal = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
      assert.equal(personal.subagents, undefined);
      const inspected = guardedContext(f.project);
      await f.commands.get("skills")!.handler("inspect temporary-skill", inspected.context);
      assert(inspected.notifications.some((message) => message.includes("temporary-skill")));
      assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
    });
  } finally {
    f.dispose();
  }
});

test("personal skill eligibility uses native source provenance", async () => {
  const f = fixture();
  try {
    const personal = addSkill(f.root, "personal-skill");
    const project = addSkill(f.root, "project-skill");
    const temporary = addSkill(f.root, "temporary-skill");
    for (const [name, path, scope] of [
      ["personal-skill", personal, "user"],
      ["project-skill", project, "project"],
      ["temporary-skill", temporary, "temporary"],
    ]) {
      f.loadedSkills.push({
        name,
        description: name,
        source: "skill",
        sourceInfo: { path, scope },
      });
    }
    await withAgentDir(f.agentDir, async () => {
      const ctx = guardedContext(f.project);
      await f.handlers.get("session_start")!({}, ctx.context);
      await f.handlers.get("resources_discover")!({}, ctx.context);
      // Native Pi reports extension-discovered skills as temporary after binding.
      for (const skill of f.loadedSkills) skill.sourceInfo.scope = "temporary";
      const browserCtx = guardedContext(f.project, [], async (browser) => {
        browser.handleInput("\x1b[115;6u"); // Kitty Ctrl+Shift+S.
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (readFileSync(join(f.agentDir, "settings.json"), "utf8").includes("personal-skill"))
            break;
        }
        const saved = JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"));
        assert.deepEqual(saved.subagents.skills, { "personal-skill": true });
        assert.equal(existsSync(join(f.project, ".pi/settings.json")), false);
      });
      await f.commands.get("skills")!.handler("", browserCtx.context);
    });
  } finally {
    f.dispose();
  }
});

function registerNativeSkill(f: ReturnType<typeof fixture>, file: string) {
  const name = /^name: (.+)$/m.exec(readFileSync(file, "utf8"))![1];
  if (!f.loadedSkills.some((skill) => skill.name === `skill:${name}`))
    f.loadedSkills.push({
      name: `skill:${name}`,
      description: `${name} fixture skill`,
      source: "skill",
      sourceInfo: { path: file, scope: "user" },
    });
}

test("text enable/disable changes one row; other rows keep inheriting saved defaults", async () => {
  const f = fixture();
  const previousSubagent = process.env.PI_SUBAGENT;
  delete process.env.PI_SUBAGENT;
  const catalogue = join(f.root, "catalogue");
  for (const name of ["a", "b"]) registerNativeSkill(f, addSkill(catalogue, name));
  for (const name of ["reviewer", "helper"]) {
    const bundle = join(f.agentDir, "agents", name);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\nWork.`,
    );
  }
  try {
    await withAgentDir(f.agentDir, async () => {
      const context = guardedContext(f.project);
      const entries: unknown[] = [];
      (f.pi as any).appendEntry = (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data });
      (context.context.sessionManager as any).getBranch = () => entries;
      await f.handlers.get("session_start")!({}, context.context);
      await f.handlers.get("resources_discover")!({}, context.context);
      const setup = sessionSetupService(f.pi.events as any)!;
      await f.commands.get("skills")!.handler("disable a", context.context);
      await f.commands.get("agents")!.handler("disable reviewer", context.context);
      assert.deepEqual(setup.selection("skills"), ["b"]);
      assert.deepEqual(setup.selection("agents"), ["helper"]);
      writeFileSync(
        join(f.project, ".pi/settings.json"),
        JSON.stringify({ subagents: { skills: { b: false }, agents: { helper: false } } }),
      );
      setup.refresh(context.context);
      assert.deepEqual(setup.selection("skills"), [], "project OFF for b takes effect");
      assert.deepEqual(setup.selection("agents"), [], "project OFF for helper takes effect");
      assert.equal(setup.state("skills", "a").sessionState, "off");
      assert.equal(setup.state("skills", "b").sessionState, "inherit");
      await f.commands.get("skills")!.handler("all", context.context);
      assert.deepEqual(setup.selection("skills"), ["a", "b"]);
      assert.equal(setup.state("skills", "b").sessionState, "on");
      await f.commands.get("skills")!.handler("none", context.context);
      assert.deepEqual(setup.selection("skills"), []);
      assert.equal(setup.state("skills", "a").sessionState, "off");
    });
  } finally {
    if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previousSubagent;
    f.dispose();
  }
});
