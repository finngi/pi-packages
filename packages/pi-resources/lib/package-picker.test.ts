import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SESSION_SETUP_CONTRIBUTIONS } from "pi-contracts";
import { installSessionSetup } from "pi-resources/session-setup";
import { readResourceSelection, resolveResourceSelection } from "pi-resources/selection";
import type { ResourceBrowser } from "pi-resource-browser";
import { registerPackagePicker } from "./package-picker.ts";
initTheme("dark", false);

async function fixture(t: any, trusted = true, configure?: (contributions: any[]) => void) {
  const root = await mkdtemp(join(tmpdir(), "pi-packages-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });
  const globalFile = join(agentDir, "settings.json");
  await writeFile(globalFile, "{}");
  const file = join(root, ".pi/settings.json"),
    before = JSON.stringify({
      keep: 1,
      packages: ["native-source"],
      localContext: { other: true },
      subagents: { model: "inherit" },
    });
  await writeFile(file, before);
  const bus = new Map<string, Function[]>(),
    commands = new Map<string, any>(),
    entries: any[] = [];
  let active = ["read", "session_setup"],
    browser: ResourceBrowser;
  const contributions: any[] = [
    {
      kind: "packages",
      selected: [],
      candidates: [
        {
          kind: "packages",
          id: "@example/pi-evidence",
          name: "@example/pi-evidence",
          description: "Check claims",
          keywords: "evidence",
        },
      ],
    },
    ...["skills", "agents", "instructions"].map((kind) => ({
      kind,
      selected: ["standalone"],
      candidates: [
        {
          kind,
          id: "standalone",
          name: "standalone",
          description: "Individual choice",
          nativeDefault: true,
          path: "/standalone",
        },
        {
          kind,
          id: `pack-${kind}`,
          name: `pack-${kind}`,
          description: "Package member",
          packName: "@example/pi-evidence",
          path: `/pack-${kind}`,
        },
      ],
    })),
  ];
  const pi: any = {
    on() {},
    registerTool() {},
    registerCommand(name: string, value: any) {
      commands.set(name, value);
    },
    getAllTools: () => ["read", "session_setup"].map((name) => ({ name, description: name })),
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
    events: {
      on(name: string, fn: Function) {
        bus.set(name, [...(bus.get(name) ?? []), fn]);
      },
      emit(name: string, value: any) {
        for (const fn of bus.get(name) ?? []) fn(value);
      },
    },
  };
  pi.events.on(SESSION_SETUP_CONTRIBUTIONS, (request: any) =>
    contributions.forEach((value) => {
      request.contribute(value);
    }),
  );
  const setup = installSessionSetup(pi);
  const ctx: any = {
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => trusted,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "fixture", getBranch: () => entries },
    ui: {
      notify() {},
      custom: async (factory: Function) => {
        browser = factory(
          { terminal: { rows: 40 }, requestRender() {} },
          {
            fg: (_c: string, s: string) => s,
            bg: (_c: string, s: string) => s,
            bold: (s: string) => s,
          },
          {},
          () => {},
        );
        await action(browser);
        browser.dispose();
        return true;
      },
    },
  };
  configure?.(contributions);
  setup.restore(ctx);
  registerPackagePicker(pi, setup, () => []);
  let action: (browser: ResourceBrowser) => Promise<void> = async () => {};
  return {
    root,
    agentDir,
    globalFile,
    file,
    before,
    setup,
    ctx,
    contributions,
    entries,
    commands,
    get active() {
      return active;
    },
    async run(fn: typeof action) {
      action = fn;
      await commands.get("packages").handler("", ctx);
    },
  };
}

test("package toggle is session-only, preserves individual choices/tools and restores from history", async (t) => {
  const f = await fixture(t);
  await f.run(async (browser) => {
    assert.match(browser.render(120).join("\n"), /Enter\/Space changes this session/);
    await browser.toggleCurrent();
    const selected = f.setup.execute({ op: "list" }, f.ctx).selected;
    assert.deepEqual(selected.skills, ["standalone", "pack-skills"]);
    assert.deepEqual(selected.agents, ["standalone", "pack-agents"]);
    assert.deepEqual(selected.instructions, ["standalone", "pack-instructions"]);
    assert.deepEqual(f.active, ["read", "session_setup"]);
    assert.equal(await readFile(f.file, "utf8"), f.before);
    const recorded = f.entries.at(-1).data;
    assert.equal(recorded.version, 2);
    assert.deepEqual(recorded.overrides, {});
    assert.deepEqual(recorded.states, {
      skills: { "pack-skills": true },
      agents: { "pack-agents": true },
      instructions: { "pack-instructions": true },
    });
    f.setup.restore(f.ctx);
    assert.deepEqual(f.setup.selection("skills"), ["standalone", "pack-skills"]);
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.selection("skills"), ["standalone"]);
  });
});

test("Ctrl+S persists concrete project resource sets atomically and preserves unrelated settings", async (t) => {
  const f = await fixture(t);
  await f.run(async (browser) => {
    await browser.toggleCurrent();
    await browser.saveDefaults();
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.deepEqual(saved.subagents.skills, { standalone: true, "pack-skills": true });
    assert.deepEqual(saved.subagents.agents, { standalone: true, "pack-agents": true });
    assert.deepEqual(saved.localContext.instructions, {
      standalone: true,
      "pack-instructions": true,
    });
    assert.deepEqual(saved.packages, ["native-source"]);
    assert.equal(saved.keep, 1);
    assert.equal(saved.subagents.model, "inherit");
    assert.equal(saved.localContext.other, true);
    assert.match(browser.render(120).join("\n"), /Project defaults saved/);
    const manager = SettingsManager.create(f.root, f.root, { projectTrusted: true });
    assert.deepEqual(
      (manager.getProjectSettings() as any).subagents.skills,
      saved.subagents.skills,
    );
  });
});

test("untrusted projects can make session choices but cannot save project defaults", async (t) => {
  const f = await fixture(t, false);
  await f.run(async (browser) => {
    await browser.toggleCurrent();
    await browser.saveDefaults();
    assert.match(browser.render(140).join("\n"), /Saving defaults requires a trusted project/);
    assert.equal(await readFile(f.file, "utf8"), f.before);
    assert.deepEqual(f.setup.selection("agents"), ["standalone", "pack-agents"]);
  });
});

test("a partial package is visible and selecting it fills only its public members", async (t) => {
  const f = await fixture(t);
  f.setup.execute({ op: "apply", skills: ["standalone", "pack-skills"] }, f.ctx);
  await f.run(async (browser) => {
    assert.match(browser.render(120).join("\n"), /partial/);
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.selection("agents"), ["standalone", "pack-agents"]);
  });
});

test("saving package defaults preserves settings for absent resource providers", async (t) => {
  const f = await fixture(t);
  f.contributions.splice(
    0,
    f.contributions.length,
    ...f.contributions.filter((value) => value.kind !== "agents" && value.kind !== "instructions"),
  );
  await writeFile(
    f.file,
    JSON.stringify({
      packages: ["native-source"],
      subagents: { agents: ["saved-agent"] },
      localContext: { instructions: ["saved-instruction"] },
    }),
  );
  await f.run(async (browser) => {
    await browser.toggleCurrent();
    await browser.saveDefaults();
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.deepEqual(saved.subagents.agents, ["saved-agent"]);
    assert.deepEqual(saved.localContext.instructions, ["saved-instruction"]);
    assert.deepEqual(saved.subagents.skills, { standalone: true, "pack-skills": true });
    assert.deepEqual(saved.packages, ["native-source"]);
    assert.deepEqual(f.setup.selection("agents"), []);
    assert.deepEqual(f.setup.selection("instructions"), []);
    assert.equal(
      f.setup.inspect(f.ctx).some((value) => value.kind === "agents"),
      false,
    );
    assert.equal(
      f.setup.inspect(f.ctx).some((value) => value.kind === "instructions"),
      false,
    );
    assert.deepEqual(f.entries.at(-1).data.states, { skills: { "pack-skills": true } });
  });
});

test("package scope edits isolate members and inherit without rewriting session or other choices", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.file,
    JSON.stringify({
      subagents: { skills: { standalone: false }, agents: { standalone: false } },
      localContext: { instructions: { standalone: false } },
    }),
  );
  await f.setup.refresh(f.ctx);
  await f.run(async (browser) => {
    assert.match(browser.render(160).join("\n"), /Project: INHERIT/);
    await browser.setScopeState("session", "off");
    const sessionBefore = f.setup.execute({ op: "list" }, f.ctx).selected;
    await browser.setScopeState("project", "on");
    assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, sessionBefore);
    assert.match(browser.render(160).join("\n"), /Session: OFF/);
    for (const state of ["off", "inherit"] as const) {
      await browser.setScopeState("project", state);
      assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, sessionBefore);
      const saved = JSON.parse(await readFile(f.file, "utf8"));
      assert.equal(saved.subagents.skills.standalone, false);
      assert.equal(saved.subagents.agents.standalone, false);
      assert.equal(saved.localContext.instructions.standalone, false);
      if (state === "inherit")
        assert.equal(Object.hasOwn(saved.subagents.skills, "pack-skills"), false);
    }
    await browser.setScopeState("global", "on");
    const manager = SettingsManager.create(f.root, f.agentDir, { projectTrusted: true });
    for (const kind of ["skills", "agents", "instructions"] as const) {
      const row = resolveResourceSelection(
        readResourceSelection(manager, "global", kind),
        readResourceSelection(manager, "project", kind),
        `pack-${kind}`,
        false,
      );
      assert.equal(row.projectState, "inherit");
      assert.equal(row.effective, true);
      assert.equal(
        resolveResourceSelection(
          readResourceSelection(manager, "global", kind),
          readResourceSelection(manager, "project", kind),
          "standalone",
          true,
        ).effective,
        false,
      );
    }
    assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, sessionBefore);
    await browser.setScopeState("project", "on");
    await browser.setScopeState("global", "off");
    assert.match(browser.render(160).join("\n"), /Project: ON/);
    await browser.setScopeState("global", "inherit");
    assert.match(browser.render(160).join("\n"), /Global: INHERIT/);
    await browser.setScopeState("session", "on");
    const explicitOn = f.setup.execute({ op: "list" }, f.ctx).selected;
    assert.deepEqual(explicitOn.skills, ["pack-skills"]);
    await browser.setScopeState("project", "off");
    await browser.setScopeState("global", "off");
    assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, explicitOn);
    assert.match(browser.render(160).join("\n"), /Session: ON/);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(saved.subagents.skills.standalone, false);
    assert.equal(saved.subagents.agents.standalone, false);
    assert.equal(saved.localContext.instructions.standalone, false);
  });
});

test("editing a global package preserves explicit OFF for a project-only native sibling", async (t) => {
  const f = await fixture(t);
  const instructions = f.contributions.find((value) => value.kind === "instructions");
  instructions.candidates[0].globalDefaultable = false;
  await writeFile(
    f.globalFile,
    JSON.stringify({
      subagents: { skills: { standalone: false }, agents: { standalone: false } },
      localContext: { instructions: { standalone: false } },
    }),
  );
  await f.run(async (browser) => {
    await browser.setScopeState("global", "on");
    const saved = JSON.parse(await readFile(f.globalFile, "utf8"));
    assert.equal(saved.localContext.instructions.standalone, false);
    assert.equal(saved.localContext.instructions["pack-instructions"], true);
    assert.equal(saved.subagents.skills.standalone, false);
    assert.equal(saved.subagents.agents.standalone, false);
  });
});

test("bulk personal save respects skipped package rows instead of saving a partial package", async (t) => {
  const packId = "@example/pi-evidence";
  const f = await fixture(t, true, (contributions) => {
    contributions.find((value) => value.kind === "instructions").candidates[1].globalDefaultable =
      false;
    contributions
      .find((value) => value.kind === "packages")
      .candidates.push({
        kind: "packages",
        id: "other-package",
        name: "other-package",
        description: "Eligible package",
      });
    contributions
      .find((value) => value.kind === "skills")
      .candidates.push({
        kind: "skills",
        id: "other-skill",
        name: "other-skill",
        description: "Eligible member",
        packName: "other-package",
        path: "/other-skill",
      });
  });
  f.setup.execute({ op: "apply", packages: [packId, "other-package"] }, f.ctx);
  await f.run(async (browser) => {
    browser.handleInput("\x1b[115;6u");
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (browser.render(180).join("\n").includes("selected saved")) break;
    }
    const saved = JSON.parse(await readFile(f.globalFile, "utf8"));
    assert.equal(saved.subagents.skills["other-skill"], true);
    assert.equal(Object.hasOwn(saved.subagents.skills, "pack-skills"), false);
    assert.equal(Object.hasOwn(saved.subagents.agents ?? {}, "pack-agents"), false);
    assert.equal(Object.hasOwn(saved.localContext?.instructions ?? {}, "pack-instructions"), false);
    assert.match(browser.render(180).join("\n"), /1 selected saved; 1 selected skipped/);
    assert.equal(await readFile(f.file, "utf8"), f.before);
  });
});
