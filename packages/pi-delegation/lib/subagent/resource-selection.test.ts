import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverResourcePackages } from "pi-runtime";
import * as sdk from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import {
  assertSafeProjectSettingsLocation,
  configuredSkillChoices,
  filterPromptSkills,
  removeProjectSkillSelection,
  selectedAgents,
  selectedSkills,
  writeProjectAgentSelection,
  writeGlobalResourceSelection,
  writeProjectSkillSelection,
} from "./resource-selection.ts";

const parse = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const name = /^name:\s*(.+)$/m.exec(match?.[1] ?? "")?.[1];
  const description = /^description:\s*(.+)$/m.exec(match?.[1] ?? "")?.[1];
  return { frontmatter: { name, description }, body: match?.[2] ?? text };
};

function skill(root: string, name: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nbody`,
  );
  return join(directory, "SKILL.md");
}

test("project skill selection narrows loaded and catalogue skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-resource-selection-"));
  const agentDir = join(root, "agent"),
    project = join(root, "project"),
    catalogue = join(root, "catalogue");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  const one = skill(catalogue, "one"),
    two = skill(catalogue, "two"),
    packageSkill = skill(join(root, "package"), "pi-help"),
    privateSkill = skill(join(project, ".pi/agents/private/skills"), "private");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ skills: ["!two"], resources: { skillCatalogues: [catalogue] } }),
  );
  writeFileSync(
    join(project, ".pi/settings.json"),
    JSON.stringify({ theme: "dark", retry: { enabled: false }, skills: [two] }),
  );
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
  try {
    const choices = configuredSkillChoices(settings, project, agentDir, [
      { name: "pi-help", path: packageSkill },
      { name: "two", path: two },
    ]);
    assert.deepEqual(
      choices.map((choice) => choice.name),
      ["one", "pi-help", "two"],
    );
    assert.equal(choices.find((choice) => choice.name === "pi-help")?.toggleable, true);
    assert.deepEqual(
      selectedSkills(settings, choices).map((x) => x.name),
      ["pi-help", "two"],
    );
    assert.ok(!choices.some((choice) => choice.path === privateSkill));

    await writeProjectSkillSelection(project, [one], ["one"]);
    await settings.reload();
    const selected = selectedSkills(settings, choices);
    assert.deepEqual(
      selected.map((choice) => choice.name),
      ["one"],
    );
    const projectConfig = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(projectConfig.skills, [two, one]);
    assert.deepEqual(projectConfig.subagents.skills, ["one"]);
    assert.deepEqual(projectConfig.subagents.skillPaths, [one]);
    assert.equal(projectConfig.theme, "dark");
    assert.deepEqual(projectConfig.retry, { enabled: false });

    await writeProjectSkillSelection(project, [], []);
    let updatedConfig = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(updatedConfig.skills, [two]);
    assert.deepEqual(updatedConfig.subagents.skills, []);
    assert.deepEqual(updatedConfig.subagents.skillPaths, []);

    await removeProjectSkillSelection(project);
    updatedConfig = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(updatedConfig.skills, [two]);
    assert.equal(Object.hasOwn(updatedConfig, "subagents"), false);
    assert.equal(updatedConfig.theme, "dark");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills inherit global defaults, an empty project override disables them, and saving defaults preserves settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-skill-defaults-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const catalogue = join(root, "catalogue");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(catalogue, { recursive: true });
  const one = skill(catalogue, "one");
  skill(catalogue, "two");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      theme: "dark",
      resources: { skillCatalogues: [catalogue] },
      subagents: { skills: ["one"] },
    }),
  );
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
  try {
    const choices = configuredSkillChoices(settings, project, agentDir, []);
    assert.deepEqual(
      selectedSkills(settings, choices).map((item) => item.name),
      ["one"],
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        theme: "dark",
        resources: { skillCatalogues: [catalogue] },
        subagents: { skills: ["two"] },
      }),
    );
    const nextSessionSettings = SettingsManager.create(project, agentDir, { projectTrusted: true });
    const nextChoices = configuredSkillChoices(nextSessionSettings, project, agentDir, []);
    assert.deepEqual(
      selectedSkills(nextSessionSettings, nextChoices).map((item) => item.name),
      ["two"],
    );
    assert.deepEqual(
      selectedSkills(settings, choices, false, { present: true, names: ["one"] }).map(
        (item) => item.name,
      ),
      ["one"],
    );
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi/settings.json"),
      JSON.stringify({ subagents: { skills: [] } }),
    );
    await settings.reload();
    assert.deepEqual(selectedSkills(settings, choices), []);
    await Promise.all([
      writeGlobalResourceSelection(agentDir, "skills", ["one"]),
      writeGlobalResourceSelection(agentDir, "agents", ["reviewer"]),
    ]);
    const persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(persisted.theme, "dark");
    assert.deepEqual(persisted.subagents.skills, ["one"]);
    assert.deepEqual(persisted.subagents.agents, ["reviewer"]);
    assert.equal(one.endsWith("SKILL.md"), true);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        resources: { skillCatalogues: [catalogue] },
        subagents: { skills: ["missing"] },
      }),
    );
    writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({}));
    const invalidSettings = SettingsManager.create(project, agentDir, { projectTrusted: true });
    assert.throws(
      () =>
        selectedSkills(
          invalidSettings,
          configuredSkillChoices(invalidSettings, project, agentDir, []),
        ),
      /unknown skill names: missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project skill selection filters Pi auto-discovered skills from prompts and children", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-stock-skills-"));
  const agentDir = join(root, "agent"),
    project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  const one = skill(join(project, ".agents/skills"), "one"),
    two = skill(join(project, ".agents/skills"), "two");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [] }));
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ skills: [one] }));
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  try {
    await loader.reload();
    const nativeSkills = loader.getSkills().skills;
    assert.ok(nativeSkills.some((loaded) => loaded.filePath === one));
    assert.ok(nativeSkills.some((loaded) => loaded.filePath === two));
    const loaded = nativeSkills.map((skill) => ({ name: skill.name, path: skill.filePath }));
    const choices = configuredSkillChoices(settings, project, agentDir, loaded);
    const inherited = selectedSkills(settings, choices).map((x) => x.name);
    assert.ok(inherited.includes("one"));
    assert.ok(inherited.includes("two"));

    await writeProjectSkillSelection(project, [], ["one"]);
    await settings.reload();
    await loader.reload();
    const selected = selectedSkills(
      settings,
      configuredSkillChoices(
        settings,
        project,
        agentDir,
        loader.getSkills().skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
      ),
    );
    assert.deepEqual(
      selected.map((x) => x.name),
      ["one"],
    );
    assert.deepEqual(
      filterPromptSkills(loader.getSkills().skills, selected).map((x) => x.name),
      ["one"],
    );
    assert.ok(loader.getSkills().skills.some((loaded) => loaded.filePath === two));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalogue skill reset removes only the native paths the extension added", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-managed-skill-paths-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ theme: "dark" }));
  try {
    const cataloguePath = skill(join(root, "catalogue"), "catalogue-only");
    await writeProjectSkillSelection(project, [cataloguePath], ["catalogue-only"]);
    let settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(settings.skills, [cataloguePath]);
    assert.deepEqual(settings.subagents.skillPaths, [cataloguePath]);
    assert.equal(settings.subagents.skillPathsCreatedSetting, true);

    await removeProjectSkillSelection(project);
    settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.equal(Object.hasOwn(settings, "skills"), false);
    assert.equal(Object.hasOwn(settings, "subagents"), false);
    assert.equal(settings.theme, "dark");

    await writeProjectSkillSelection(project, [], ["global-skill"]);
    settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.equal(Object.hasOwn(settings, "skills"), false);
    assert.deepEqual(settings.subagents.skills, ["global-skill"]);
    await removeProjectSkillSelection(project);
    settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.equal(Object.hasOwn(settings, "skills"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent project selection filters the same trusted catalogue used by the launch guard", () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-agent-selection-"));
  const globalAgents = join(root, "global/agents"),
    projectAgents = join(root, "project/.pi/agents");
  mkdirSync(globalAgents, { recursive: true });
  mkdirSync(projectAgents, { recursive: true });
  for (const name of ["general-purpose", "reviewer"])
    writeFileSync(
      join(globalAgents, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name}\n---\nbody`,
    );
  const found = discoverAgents(globalAgents, parse as any);
  const settings = SettingsManager.inMemory({ subagents: { agents: ["general-purpose"] } } as any);
  try {
    const result = selectedAgents(settings, found.agents);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.agents.map((agent) => agent.name),
      ["general-purpose"],
    );
    const newerDefaults = SettingsManager.inMemory({ subagents: { agents: ["reviewer"] } } as any);
    assert.deepEqual(
      selectedAgents(newerDefaults, found.agents).agents.map((agent) => agent.name),
      ["reviewer"],
    );
    assert.deepEqual(
      selectedAgents(newerDefaults, found.agents, {
        present: true,
        names: ["general-purpose"],
      }).agents.map((agent) => agent.name),
      ["general-purpose"],
    );
    const invalid = SettingsManager.inMemory({ subagents: { agents: ["missing"] } } as any);
    const denied = selectedAgents(invalid, found.agents);
    assert.deepEqual(denied.agents, []);
    assert.match(denied.error ?? "", /unknown or untrusted names/);
    for (const malformed of [
      { subagents: null },
      { subagents: { agents: null } },
      { subagents: { agents: [" general-purpose"] } },
      { subagents: { agents: ["general-purpose", "general-purpose"] } },
    ]) {
      const rejected = selectedAgents(SettingsManager.inMemory(malformed as any), found.agents);
      assert.deepEqual(rejected.agents, []);
      assert.ok(rejected.error);
    }
    const inherited = SettingsManager.inMemory({} as any);
    assert.deepEqual(selectedAgents(inherited, found.agents).agents, found.agents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed catalogue paths fail instead of widening the skill chooser", () => {
  const settings = SettingsManager.inMemory({
    resources: { skillCatalogues: "not-a-list" },
  } as any);
  assert.throws(
    () => configuredSkillChoices(settings, "/project", "/agent", []),
    /resources.skillCatalogues must be a list/,
  );
});

test("invalid project skill selections can be inspected for reset and project settings symlink writes are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-skill-recovery-"));
  const project = join(root, "project"),
    agentDir = join(root, "agent"),
    outside = join(root, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(project, ".pi"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [] }));
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ skills: [42] }));
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
  try {
    assert.throws(
      () => configuredSkillChoices(settings, project, agentDir, []),
      /project skills must be a list/,
    );
    const choices = configuredSkillChoices(settings, project, agentDir, [], true);
    assert.deepEqual(selectedSkills(settings, choices, true), []);
    rmSync(join(project, ".pi"), { recursive: true });
    symlinkSync(outside, join(project, ".pi"));
    await assert.rejects(
      assertSafeProjectSettingsLocation(project),
      /Refusing to write through non-directory project settings path/,
    );
    assert.throws(() => readFileSync(join(outside, "settings.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom project agent selection preserves unrelated settings and refuses settings symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-agent-settings-"));
  const project = join(root, "project"),
    agentDir = join(root, "agent"),
    outside = join(root, "outside.json");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ subagents: { agents: ["general-purpose", "reviewer"] } }),
  );
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ theme: "dark", skills: [] }));
  try {
    await writeProjectAgentSelection(project, ["general-purpose"]);
    let config = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(config.subagents.agents, ["general-purpose"]);
    assert.equal(config.theme, "dark");
    assert.deepEqual(config.skills, []);
    const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
    const selected = selectedAgents(settings, [
      { name: "general-purpose" } as any,
      { name: "reviewer" } as any,
    ]);
    assert.deepEqual(
      selected.agents.map((agent) => agent.name),
      ["general-purpose"],
    );

    writeFileSync(outside, JSON.stringify({ protected: true }));
    unlinkSync(join(project, ".pi/settings.json"));
    symlinkSync(outside, join(project, ".pi/settings.json"));
    await assert.rejects(
      writeProjectAgentSelection(project, []),
      /Refusing to replace non-regular settings file/,
    );
    assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), { protected: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent project resource writes preserve every settings field", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-project-lock-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ theme: "dark" }));
  try {
    await Promise.all([
      writeProjectAgentSelection(project, ["reviewer"]),
      writeProjectSkillSelection(project, [], ["adr"]),
    ]);
    const settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.subagents.agents, ["reviewer"]);
    assert.deepEqual(settings.subagents.skills, ["adr"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack-only skills and agents are inactive until selected while explicitly native loaded skills retain defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "pack-selection-"));
  try {
    const agentDir = join(root, "agent"),
      project = join(root, "project"),
      pack = join(root, "packs/sample");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const path = skill(join(pack, "skills"), "pack-check");
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({
        name: "sample",
        description: "Swarm coordination",
        keywords: ["bm25", "rpc"],
        pi: { skills: ["skills"], extensions: [] },
      }),
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pack] }));
    const manager = SettingsManager.create(project, agentDir, { projectTrusted: true });
    const packs = (await discoverResourcePackages(manager, project, agentDir)).packs;
    const choices = configuredSkillChoices(manager, project, agentDir, [], false, undefined, packs);
    assert.deepEqual(
      choices.map((s) => s.name),
      ["pack-check"],
    );
    assert.deepEqual(selectedSkills(manager, choices), []);
    assert.match(choices[0].packKeywords!, /sample Swarm coordination bm25 rpc/);
    assert.equal(choices[0].packName, "sample");
    const native = configuredSkillChoices(manager, project, agentDir, [
      { name: "pack-check", path: choices[0].path },
    ]);
    assert.deepEqual(
      selectedSkills(manager, native).map((s) => s.name),
      ["pack-check"],
    );
    const agents = [
      { name: "regular", description: "native", body: "", source: "user" },
      { name: "worker", description: "pack", body: "", source: "pack", catalogueOnly: true },
    ] as never;
    assert.deepEqual(
      selectedAgents(manager, agents).agents.map((a) => a.name),
      ["regular"],
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [pack],
        subagents: { skills: ["pack-check"], agents: ["worker"] },
      }),
    );
    const selectedManager = SettingsManager.create(project, agentDir, { projectTrusted: true });
    assert.deepEqual(
      selectedSkills(selectedManager, choices).map((s) => s.name),
      ["pack-check"],
    );
    assert.deepEqual(
      selectedAgents(selectedManager, agents).agents.map((a) => a.name),
      ["worker"],
    );
    assert.ok(path.endsWith("SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native temporary skills retain package ownership when a legacy catalogue has the same name", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-skill-priority-"));
  try {
    const pack = join(root, "package"),
      legacy = join(root, "legacy"),
      agentDir = join(root, "agent");
    const nativePath = skill(join(pack, "skills"), "check");
    skill(legacy, "check");
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({ name: "temporary-package", pi: { extensions: [], skills: ["skills"] } }),
    );
    const settings = SettingsManager.inMemory({ resources: { skillCatalogues: [legacy] } } as any);
    const loaded = [{ name: "check", path: nativePath }];
    const packs = (
      await discoverResourcePackages(
        settings,
        root,
        agentDir,
        [{ path: nativePath, source: "cli", scope: "temporary", origin: "top-level" }],
        [pack],
      )
    ).packs;
    const choices = configuredSkillChoices(
      settings,
      root,
      agentDir,
      loaded,
      false,
      new Set([nativePath]),
      packs,
    );
    assert.equal(choices.length, 1);
    assert.equal(choices[0].path, nativePath);
    assert.equal(choices[0].packName, "temporary-package");
    assert.equal(choices[0].defaultSelected, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
