import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SESSION_SETUP_CONTRIBUTIONS } from "pi-contracts";
import { installSessionSetup } from "pi-resources/session-setup";
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
    mode: "tui",
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

const pack = "@example/pi-evidence";

test("package availability preserves individual choices and tools through off/on and resume", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.setup.execute({ op: "list" }, f.ctx).selected);
  await f.run(async (browser) => {
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.selection("packages"), []);
    assert(
      !f.setup
        .execute({ op: "list", kinds: ["skills"] }, f.ctx)
        .candidates.some((c) => c.id === "pack-skills"),
    );
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, original);
    assert.deepEqual(f.entries.at(-1).data.states, { packages: { [pack]: true } });
    assert.equal(await readFile(f.file, "utf8"), f.before);
    f.setup.restore(f.ctx);
    assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected, original);
    f.setup.execute({ op: "apply", skills: ["standalone", "pack-skills"] }, f.ctx);
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.selection("skills"), ["standalone"]);
    await browser.toggleCurrent();
    assert.deepEqual(f.setup.selection("skills"), ["standalone", "pack-skills"]);
    assert.deepEqual(f.active, ["read", "session_setup"]);
  });
});

test("package scope and bulk saves never rewrite member settings or native package registrations", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.globalFile,
    JSON.stringify({
      subagents: { skills: { "pack-skills": false } },
      localContext: { instructions: { "pack-instructions": false } },
    }),
  );
  await f.setup.refresh(f.ctx);
  await f.run(async (browser) => {
    await browser.setScopeState("session", "off");
    for (const scope of ["project", "global"] as const)
      for (const state of ["on", "off", "inherit"] as const) {
        await browser.setScopeState(scope, state);
        assert.equal(f.setup.state("packages", pack, true).sessionState, "off");
        const saved = JSON.parse(
          await readFile(scope === "global" ? f.globalFile : f.file, "utf8"),
        );
        assert.equal(
          saved.resourcePackages?.[pack],
          state === "inherit" ? undefined : state === "on",
        );
        if (scope === "project") assert.deepEqual(saved.packages, ["native-source"]);
      }
    await browser.setScopeState("session", "on");
    await browser.saveDefaults();
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(saved.resourcePackages[pack], true);
    assert.deepEqual(saved.subagents, { model: "inherit" });
    assert.deepEqual(saved.localContext, { other: true });
    assert.deepEqual(JSON.parse(await readFile(f.globalFile, "utf8")).subagents.skills, {
      "pack-skills": false,
    });
  });
});

test("an extension-only package is selectable and session type never selects its contents", async (t) => {
  const f = await fixture(t, true, (contributions) => {
    for (const value of contributions)
      if (value.kind !== "packages") value.candidates = value.candidates.filter((c) => !c.packName);
  });
  await f.run(async (browser) => {
    await browser.setScopeMode("global", "interactive");
    assert.equal(f.setup.state("packages", pack, true).globalMode, "interactive");
    assert.deepEqual(f.setup.selection("skills"), ["standalone"]);
    f.ctx.mode = "rpc";
    await f.setup.refresh(f.ctx);
    assert.deepEqual(f.setup.selection("packages"), []);
    assert.deepEqual(f.setup.selection("skills"), ["standalone"]);
  });
});

test("untrusted project saves fail without changing package or member choices", async (t) => {
  const f = await fixture(t, false);
  await f.run(async (browser) => {
    await browser.toggleCurrent();
    await browser.saveDefaults();
    assert.match(browser.render(140).join("\n"), /Saving defaults requires a trusted project/);
    assert.equal(await readFile(f.file, "utf8"), f.before);
    assert.deepEqual(f.setup.selection("packages"), []);
    assert.deepEqual(f.setup.selection("agents"), ["standalone"]);
  });
});
