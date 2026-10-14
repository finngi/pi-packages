import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SESSION_SETUP_CONTRIBUTIONS } from "pi-contracts";
import { installSessionSetup } from "pi-runtime";
import type { ResourceBrowser } from "./resource-browser.ts";
import { registerPackagePicker } from "./package-picker.ts";
initTheme("dark", false);

async function fixture(t: any, trusted = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-packages-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
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
  setup.restore(ctx);
  registerPackagePicker(
    pi,
    setup,
    () => [],
    () => [],
    () => {},
  );
  let action: (browser: ResourceBrowser) => Promise<void> = async () => {};
  return {
    root,
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
    assert.match(browser.render(120).join("\n"), /Changes apply only to this session/);
    await browser.toggleCurrent();
    const selected = f.setup.execute({ op: "list" }, f.ctx).selected;
    assert.deepEqual(selected.skills, ["standalone", "pack-skills"]);
    assert.deepEqual(selected.agents, ["standalone", "pack-agents"]);
    assert.deepEqual(selected.instructions, ["standalone", "pack-instructions"]);
    assert.deepEqual(f.active, ["read", "session_setup"]);
    assert.equal(await readFile(f.file, "utf8"), f.before);
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
    assert.deepEqual(saved.subagents.skills, ["standalone", "pack-skills"]);
    assert.deepEqual(saved.subagents.agents, ["standalone", "pack-agents"]);
    assert.deepEqual(saved.localContext.instructions, ["standalone", "pack-instructions"]);
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
    assert.match(
      browser.render(140).join("\n"),
      /Saving package defaults requires a trusted project/,
    );
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
