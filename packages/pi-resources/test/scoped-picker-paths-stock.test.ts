import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { setKittyProtocolActive, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ResourceBrowser } from "pi-resource-browser";
import { sessionSetupService, type SessionSetupService } from "pi-resources/session-setup";
import resources from "../extensions/resources.ts";
import context from "../../pi-context/extensions/context.ts";
import delegation from "../../pi-delegation/extensions/subagent.ts";
import { catalogueInstructionId } from "../../pi-context/lib/instruction-selection.ts";

const nativeTheme = await import(
  new URL(
    "./modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
sdk.initTheme("dark", false);
const width = 180;
const plain = (browser: ResourceBrowser) => browser.render(width).map(stripTerminalSequences);
const text = (browser: ResourceBrowser) => plain(browser).join("\n");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settled(browser: ResourceBrowser) {
  for (let i = 0; i < 1000; i++) {
    if (!/Saving [^\n]*…/.test(text(browser))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Picker did not finish its save:\n${text(browser)}`);
}
function clickText(browser: ResourceBrowser, label: string) {
  const lines = plain(browser);
  const y = lines.findIndex((line) => line.includes(label));
  assert(y >= 0, `Missing mouse target ${label}:\n${lines.join("\n")}`);
  const x = lines[y].indexOf(label) + 1;
  const result = browser.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: 48,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(result?.handled, true, `Mouse target ${label} was not handled`);
}
async function chooseDefault(
  browser: ResourceBrowser,
  scope: "project" | "global",
  state: "inherit" | "on" | "off",
  mouse = false,
) {
  if (mouse) clickText(browser, `${scope === "project" ? "Project" : "Global"}:`);
  else browser.handleInput(scope === "project" ? "p" : "g");
  const menu = text(browser);
  const selected = /→ (Inherit|On|Off)\b/.exec(menu)?.[1]?.toLowerCase();
  assert(selected, `Default menu did not open:\n${menu}`);
  const states = ["inherit", "on", "off"];
  if (mouse) {
    clickText(
      browser,
      state === "inherit"
        ? scope === "project"
          ? "Use global default"
          : "Use native default"
        : state === "on"
          ? "Always include by default"
          : "Always exclude by default",
    );
  } else {
    for (let i = 0; i < (states.indexOf(state) - states.indexOf(selected) + 3) % 3; i++)
      browser.handleInput("\x1b[B");
    browser.handleInput("\r");
  }
  await settled(browser);
  assert.doesNotMatch(text(browser), /Default not saved|could not be enabled/);
}
async function search(browser: ResourceBrowser, query: string) {
  browser.handleInput("\x06"); // Ctrl+F, from either list or preview.
  browser.handleInput("\x15"); // Ctrl+U clears the search input.
  browser.handleInput(query);
  browser.handleInput("\r");
  for (let i = 0; i < 50; i++) browser.handleInput("\x1b[A");
  await tick();
  assert.match(text(browser), new RegExp(`╭ ${query} ·`));
}

async function fixture(t: any, mixed = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-scoped-stock-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  const globalFile = join(agentDir, "settings.json"),
    projectFile = join(cwd, ".pi/settings.json");
  const previousDir = process.env.PI_CODING_AGENT_DIR,
    previousArgv = [...process.argv];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const put = async (path: string, body: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  const packs: Record<string, string> = {};
  const ids: Record<string, { skills: string; agents: string; instructions: string }> = {};
  for (const label of ["global", "sibling", "project", "temporary"]) {
    const rootPath = join(root, `pack-${label}`);
    packs[label] = rootPath;
    await put(
      join(rootPath, "package.json"),
      JSON.stringify({
        name: `scope-${label}`,
        version: "1.0.0",
        pi: {
          extensions: [],
          skills: ["skills"],
          agents: ["agents"],
          instructions: ["instructions"],
        },
      }),
    );
    await put(
      join(rootPath, `skills/${label}-check/SKILL.md`),
      `---\nname: ${label}-check\ndescription: ${label} skill fixture\n---\nLAZY_${label}`,
    );
    await put(
      join(rootPath, `agents/${label}-worker/${label}-worker.md`),
      `---\nname: ${label}-worker\ndescription: ${label} agent fixture\nskills: []\n---\nCHILD_${label}`,
    );
    await put(
      join(rootPath, "instructions/rule.md"),
      `---\ntitle: ${label}-guidance\n---\nGUIDANCE_${label}`,
    );
    ids[label] = {
      skills: `${label}-check`,
      agents: `${label}-worker`,
      instructions: catalogueInstructionId(join(rootPath, "instructions"), "rule.md"),
    };
  }
  if (mixed)
    await put(
      join(packs.global, "skills/global-extra/SKILL.md"),
      "---\nname: global-extra\ndescription: CLI-only package member\n---\nCLI_ONLY_BODY",
    );
  await put(
    join(agentDir, "skills/native-personal/SKILL.md"),
    "---\nname: native-personal\ndescription: Native personal skill\n---\nNATIVE_BODY",
  );
  await put(join(cwd, ".agents/instructions/local.md"), "LOCAL_NATIVE_BODY");
  await put(
    globalFile,
    JSON.stringify({
      theme: "dark",
      packages: [
        mixed ? { source: packs.global, skills: ["skills/global-check/SKILL.md"] } : packs.global,
        packs.sibling,
      ],
      subagents: {
        model: "inherit",
        skills: { [ids.global.skills]: false, [ids.sibling.skills]: true },
        agents: { [ids.global.agents]: false, [ids.sibling.agents]: true },
      },
      localContext: {
        keep: "global",
        instructions: { [ids.global.instructions]: false, [ids.sibling.instructions]: true },
      },
    }),
  );
  await put(
    projectFile,
    JSON.stringify({
      packages: [packs.project],
      keep: "project",
      localContext: { keep: "project" },
    }),
  );
  process.argv = [...previousArgv, "-e", packs.temporary, ...(mixed ? ["-e", packs.global] : [])];
  const runtime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let session: sdk.AgentSession | undefined, api: sdk.ExtensionAPI, setup: SessionSetupService;
  let action: (browser: ResourceBrowser) => Promise<void> = async () => {};
  const captures: Array<{ label: string; ansi: string; plain: string; skillSources: unknown }> = [];
  const capture = (label: string, browser: ResourceBrowser) => {
    const ansi = browser.render(width).join("\n");
    captures.push({
      label,
      ansi,
      plain: stripTerminalSequences(ansi),
      skillSources: api
        .getCommands()
        .filter((command) => command.source === "skill")
        .map(({ name, sourceInfo }) => ({ name, sourceInfo })),
    });
    assert.match(ansi, /\x1b\[/, "stock theme should render ANSI styling");
  };
  const close = async () => {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session?.dispose();
    session = undefined;
  };
  const open = async (
    manager = sdk.SessionManager.create(cwd, join(agentDir, "sessions")),
    reason: "startup" | "resume" | "new" = "startup",
  ) => {
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      additionalExtensionPaths: [packs.temporary, ...(mixed ? [packs.global] : [])],
      extensionFactories: [
        {
          path: join(root, "cli-picker-extension.ts"),
          factory(pi) {
            api = pi;
            resources(pi);
            context(pi);
            delegation(pi);
            setup = sessionSetupService(pi.events)!;
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason },
    }));
    await session.bindExtensions({
      mode: "tui",
      onError(error) {
        throw error;
      },
      uiContext: {
        theme: nativeTheme.theme,
        notify() {},
        setStatus() {},
        setWidget() {},
        custom: async (factory: any) => {
          const browser = factory(
            { terminal: { rows: 48 }, requestRender() {} },
            nativeTheme.theme,
            {},
            () => {},
          );
          await tick();
          try {
            await action(browser);
          } finally {
            browser.dispose();
          }
          return true;
        },
      } as any,
    });
  };
  t.after(async () => {
    await close();
    if (process.env.PI_SCOPED_PICKER_ARTIFACT_DIR) {
      await mkdir(process.env.PI_SCOPED_PICKER_ARTIFACT_DIR, { recursive: true });
      await writeFile(
        join(
          process.env.PI_SCOPED_PICKER_ARTIFACT_DIR,
          mixed ? "scoped-stock-mixed-package.json" : "scoped-stock-pickers.json",
        ),
        JSON.stringify(captures, null, 2),
      );
    }
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    process.argv = previousArgv;
    setKittyProtocolActive(false);
    await rm(root, { recursive: true, force: true });
  });
  await open();
  const selected = () =>
    setup!.execute({ op: "list", limit: 50 }, session!.extensionRunner!.createContext()).selected;
  const run = async (command: string, plan: typeof action) => {
    action = plan;
    const entry = session!.extensionRunner!.getCommand(command);
    assert(entry, `Missing /${command}`);
    await entry.handler("", session!.extensionRunner!.createCommandContext());
  };
  const settings = async () => ({
    global: JSON.parse(await readFile(globalFile, "utf8")),
    project: JSON.parse(await readFile(projectFile, "utf8")),
  });
  return {
    root,
    agentDir,
    cwd,
    ids,
    packs,
    globalFile,
    projectFile,
    open,
    close,
    run,
    selected,
    settings,
    capture,
    get api() {
      return api!;
    },
    get session() {
      return session!;
    },
    get setup() {
      return setup!;
    },
  };
}

const choices = [
  { command: "skills", query: "global-check", kind: "skills" },
  { command: "agents", query: "global-worker", kind: "agents" },
  { command: "instructions", query: "global-guidance", kind: "instructions" },
  { command: "packages", query: "scope-global", kind: "packages" },
] as const;
const leaf = (settings: any, kind: string) =>
  kind === "instructions" ? settings.localContext?.instructions : settings.subagents?.[kind];

test(
  "stock commands drive scoped defaults through native keyboard and mouse paths",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    // Browsing preserves native Pi source ownership; it never republishes skill resources.
    const skillSource = f.api
      .getCommands()
      .find((entry) => entry.name === "skill:global-check")?.sourceInfo;
    assert.equal(
      skillSource?.scope,
      "user",
      "native personal skill ownership must remain unchanged",
    );
    const listed = f.setup.execute(
      { op: "list", kinds: ["skills"], limit: 50 },
      f.session.extensionRunner!.createContext(),
    );
    assert.equal(
      listed.candidates.find((entry) => entry.id === "global-check")?.globalDefaultable,
      true,
    );
    for (const choice of choices) {
      await t.test(`/${choice.command}: session plus Project/Global Inherit, On, Off`, async () => {
        await f.run(choice.command, async (browser) => {
          await search(browser, choice.query);
          f.capture(`${choice.command}-before`, browser);
          assert.match(text(browser), /\[Global: (OFF|ON |INHERIT|MIXED)\]/);
          const targetKinds =
            choice.kind === "packages" ? ["skills", "agents", "instructions"] : [choice.kind];
          const initialSelected = structuredClone(f.selected());
          const initialProject = (await f.settings()).project;
          for (const state of ["on", "off", "inherit"] as const) {
            await chooseDefault(browser, "global", state, state === "off");
            const saved = await f.settings();
            for (const kind of targetKinds)
              assert.equal(
                leaf(saved.global, kind)?.[f.ids.global[kind]],
                state === "inherit" ? undefined : state === "on",
              );
            assert.deepEqual(
              saved.project,
              initialProject,
              "global editing preserves project settings",
            );
            assert.deepEqual(
              f.selected(),
              initialSelected,
              "global editing preserves current session",
            );
          }
          await chooseDefault(browser, "global", "off");
          // Every producer must enable a currently OFF session when Project ON is chosen,
          // including /packages after the individual producers have already been exercised.
          if (targetKinds.some((kind) => f.selected()[kind].includes(f.ids.global[kind]))) {
            browser.handleInput("s");
            await settled(browser);
            if (targetKinds.some((kind) => f.selected()[kind].includes(f.ids.global[kind]))) {
              browser.handleInput("s");
              await settled(browser);
            }
          }
          for (const kind of targetKinds) assert(!f.selected()[kind].includes(f.ids.global[kind]));
          const beforeProject = await f.settings();
          for (const state of ["on", "off", "inherit"] as const) {
            await chooseDefault(browser, "project", state, true);
            if (state === "on") {
              f.capture(`${choice.command}-project-on`, browser);
              assert(
                browser
                  .render(width)
                  .join("\n")
                  .includes(nativeTheme.theme.fg("success", "[Project: ON ]")),
                "Project ON uses native success styling",
              );
            }
            const saved = await f.settings();
            assert.deepEqual(
              saved.global,
              beforeProject.global,
              "project editing preserves global settings",
            );
            for (const kind of targetKinds)
              assert.equal(
                leaf(saved.project, kind)?.[f.ids.sibling[kind]],
                leaf(beforeProject.project, kind)?.[f.ids.sibling[kind]],
                "editing one row preserves sibling saved state",
              );
            for (const kind of targetKinds)
              assert.equal(
                leaf(saved.project, kind)?.[f.ids.global[kind]],
                state === "inherit" ? undefined : state === "on",
              );
            for (const kind of targetKinds)
              assert(
                f.selected()[kind].includes(f.ids.global[kind]),
                "Project ON enables the current session and later default edits preserve it",
              );
          }
          clickText(browser, "Session:");
          await tick();
          for (const kind of targetKinds) assert(!f.selected()[kind].includes(f.ids.global[kind]));
          browser.handleInput("s");
          await tick();
          for (const kind of targetKinds) assert(f.selected()[kind].includes(f.ids.global[kind]));
          browser.handleInput("\x13"); // Legacy Ctrl+S.
          await settled(browser);
          assert.match(text(browser), /Project defaults saved/);
          setKittyProtocolActive(true);
          browser.handleInput("\x1b[115;6u"); // Kitty Ctrl+Shift+S.
          await settled(browser);
          assert.match(text(browser), /Global defaults|Personal defaults saved/);
          setKittyProtocolActive(false);
          const saved = await f.settings();
          for (const kind of targetKinds) {
            assert.equal(leaf(saved.global, kind)[f.ids.global[kind]], true);
            assert.equal(leaf(saved.project, kind)[f.ids.global[kind]], true);
            assert.equal(leaf(saved.global, kind)[f.ids.sibling[kind]], true);
          }
          assert.equal(saved.global.theme, "dark");
          assert.equal(saved.global.subagents.model, "inherit");
          assert.equal(saved.global.localContext.keep, "global");
          assert.equal(saved.project.keep, "project");
          assert.equal(saved.project.localContext.keep, "project");
          f.capture(`${choice.command}-after`, browser);
          assert(
            browser
              .render(width)
              .join("\n")
              .includes(nativeTheme.theme.fg("success", "[Global: ON ]")),
            "Global ON uses native success styling",
          );
          assert.doesNotMatch(
            text(browser),
            /Project: ON {2,}\]/,
            "ON does not retain the seven-column inherited-label padding",
          );
        });
        await f.run(choice.command, async (browser) => {
          await search(browser, choice.query);
          assert.match(text(browser), /\[Project: ON\s*\]/);
          assert.match(text(browser), /\[Global: ON\s*\]/);
        });
      });
    }
    for (const choice of choices) {
      for (const scope of ["project", "temporary"] as const) {
        await t.test(
          `/${choice.command}: actual ${scope} resource disables global editing`,
          async () => {
            const query =
              choice.command === "skills"
                ? `${scope}-check`
                : choice.command === "agents"
                  ? `${scope}-worker`
                  : choice.command === "instructions"
                    ? `${scope}-guidance`
                    : `scope-${scope}`;
            await f.run(choice.command, async (browser) => {
              await search(browser, query);
              const kinds =
                choice.kind === "packages" ? ["skills", "agents", "instructions"] : [choice.kind];
              if (!kinds.every((kind) => f.selected()[kind].includes(f.ids[scope][kind]))) {
                browser.handleInput("s");
                await settled(browser);
              }
              const before = await f.settings();
              assert.match(text(browser), /global UNAVAILABLE/);
              browser.handleInput("g");
              assert.match(text(browser), /Global default unavailable/);
              clickText(browser, "Global:");
              assert.match(text(browser), /Global default unavailable/);
              assert.deepEqual(
                await f.settings(),
                before,
                "disabled mouse and keyboard paths preserve settings",
              );
              f.capture(`${choice.command}-${scope}-global-disabled`, browser);
              setKittyProtocolActive(true);
              browser.handleInput("\x1b[115;6u");
              await settled(browser);
              setKittyProtocolActive(false);
              assert.match(text(browser), /selected skipped \(ineligible\)/);
              const after = await f.settings();
              assert.deepEqual(after.project, before.project);
              for (const kind of kinds)
                assert.equal(
                  leaf(after.global, kind)?.[f.ids[scope][kind]],
                  leaf(before.global, kind)?.[f.ids[scope][kind]],
                  "bulk global save skips actual project-only resource",
                );
            });
          },
        );
      }
    }
    // Save a conversation entry locally so stock Pi persists the current session choices.
    // No model/provider request is involved in this lifecycle fixture.
    await f.run("packages", async (browser) => {
      await search(browser, "scope-global");
      browser.handleInput("s");
      await settled(browser);
    });
    const resumedChoices = structuredClone(f.selected());
    f.session.sessionManager.appendMessage({
      role: "user",
      content: "Persist picker lifecycle fixture",
      timestamp: Date.now(),
    });
    const sessionFile = f.session.sessionManager.getSessionFile()!;
    await f.close();
    await f.open(sdk.SessionManager.open(sessionFile), "resume");
    assert.deepEqual(
      f.selected(),
      resumedChoices,
      "resume restores session choices despite saved defaults",
    );
    for (const choice of choices)
      await f.run(choice.command, async (browser) => {
        await search(browser, choice.query);
        assert.match(text(browser), /\[Session: OFF\]/);
        f.capture(`${choice.command}-resumed`, browser);
      });
    await f.close();
    await f.open(sdk.SessionManager.create(f.cwd, join(f.agentDir, "sessions")), "new");
    for (const kind of ["skills", "agents", "instructions"] as const)
      assert(f.selected()[kind].includes(f.ids.global[kind]), "new session uses saved defaults");
    for (const choice of choices)
      await f.run(choice.command, async (browser) => {
        await search(browser, choice.query);
        assert.match(text(browser), /\[Session: ON \]/);
        assert.match(text(browser), /\[Global: ON \]/);
        f.capture(`${choice.command}-new-session`, browser);
      });
  },
);

test(
  "stock mixed-eligibility package exposes its member scopes before global snapshots",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true);
    const listed = f.setup.execute(
      { op: "list", kinds: ["skills"], limit: 50 },
      f.session.extensionRunner!.createContext(),
    );
    const main = listed.candidates.find((entry) => entry.id === "global-check");
    const extra = listed.candidates.find((entry) => entry.id === "global-extra");
    assert.equal(main?.globalDefaultable, true);
    assert.equal(extra?.packName, "scope-global");
    assert.equal(extra?.globalDefaultable, false);
    await f.run("packages", async (browser) => {
      await search(browser, "scope-global");
      assert.match(text(browser), /Session: PARTIAL/);
      const partialBefore = await f.settings();
      setKittyProtocolActive(true);
      browser.handleInput("\x1b[115;6u");
      await settled(browser);
      setKittyProtocolActive(false);
      assert.match(text(browser), /selected skipped/);
      assert.equal(
        leaf((await f.settings()).global, "skills")?.["global-check"],
        leaf(partialBefore.global, "skills")?.["global-check"],
      );
      browser.handleInput("s");
      await settled(browser);
      assert(f.selected().skills.includes("global-extra"));
      browser.handleInput("g");
      assert.match(text(browser), /Global default unavailable/);
      f.capture("mixed-package-before-global-snapshot", browser);
      const before = await f.settings();
      setKittyProtocolActive(true);
      browser.handleInput("\x1b[115;6u");
      await settled(browser);
      setKittyProtocolActive(false);
      f.capture("mixed-package-after-global-snapshot", browser);
      const after = await f.settings();
      assert.equal(leaf(after.global, "skills")?.["global-extra"], undefined);
      assert.equal(
        leaf(after.global, "skills")?.["global-check"],
        leaf(before.global, "skills")?.["global-check"],
        "a package reported as skipped must not save its eligible members behind the disabled control",
      );
    });
  },
);
