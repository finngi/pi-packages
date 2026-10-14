// Actual Pi context hooks and rendered prompt, with isolated settings/Git and no model calls.
// Usage: node context-check.mjs [path to @earendil-works/pi-coding-agent]
import assert from "node:assert/strict";
import { sessionSetupService } from "pi-runtime";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-context-check-")));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const savedEnv = Object.fromEntries(
  [
    "HOME",
    "XDG_CONFIG_HOME",
    "PI_CODING_AGENT_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "PI_SUBAGENT",
  ].map((key) => [key, process.env[key]]),
);
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
delete process.env.PI_SUBAGENT;
const piRoot =
  process.argv[2] ??
  fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const { default: context } = await import("./extensions/context.ts");
const { catalogueInstructionId } = await import("./lib/instruction-selection.ts");
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ProjectTrustStore,
  ModelRuntime,
} = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } = await import(
  pathToFileURL(join(piRoot, "dist/core/system-prompt.js"))
);
const credentials = {
  async read() {},
  async list() {
    return [];
  },
  async modify() {
    throw new Error("fixture auth is read-only");
  },
  async delete() {
    throw new Error("fixture auth is read-only");
  },
};
const modelRuntime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  modelsStorePath: join(root, "model-cache.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const git = (dir, ...args) =>
  execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
function repo(name) {
  const dir = join(home, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  put(join(dir, "AGENTS.md"), "---\nteamMetadata: hidden\n---\nTEAM_MARKER\n");
  put(
    join(dir, "AGENTS.local.md"),
    "\uFEFF---\ncomment: private metadata\n---\n<!-- LOCAL_BODY_COMMENT -->\nLOCAL_MARKER\n",
  );
  put(
    join(dir, ".agents/instructions/z.local.md"),
    "---\nnotes: selected private metadata\n---\n<!-- SELECTED_BODY_COMMENT -->\nSELECTED_Z_MARKER\n",
  );
  put(
    join(dir, ".agents/instructions/a.local.md"),
    "---\nnotes: [malformed closed yaml\n---\nSELECTED_A_MARKER\n",
  );
  return dir;
}
async function run(
  cwd,
  {
    enabled = true,
    trusted = true,
    flag,
    child = false,
    malformed = false,
    savedTrust = trusted,
    reload,
    agentSettings = {},
    projectSettings,
    beforeRender,
    nextTurn,
    promptOptions,
  } = {},
) {
  put(
    join(agentDir, "settings.json"),
    malformed
      ? "bad"
      : JSON.stringify({
          ...agentSettings,
          localContext: { autoGitIgnore: enabled, ...(agentSettings.localContext ?? {}) },
        }),
  );
  if (projectSettings) put(join(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  if (child) process.env.PI_SUBAGENT = "1";
  else delete process.env.PI_SUBAGENT;
  if (flag) process.argv.push(flag);
  const saved = new ProjectTrustStore(agentDir);
  if (savedTrust !== null) saved.set(cwd, savedTrust);
  let session, setup, extensionContext;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: flag === "-nc" || flag === "--no-context-files",
      extensionFactories: [
        (pi) => {
          context(pi);
          setup = sessionSetupService(pi.events);
          pi.on("session_start", (_event, ctx) => {
            extensionContext = ctx;
          });
        },
      ],
    });
    await loader.reload();
    settingsManager.setProjectTrusted(trusted);
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    }));
    const notices = [],
      errors = [];
    session.extensionRunner.onError((error) => errors.push(error.error));
    await session.bindExtensions({
      mode: "print",
      uiContext: { notify: (text) => notices.push(text), setStatus() {}, setWidget() {} },
    });
    await beforeRender?.();
    Object.assign(session._baseSystemPromptOptions, promptOptions);
    const render = async () => {
      const built = await session.extensionRunner.emitBeforeAgentStart(
        { messageType: "user", prompt: "context check" },
        session._baseSystemPromptOptions,
      );
      return {
        files: built.systemPromptOptions.contextFiles,
        instructions: built.systemPromptOptions.sections.instructions ?? "",
        sections: buildSystemPromptSections(built.systemPromptOptions),
        prompt: buildSystemPrompt(built.systemPromptOptions),
      };
    };
    const built = await render();
    if (nextTurn) {
      await nextTurn(built, { setup, ctx: extensionContext });
      return { before: built, ...(await render()) };
    }
    if (reload) {
      await reload(built);
      await session.reload();
      return { before: built, ...(await render()) };
    }
    assert.deepEqual(errors, []);
    assert.equal(
      notices.some((text) => text.includes("not git-ignored")),
      false,
    );
    return built;
  } finally {
    session?.dispose();
    if (flag) process.argv.pop();
  }
}
try {
  put(
    join(agentDir, "AGENTS.md"),
    "---\nnotes: global private metadata\n---\n<!-- GLOBAL_BODY_COMMENT -->\nGLOBAL_MARKER\n",
  );
  put(
    join(home, ".agents/instructions/home.md"),
    "---\nnotes: home private metadata\n---\nHOME_SELECTED_MARKER\n",
  );
  put(
    join(agentDir, "skills/lazy/SKILL.md"),
    "---\nname: lazy\ndescription: LAZY_CATALOGUE_DESCRIPTION\n---\nLAZY_BODY_MUST_NOT_BE_EAGER\n",
  );
  const off = repo("off");
  const offBefore = readFileSync(join(off, ".git/info/exclude"), "utf8");
  await run(off, { enabled: false });
  assert.equal(readFileSync(join(off, ".git/info/exclude"), "utf8"), offBefore);
  const on = repo("on");
  put(join(on, ".git/info/exclude"), "# existing\nother");
  const built = await run(on);
  const catalogue = join(root, "catalogue");
  const selectedCatalogueId = catalogueInstructionId(catalogue, "selected.md");
  const unusedCatalogueId = catalogueInstructionId(catalogue, "unused.md");
  put(
    join(catalogue, "selected.md"),
    "---\nnotes: hidden catalogue metadata\n---\nCATALOGUE_INSTRUCTION_MARKER\n",
  );
  put(join(catalogue, "unused.md"), "UNSELECTED_CATALOGUE_MARKER\n");
  const homeCatalogue = join(home, ".config/agents/instructions");
  put(join(homeCatalogue, "home.md"), "HOME_CATALOGUE_MARKER\n");
  const homeCatalogueId = catalogueInstructionId(homeCatalogue, "home.md");
  const tildeCatalogue = await run(repo("tilde-catalogue"), {
    agentSettings: {
      resources: { instructionCatalogues: ["~/.config/agents/instructions"] },
      localContext: { instructions: [homeCatalogueId] },
    },
  });
  assert.equal(
    tildeCatalogue.instructions.includes("HOME_CATALOGUE_MARKER"),
    true,
    "home-relative catalogue settings are expanded",
  );
  const configured = repo("configured");
  const configuredResult = await run(configured, {
    agentSettings: {
      resources: { instructionCatalogues: [catalogue] },
      localContext: { instructions: [selectedCatalogueId] },
    },
    projectSettings: { localContext: { instructions: [selectedCatalogueId] } },
  });
  assert.equal(configuredResult.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"), true);
  assert.equal(configuredResult.instructions.includes("UNSELECTED_CATALOGUE_MARKER"), false);
  assert.equal(configuredResult.instructions.includes("hidden catalogue metadata"), false);
  assert.equal(
    configuredResult.files.some((file) => file.content.includes("TEAM_MARKER")),
    true,
  );
  assert.equal(
    configuredResult.files.some((file) => file.content.includes("LOCAL_MARKER")),
    true,
  );
  const untrustedCatalogue = await run(configured, {
    trusted: false,
    agentSettings: {
      resources: { instructionCatalogues: [catalogue] },
      localContext: { instructions: [selectedCatalogueId] },
    },
    projectSettings: { localContext: { instructions: [] } },
  });
  assert.equal(
    untrustedCatalogue.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"),
    true,
    "global user defaults apply in an untrusted project",
  );
  assert.equal(
    untrustedCatalogue.files.some((file) => file.content.includes("LOCAL_MARKER")),
    false,
    "untrusted project-local overlays are not read",
  );
  const disabledCatalogue = await run(configured, {
    agentSettings: {
      resources: { instructionCatalogues: [catalogue] },
      localContext: { instructions: [selectedCatalogueId] },
    },
    projectSettings: { localContext: { instructions: [] } },
  });
  assert.equal(disabledCatalogue.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"), false);
  const noContextCatalogue = await run(configured, {
    flag: "-nc",
    agentSettings: {
      resources: { instructionCatalogues: [catalogue] },
      localContext: { instructions: [selectedCatalogueId] },
    },
  });
  assert.equal(noContextCatalogue.files.length, 0, "-nc disables all custom context injection");
  const sectionSettings = {
    resources: { instructionCatalogues: [catalogue] },
    localContext: { instructions: [selectedCatalogueId] },
  };
  const stable = await run(repo("stable-instructions"), {
    agentSettings: sectionSettings,
    promptOptions: { sections: { instructions: "HOST_INSTRUCTIONS" } },
    nextTurn() {},
  });
  assert.equal(diffSystemPromptSections(stable.before.sections, stable.sections), undefined);
  assert.equal((stable.instructions.match(/HOST_INSTRUCTIONS/g) ?? []).length, 1);
  assert.equal((stable.instructions.match(/CATALOGUE_INSTRUCTION_MARKER/g) ?? []).length, 1);
  assert(stable.prompt.includes("<instructions>\nHOST_INSTRUCTIONS"));
  const disabledDir = repo("instructions-disabled-next-turn");
  const disabled = await run(disabledDir, {
    agentSettings: sectionSettings,
    nextTurn(_built, { setup, ctx }) {
      setup.execute({ op: "apply", instructions: [] }, ctx);
    },
  });
  assert.deepEqual(diffSystemPromptSections(disabled.before.sections, disabled.sections), {
    instructions: null,
  });
  const hostDisabledDir = repo("host-instructions-disabled-next-turn");
  const hostDisabled = await run(hostDisabledDir, {
    agentSettings: sectionSettings,
    promptOptions: { sections: { instructions: "HOST_INSTRUCTIONS" } },
    nextTurn(_built, { setup, ctx }) {
      setup.execute({ op: "apply", instructions: [] }, ctx);
    },
  });
  assert.equal(hostDisabled.instructions, "HOST_INSTRUCTIONS");
  const reread = await run(repo("instructions-source-edit"), {
    agentSettings: sectionSettings,
    nextTurn() {
      put(join(catalogue, "selected.md"), "CHANGED_INSTRUCTION_BODY");
    },
  });
  assert(reread.before.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"));
  assert(reread.instructions.includes("CHANGED_INSTRUCTION_BODY"));
  assert(!reread.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"));
  put(join(catalogue, "selected.md"), "CATALOGUE_INSTRUCTION_MARKER\n");
  const custom = await run(repo("custom-instruction-prompt"), {
    agentSettings: sectionSettings,
    promptOptions: { customPrompt: "CUSTOM_PREAMBLE" },
  });
  assert.equal(custom.sections.preamble, "CUSTOM_PREAMBLE");
  assert(custom.prompt.includes("<instructions>"));
  assert(custom.prompt.includes("CATALOGUE_INSTRUCTION_MARKER"));
  const forced = await run(repo("forced-instruction-prompt"), {
    agentSettings: sectionSettings,
    promptOptions: { forceSystemPrompt: "OPAQUE_FORCED_PROMPT" },
  });
  assert.equal(forced.prompt, "OPAQUE_FORCED_PROMPT");
  const defaultsRepo = repo("defaults-snapshot");
  const firstDefaults = {
    resources: { instructionCatalogues: [catalogue] },
    localContext: { instructions: [selectedCatalogueId] },
  };
  const currentSession = await run(defaultsRepo, {
    agentSettings: firstDefaults,
    beforeRender: () =>
      put(
        join(agentDir, "settings.json"),
        JSON.stringify({
          resources: { instructionCatalogues: [catalogue] },
          localContext: { instructions: [unusedCatalogueId] },
        }),
      ),
  });
  assert.equal(currentSession.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"), true);
  assert.equal(currentSession.instructions.includes("UNSELECTED_CATALOGUE_MARKER"), false);
  const nextSession = await run(defaultsRepo, {
    agentSettings: {
      resources: { instructionCatalogues: [catalogue] },
      localContext: { instructions: [unusedCatalogueId] },
    },
  });
  assert.equal(nextSession.instructions.includes("CATALOGUE_INSTRUCTION_MARKER"), false);
  assert.equal(nextSession.instructions.includes("UNSELECTED_CATALOGUE_MARKER"), true);
  assert.deepEqual(
    built.files.filter((file) => file.path.startsWith(on)).map((file) => file.content.trim()),
    ["TEAM_MARKER", "<!-- LOCAL_BODY_COMMENT -->\nLOCAL_MARKER"],
  );
  const markers = [
    "GLOBAL_MARKER",
    "TEAM_MARKER",
    "LOCAL_MARKER",
    "HOME_SELECTED_MARKER",
    "SELECTED_A_MARKER",
    "SELECTED_Z_MARKER",
  ];
  for (const marker of markers) assert(built.prompt.includes(marker), marker);
  for (let i = 1; i < markers.length; i++)
    assert(built.prompt.indexOf(markers[i - 1]) < built.prompt.indexOf(markers[i]));
  assert(built.prompt.indexOf("TEAM_MARKER") < built.prompt.indexOf("LOCAL_MARKER"));
  for (const metadata of [
    "teamMetadata: hidden",
    "comment: private metadata",
    "global private metadata",
    "home private metadata",
    "selected private metadata",
    "malformed closed yaml",
  ])
    assert(!built.prompt.includes(metadata), metadata);
  for (const comment of [
    "<!-- GLOBAL_BODY_COMMENT -->",
    "<!-- LOCAL_BODY_COMMENT -->",
    "<!-- SELECTED_BODY_COMMENT -->",
  ])
    assert(built.prompt.includes(comment));
  assert(built.prompt.includes("LAZY_CATALOGUE_DESCRIPTION"));
  assert(!built.prompt.includes("LAZY_BODY_MUST_NOT_BE_EAGER"));
  assert(readFileSync(join(on, "AGENTS.md"), "utf8").includes("teamMetadata: hidden"));
  assert(
    readFileSync(join(on, ".agents/instructions/a.local.md"), "utf8").includes(
      "malformed closed yaml",
    ),
  );
  assert(
    built.instructions.includes(
      `<instruction path="${join(on, ".agents/instructions/a.local.md")}">`,
    ),
  );
  assert(!built.sections.project_context.includes("SELECTED_A_MARKER"));
  assert(!built.instructions.includes("TEAM_MARKER"));
  assert.equal(git(on, "check-ignore", "AGENTS.local.md"), "AGENTS.local.md");
  const once = readFileSync(join(on, ".git/info/exclude"), "utf8");
  assert.equal(once, "# existing\nother\nAGENTS.local.md\n");
  await run(on);
  assert.equal(readFileSync(join(on, ".git/info/exclude"), "utf8"), once);
  for (const [name, options] of [
    ["untrusted", { trusted: false }],
    ["no-approve", { flag: "-na" }],
    ["child", { child: true }],
    ["malformed", { malformed: true }],
    ["no-context", { flag: "-nc" }],
    ["no-context-long", { flag: "--no-context-files" }],
  ]) {
    const dir = repo(name),
      before = readFileSync(join(dir, ".git/info/exclude"), "utf8");
    const result = await run(dir, options);
    assert.equal(readFileSync(join(dir, ".git/info/exclude"), "utf8"), before);
    if (options.flag?.includes("context") || options.flag === "-nc") {
      assert.equal(result.files.length, 0);
      for (const marker of markers) assert(!result.prompt.includes(marker));
    }
  }
  const changing = repo("reload");
  put(
    join(changing, ".agents/instructions/unclosed.md"),
    "---\nnotes: [unclosed metadata\nUNCLOSED_BODY_MARKER\n",
  );
  const reloaded = await run(changing, {
    reload: async (initial) => {
      assert(initial.prompt.includes("UNCLOSED_BODY_MARKER"));
      assert(initial.prompt.includes("notes: [unclosed metadata"));
      put(
        join(agentDir, "AGENTS.md"),
        "---\nnotes: reload global metadata\n---\nGLOBAL_RELOADED_MARKER\n",
      );
      put(join(changing, "AGENTS.md"), "TEAM_RELOADED_MARKER\n<!-- TEAM_RELOADED_COMMENT -->\n");
      put(
        join(changing, "AGENTS.local.md"),
        "---\nnotes: reload local metadata\n---\nLOCAL_RELOADED_MARKER\n",
      );
      put(
        join(changing, ".agents/instructions/z.local.md"),
        "---\nnotes: reload selected metadata\n---\nSELECTED_RELOADED_MARKER\n",
      );
    },
  });
  for (const marker of [
    "GLOBAL_RELOADED_MARKER",
    "TEAM_RELOADED_MARKER",
    "LOCAL_RELOADED_MARKER",
    "SELECTED_RELOADED_MARKER",
    "<!-- TEAM_RELOADED_COMMENT -->",
  ])
    assert(reloaded.prompt.includes(marker));
  assert(!reloaded.prompt.includes("reload global metadata"));
  assert(!reloaded.prompt.includes("reload local metadata"));
  assert(!reloaded.prompt.includes("reload selected metadata"));
  assert(!reloaded.prompt.includes("SELECTED_Z_MARKER"));
  const fresh = repo("never-trusted");
  const freshBefore = readFileSync(join(fresh, ".git/info/exclude"), "utf8");
  await run(fresh, { savedTrust: null });
  assert.equal(readFileSync(join(fresh, ".git/info/exclude"), "utf8"), freshBefore);
  const ignored = repo("already-ignored");
  put(join(ignored, ".gitignore"), "AGENTS.local.md\n");
  const before = readFileSync(join(ignored, ".git/info/exclude"), "utf8");
  await run(ignored);
  assert.equal(readFileSync(join(ignored, ".git/info/exclude"), "utf8"), before);
  const hostile = repo("hostile"),
    victim = join(root, "victim");
  put(victim, "untouched");
  rmSync(join(hostile, ".git/info/exclude"));
  symlinkSync(victim, join(hostile, ".git/info/exclude"));
  await run(hostile);
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  const main = repo("main");
  git(main, "add", "AGENTS.md");
  git(main, "-c", "user.name=test", "-c", "user.email=t@example.test", "commit", "-qm", "initial");
  const wt = join(main, "wt");
  git(main, "worktree", "add", "--detach", wt, "HEAD");
  put(join(wt, "AGENTS.local.md"), "WORKTREE_LOCAL_MARKER");
  const worktree = await run(wt);
  assert(worktree.prompt.includes("WORKTREE_LOCAL_MARKER"));
  assert(!worktree.files.some((file) => file.path === join(main, "AGENTS.local.md")));
  assert.equal(git(wt, "check-ignore", "AGENTS.local.md"), "AGENTS.local.md");
  const forged = repo("forged");
  rmSync(join(forged, ".git"), { recursive: true });
  put(join(forged, ".git"), `gitdir: ${join(main, ".git")}\n`);
  const commonBefore = readFileSync(join(main, ".git/info/exclude"), "utf8");
  await run(forged);
  assert.equal(readFileSync(join(main, ".git/info/exclude"), "utf8"), commonBefore);
  const redirected = repo("symlink-git");
  rmSync(join(redirected, ".git"), { recursive: true });
  symlinkSync(join(wt, ".git"), join(redirected, ".git"));
  await run(redirected);
  assert.equal(readFileSync(join(main, ".git/info/exclude"), "utf8"), commonBefore);
  const plain = join(home, "plain");
  mkdirSync(plain);
  put(join(plain, "AGENTS.local.md"), "PLAIN_MARKER");
  assert((await run(plain)).prompt.includes("PLAIN_MARKER"));
  assert.equal(existsSync(join(plain, ".git")), false);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "stock 1.2.0 actual SDK context hook and rendered prompt",
        "behavioral instructions separate from project context",
        "unchanged turns produce no section patch; disabling deletes the section",
        "caller instructions preserved without accumulation",
        "source edits reread on next turn; custom and opaque prompts preserved",
        "global/team/local/selected metadata stripped",
        "HTML body comments and source paths preserved",
        "malformed closed metadata stripped and unclosed header preserved",
        "native lazy skill catalogue retained without eager bodies",
        "context reload",
        "both context disable flags",
        "opt-in on/off",
        "repeat idempotency",
        "untrusted/no-approve/no-context/child no writes",
        "never-trusted project no write",
        "external Git redirects refused",
        "malformed settings",
        "already ignored",
        "symlink write refused",
        "linked worktree common exclude",
        "outside Git",
      ],
    }),
  );
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
