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
import { SettingsManager, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  assertSafeProjectSettingsLocation,
  configuredSkillChoices,
  filterPromptSkills,
  selectedAgents,
  selectedSkills,
  writeResourceDefaults,
} from "pi-resources/selection";
import { discoverAgents } from "./agents.ts";
const parse = parseFrontmatter;
const saveProjectSkills = (cwd: string, _paths: string[], ids: string[], knownIds = ids) =>
  writeResourceDefaults({
    scope: "project",
    cwd,
    selections: {
      skills: {
        knownIds,
        values: Object.fromEntries(knownIds.map((id) => [id, ids.includes(id)])),
        snapshot: true,
      },
    },
  });
const saveProjectAgents = (cwd: string, ids: string[], knownIds = ids) =>
  writeResourceDefaults({
    scope: "project",
    cwd,
    selections: {
      agents: {
        knownIds,
        values: Object.fromEntries(knownIds.map((id) => [id, ids.includes(id)])),
        snapshot: true,
      },
    },
  });
function skill(root: string, name: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nbody`,
  );
  return join(directory, "SKILL.md");
}

test("only native loaded skill identities become choices; package metadata does not load excluded skills", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-skill-pool-"));
  try {
    const one = skill(root, "one"),
      excluded = skill(root, "excluded");
    const pack = {
      name: "sample",
      root,
      description: "sample",
      keywords: [],
      skills: [one, excluded],
      agents: [],
      instructions: [],
    };
    assert.deepEqual(configuredSkillChoices(root, root, [], [pack]), []);
    const choices = configuredSkillChoices(root, root, [{ name: "one", path: one }], [pack]);
    assert.deepEqual(
      choices.map((choice) => [choice.name, choice.path, choice.packName, choice.defaultSelected]),
      [["one", one, "sample", true]],
    );
    const settings = SettingsManager.inMemory({
      subagents: { skills: { one: false, excluded: true } },
    } as any);
    assert.deepEqual(selectedSkills(settings, choices), []);
    assert.deepEqual(filterPromptSkills([{ name: "one" }, { name: "excluded" }], choices), [
      { name: "one" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saving skill choices changes selection maps without registering or removing native sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-selection-save-"));
  try {
    mkdirSync(join(root, ".pi"));
    const before = { packages: ["native-package"], skills: ["native-path"], theme: "dark" };
    writeFileSync(join(root, ".pi/settings.json"), JSON.stringify(before));
    await saveProjectSkills(root, [], ["one"], ["one", "two"]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi/settings.json"), "utf8")), {
      ...before,
      subagents: { skills: { one: true, two: false } },
    });
    await saveProjectSkills(root, [], [], ["one", "two"]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi/settings.json"), "utf8")), {
      ...before,
      subagents: { skills: { one: false, two: false } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection cannot authorize untrusted agents and map defaults keep native inheritance", () => {
  const agents = [{ name: "native" }, { name: "pack", catalogueOnly: true }];
  const manager = SettingsManager.inMemory({
    subagents: { agents: { pack: true, untrusted: true, native: false } },
  } as any);
  assert.deepEqual(selectedAgents(manager, agents).agents, [agents[1]]);
  assert.deepEqual(selectedAgents(SettingsManager.inMemory({}), agents).agents, [agents[0]]);
  assert.deepEqual(
    selectedAgents(manager, agents, { present: true, values: { native: true, pack: false } })
      .agents,
    [agents[0]],
  );
});

test("project default writes refuse symlinked settings directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-defaults-symlink-"));
  try {
    mkdirSync(join(root, "project"));
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "project/.pi"), "dir");
    await assert.rejects(assertSafeProjectSettingsLocation(join(root, "project")), /non-directory/);
    await assert.rejects(saveProjectSkills(join(root, "project"), [], ["one"]), /non-directory/);
    assert.throws(() => readFileSync(join(root, "outside/settings.json")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sparse skill and agent selections preserve inherited native choices and snapshot values", () => {
  const skillManager = SettingsManager.inMemory({
    subagents: { skills: { one: true, two: false } },
  } as any);
  const choices = [
    {
      name: "one",
      description: "one",
      path: "/one/SKILL.md",
      toggleable: true,
      defaultSelected: false,
    },
    {
      name: "two",
      description: "two",
      path: "/two/SKILL.md",
      toggleable: true,
      defaultSelected: true,
    },
    {
      name: "native",
      description: "native",
      path: "/native/SKILL.md",
      toggleable: true,
      defaultSelected: true,
    },
  ];
  assert.deepEqual(
    selectedSkills(skillManager, choices).map((choice) => choice.name),
    ["native", "one"],
  );
  assert.deepEqual(
    selectedSkills(SettingsManager.inMemory({} as any), choices, false, {
      present: true,
      values: { one: false, two: true },
    }).map((choice) => choice.name),
    ["native", "two"],
  );

  const root = mkdtempSync(join(tmpdir(), "subagent-sparse-agents-"));
  const globalAgents = join(root, "global/agents");
  mkdirSync(globalAgents, { recursive: true });
  for (const name of ["general-purpose", "reviewer"])
    writeFileSync(
      join(globalAgents, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name}\n---\nbody`,
    );
  const agents = discoverAgents(globalAgents, parse as any).agents;
  try {
    const manager = SettingsManager.inMemory({
      subagents: { agents: { "general-purpose": false } },
    } as any);
    const result = selectedAgents(manager, agents);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.agents.map((agent) => agent.name),
      ["reviewer"],
    );
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
    JSON.stringify({ subagents: { agents: { "general-purpose": true, reviewer: true } } }),
  );
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ theme: "dark", skills: [] }));
  try {
    await saveProjectAgents(project, ["general-purpose"], ["general-purpose", "reviewer"]);
    let config = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.deepEqual(config.subagents.agents, { "general-purpose": true, reviewer: false });
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
      saveProjectAgents(project, [], ["general-purpose"]),
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
      saveProjectAgents(project, ["reviewer"]),
      saveProjectSkills(project, [], ["adr"]),
    ]);
    const settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.subagents.agents, { reviewer: true });
    assert.deepEqual(settings.subagents.skills, { adr: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
