import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  packageApplies,
  packageAvailability,
  readResourceSelection,
  resolveResourceSelection,
  resourceSelectionState,
  selectedAgents,
  selectedSkills,
  validateResourceSelection,
  writeResourceDefault,
  writeResourceDefaults,
} from "../lib/resource-selection.ts";

test("saving one resource kind leaves absent providers' global and project defaults intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const before = {
    packages: ["native-source"],
    subagents: { agents: { reviewer: true }, skills: { old: true } },
    localContext: { instructions: { "catalogue:saved": true } },
  };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(before));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify(before));
  await writeResourceDefaults({
    scope: "global",
    agentDir,
    selections: {
      skills: {
        knownIds: ["native-source", "old"],
        values: { "native-source": false, old: false },
        snapshot: true,
      },
    },
  });
  await writeResourceDefaults({
    scope: "project",
    cwd,
    selections: {
      skills: {
        knownIds: ["native-source", "old"],
        values: { "native-source": false, old: false },
        snapshot: true,
      },
    },
  });
  for (const file of [join(agentDir, "settings.json"), join(cwd, ".pi/settings.json")]) {
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(after.subagents.agents, { reviewer: true });
    assert.deepEqual(after.localContext, before.localContext);
    assert.deepEqual(after.packages, before.packages);
    assert.deepEqual(after.subagents.skills, { "native-source": false, old: false });
  }
});

test("sparse defaults resolve project, global and native inheritance consistently", () => {
  assert.deepEqual(resolveResourceSelection(undefined, undefined, "one", true), {
    globalState: "inherit",
    projectState: "inherit",
    effective: true,
    source: "native",
  });
  assert.deepEqual(resolveResourceSelection({ one: true }, { one: false }, "one", true), {
    globalState: "on",
    projectState: "off",
    effective: false,
    source: "project",
  });
  assert.deepEqual(resolveResourceSelection({ one: false }, {}, "one", true), {
    globalState: "off",
    projectState: "inherit",
    effective: false,
    source: "global",
  });
  assert.equal(resourceSelectionState({ one: false }, "one"), "off");
  assert.equal(resourceSelectionState({}, "one"), "inherit");
  assert.deepEqual(validateResourceSelection({ one: true }, "instructions"), { one: true });
  assert.throws(() => validateResourceSelection({ one: "on" }, "instructions"), /boolean/);
  assert.throws(
    () =>
      readResourceSelection(
        SettingsManager.inMemory({ subagents: "bad" } as any),
        "global",
        "agents",
      ),
    /subagents must be an object/,
  );
  assert.throws(
    () =>
      readResourceSelection(
        SettingsManager.inMemory({ localContext: [] } as any),
        "global",
        "instructions",
      ),
    /localContext must be an object/,
  );
});

test("atomic sparse patch preserves known and unknown sibling maps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-sparse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      subagents: { skills: { kept: true, "project-only": false, "removed-from-catalogue": true } },
      localContext: { instructions: {} },
      unrelated: true,
    }),
  );
  await writeResourceDefaults({
    scope: "global",
    agentDir,
    selections: {
      skills: {
        knownIds: ["kept", "edited", "project-only"],
        values: { edited: true },
      },
      instructions: { knownIds: ["local-instruction"], values: { "local-instruction": true } },
    },
  });
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.subagents.skills, {
    kept: true,
    edited: true,
    "project-only": false,
    "removed-from-catalogue": true,
  });
  assert.deepEqual(saved.localContext.instructions, { "local-instruction": true });
  assert.equal(saved.unrelated, true);
});

test("per-row Inherit deletes only that override and preserves siblings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-project-sparse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({ localContext: { instructions: { one: true, stale: true } } }),
  );
  await writeResourceDefaults({
    scope: "project",
    cwd,
    selections: {
      instructions: { knownIds: ["one", "two"], values: { two: undefined } },
    },
  });
  const saved = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
  assert.deepEqual(saved.localContext.instructions, { one: true, stale: true });
  assert.equal(resourceSelectionState(saved.localContext.instructions, "one"), "on");
  assert.equal(resourceSelectionState(saved.localContext.instructions, "two"), "inherit");
});

test("bulk snapshots clear stale IDs but retain known ineligible rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      subagents: { agents: { reviewer: true, "project-agent": true, "missing-agent": true } },
    }),
  );
  await writeResourceDefaults({
    scope: "global",
    agentDir,
    selections: {
      agents: {
        snapshot: true,
        knownIds: ["reviewer", "project-agent"],
        values: { reviewer: false },
      },
    },
  });
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.subagents.agents, { reviewer: false, "project-agent": true });
});

test("resource IDs named __proto__ persist as ordinary map keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-proto-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeResourceDefaults({
    scope: "global",
    agentDir,
    selections: {
      instructions: {
        knownIds: ["__proto__"],
        values: Object.fromEntries([["__proto__", true]]),
      },
    },
  });
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.localContext.instructions, Object.fromEntries([["__proto__", true]]));
  assert.equal(resourceSelectionState(saved.localContext.instructions, "__proto__"), "on");
});

test("row defaults stay isolated across all resource kinds and inherited rows follow global changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-row-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });

  for (const kind of ["skills", "agents", "instructions"] as const) {
    const knownIds = ["project-on", "project-off", "inherited"];
    const globalValues = { "project-on": false, "project-off": true, inherited: true };
    const projectValues = { "project-on": true, "project-off": false };
    await writeResourceDefaults({
      scope: "global",
      agentDir,
      selections: { [kind]: { knownIds, values: globalValues } },
    });
    await writeResourceDefaults({
      scope: "project",
      cwd,
      selections: {
        [kind]: { knownIds, values: projectValues },
      },
    });

    const global = { inherited: true, "project-on": false, "project-off": true };
    const local = projectValues;
    const projectFile = join(cwd, ".pi/settings.json");
    const globalFile = join(agentDir, "settings.json");
    const savedProject = JSON.parse(await readFile(projectFile, "utf8"));
    const savedGlobal = JSON.parse(await readFile(globalFile, "utf8"));
    const projectMap =
      kind === "instructions"
        ? savedProject.localContext.instructions
        : savedProject.subagents[kind];
    const globalMap =
      kind === "instructions" ? savedGlobal.localContext.instructions : savedGlobal.subagents[kind];
    assert.deepEqual(projectMap, projectValues);
    assert.deepEqual(globalMap, global);
    assert.equal(
      resolveResourceSelection(globalMap, projectMap, "inherited", false).projectState,
      "inherit",
    );
    assert.equal(
      resolveResourceSelection(globalMap, projectMap, "inherited", false).effective,
      true,
    );

    await writeResourceDefault({
      scope: "global",
      kind,
      id: "inherited",
      state: "off",
      knownIds,
      agentDir,
    });
    const globalAfter = { ...global, inherited: false };
    assert.equal(resolveResourceSelection(globalAfter, local, "inherited", true).effective, false);
    assert.equal(resolveResourceSelection(globalAfter, local, "project-on", true).effective, true);
    assert.equal(
      resolveResourceSelection(globalAfter, local, "project-off", true).effective,
      false,
    );

    await writeResourceDefault({
      scope: "project",
      kind,
      id: "inherited",
      state: "on",
      knownIds,
      cwd,
    });
    assert.equal(
      resolveResourceSelection(globalAfter, { ...local, inherited: true }, "inherited", false)
        .effective,
      true,
    );
    await writeResourceDefault({
      scope: "project",
      kind,
      id: "inherited",
      state: "inherit",
      knownIds,
      cwd,
    });
    assert.equal(resolveResourceSelection(globalAfter, local, "inherited", false).effective, false);
  }
});

test("settings list compatibility is rejected rather than converted", () => {
  assert.throws(() => validateResourceSelection(["old"], "skills"), /ID-to-boolean map/);
});

test("the old list format names the setting to edit", () => {
  assert.throws(
    () => validateResourceSelection(["tdd"], "skills"),
    /subagents\.skills in settings\.json uses the old list format/,
  );
  assert.throws(
    () => validateResourceSelection(["a"], "instructions"),
    /localContext\.instructions in settings\.json/,
  );
});

test("unreadable package settings leave packages available instead of failing", () => {
  const choices = [
    { name: "native", description: "", path: "/n", toggleable: true, defaultSelected: true },
    {
      name: "lexical",
      description: "",
      path: "/l",
      toggleable: true,
      defaultSelected: true,
      packName: "corpus",
    },
  ];
  const agents = [{ name: "worker" }, { name: "analyst", packName: "corpus" }];
  for (const settings of [
    { resourcePackages: ["corpus"] },
    { resourcePackages: "corpus" },
    { resourcePackages: { corpus: "yes" } },
    { resourcePackages: { corpus: false }, resourceSessionTypes: { packages: { corpus: "tui" } } },
  ]) {
    const manager = SettingsManager.inMemory(settings as any);
    for (const interactive of [true, false]) {
      assert.equal(packageAvailability(manager, "corpus", interactive), "available");
      assert.equal(packageApplies(manager, "corpus", interactive), true);
      assert.deepEqual(
        selectedSkills(manager, choices, false, undefined, interactive).map((s) => s.name),
        ["lexical", "native"],
      );
      assert.deepEqual(selectedAgents(manager, agents, undefined, interactive), {
        agents,
        configured: false,
      });
    }
  }
});

test("package availability reports whether a package is off or interactive-only", () => {
  const manager = SettingsManager.inMemory({
    resourcePackages: { hidden: false },
    resourceSessionTypes: { packages: { terminal: "interactive" } },
  } as any);
  assert.equal(packageAvailability(manager, "open", false), "available");
  assert.equal(packageAvailability(manager, "hidden", true), "off");
  assert.equal(packageAvailability(manager, "terminal", true), "available");
  assert.equal(packageAvailability(manager, "terminal", false), "interactive");
});
