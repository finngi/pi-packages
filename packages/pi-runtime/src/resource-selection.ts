import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { type ResourcePackage, resourcePackageKeywords } from "./resource-packages.ts";

const { lock } = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

type ResourceSettings = {
  skills?: string[];
  subagents?: {
    agents?: string[];
    skills?: string[];
    skillPaths?: string[];
    skillPathsCreatedSetting?: boolean;
  };
  resources?: { skillCatalogues?: string[] };
};

export interface SkillChoice {
  name: string;
  description: string;
  path: string;
  toggleable: boolean;
  defaultSelected: boolean;
  manualOnly?: boolean;
  packName?: string;
  packKeywords?: string;
}
export interface GlobalSelectionSnapshot {
  present: boolean;
  names?: string[];
}

export function configuredSkillChoices(
  settings: SettingsManager,
  cwd: string,
  agentDir: string,
  loaded: Array<{ name: string; path: string }>,
  ignoreInvalidProjectSelection = false,
  defaultPaths?: ReadonlySet<string>,
  packs: ResourcePackage[] = [],
): SkillChoice[] {
  const global = settings.getGlobalSettings() as ResourceSettings;
  const project = settings.getProjectSettings() as ResourceSettings;
  if (
    Object.hasOwn(global, "resources") &&
    (!global.resources || typeof global.resources !== "object" || Array.isArray(global.resources))
  )
    throw Error("resources must be an object");
  const globalSkills = Object.hasOwn(global, "skills") ? global.skills : [];
  const catalogues =
    global.resources && Object.hasOwn(global.resources, "skillCatalogues")
      ? global.resources.skillCatalogues
      : [];
  const projectSkills = Object.hasOwn(project, "skills") ? project.skills : [];
  for (const [label, paths] of [
    ["global skills", globalSkills],
    ["resources.skillCatalogues", catalogues],
    ["project skills", projectSkills],
  ] as const) {
    if (
      (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) &&
      !(label === "project skills" && ignoreInvalidProjectSelection)
    )
      throw Error(`${label} must be a list of paths`);
  }
  const validGlobalSkills = Array.isArray(globalSkills) ? globalSkills : [];
  const validCatalogues = Array.isArray(catalogues) ? catalogues : [];
  const validProjectSkills = Array.isArray(projectSkills) ? projectSkills : [];
  const projectSubagents = project.subagents;
  const managedPaths = projectSubagents?.skillPaths;
  if (
    managedPaths !== undefined &&
    (!Array.isArray(managedPaths) || managedPaths.some((path) => typeof path !== "string")) &&
    !ignoreInvalidProjectSelection
  )
    throw Error("project subagents.skillPaths must be a list of paths");
  const managedPathSet = new Set(
    (Array.isArray(managedPaths) ? managedPaths : []).map((path) => resolve(cwd, path)),
  );
  const exclusions = validGlobalSkills
    .filter((path) => path.startsWith("!"))
    .map((path) => path.slice(1).trim())
    .filter(Boolean);
  const packSkills = new Map(
    packs.flatMap((pack) => pack.skills.map((path) => [path, pack] as const)),
  );
  const roots = [
    // Pi has already resolved name collisions; catalogues must not replace its loaded definition.
    ...loaded.map((skill) => skill.path),
    ...validGlobalSkills.filter((path) => !path.startsWith("!")),
    ...validCatalogues,
    ...packSkills.keys(),
    ...validProjectSkills.filter((path): path is string => typeof path === "string"),
  ];
  const discovered = loadSkills({
    cwd,
    agentDir,
    skillPaths: roots,
    includeDefaults: false,
  }).skills;
  const byPath = new Map<string, SkillChoice>();
  for (const skill of discovered) {
    const key = resolve(cwd, skill.filePath);
    const pack = packSkills.get(key);
    byPath.set(key, {
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      toggleable: true,
      defaultSelected: false,
      ...(pack ? { packName: pack.name, packKeywords: resourcePackageKeywords(pack) } : {}),
      ...(skill.disableModelInvocation ? { manualOnly: true } : {}),
    });
  }
  for (const skill of loaded) {
    const key = resolve(cwd, skill.path);
    const configured = byPath.get(key);
    if (configured)
      configured.defaultSelected = defaultPaths ? defaultPaths.has(key) : !managedPathSet.has(key);
    else
      byPath.set(key, {
        name: skill.name,
        description: "Currently loaded by Pi",
        path: skill.path,
        toggleable: true,
        defaultSelected: defaultPaths ? defaultPaths.has(key) : !managedPathSet.has(key),
      });
  }
  const byName = new Map<string, SkillChoice>();
  for (const choice of byPath.values()) {
    const existing = byName.get(choice.name);
    if (!existing || (choice.defaultSelected && !existing.defaultSelected))
      byName.set(choice.name, choice);
  }
  return [...byName.values()]
    .filter(
      (skill) =>
        skill.defaultSelected ||
        !exclusions.some((pattern) => pattern === skill.name || pattern === skill.path),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectedSkills(
  settings: SettingsManager,
  choices: SkillChoice[],
  ignoreInvalidProjectSelection = false,
  globalSnapshot?: GlobalSelectionSnapshot,
): SkillChoice[] {
  const project = settings.getProjectSettings() as ResourceSettings;
  const subagents = project.subagents;
  if (
    subagents !== undefined &&
    (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
  ) {
    if (ignoreInvalidProjectSelection) return [];
    throw Error("project subagents setting must be an object");
  }
  const global = settings.getGlobalSettings() as ResourceSettings;
  const globalSubagents = global.subagents;
  const inherited = !subagents || !Object.hasOwn(subagents, "skills");
  const names = inherited
    ? globalSnapshot
      ? globalSnapshot.present
        ? globalSnapshot.names
        : undefined
      : globalSubagents?.skills
    : subagents.skills;
  if (names === undefined)
    return choices.filter((choice) => choice.defaultSelected && choice.toggleable);
  if (
    !Array.isArray(names) ||
    names.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim()) ||
    new Set(names).size !== names.length
  ) {
    if (ignoreInvalidProjectSelection) return [];
    throw Error("project subagents.skills must be a list of unique skill names");
  }
  const byName = new Map(choices.filter((choice) => choice.toggleable).map((x) => [x.name, x]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length) {
    if (ignoreInvalidProjectSelection) return [];
    throw Error(`project subagents.skills contains unknown skill names: ${missing.join(", ")}`);
  }
  const selected = new Set(names);
  return choices
    .filter((choice) => choice.toggleable && selected.has(choice.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeGlobalResourceSelection(
  agentDir: string,
  key: "agents" | "skills",
  names: string[],
): Promise<void> {
  return updateSettingsFile(join(resolve(agentDir), "settings.json"), (current) => {
    const value = current.subagents;
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      throw Error("Global settings subagents value must be an object");
    current.subagents = { ...(value as Record<string, unknown> | undefined), [key]: names };
  });
}

async function updateSettingsFile(
  file: string,
  update: (settings: Record<string, unknown>) => void,
) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw Error(`Refusing to write through non-directory settings path ${directory}`);
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile("{}\n", "utf8");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lock(file, {
    realpath: false,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    let current: Record<string, unknown> = {};
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw Error(`Refusing to replace non-regular settings file ${file}`);
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error(`Settings must contain a JSON object: ${file}`);
      current = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    update(current);
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  } finally {
    await release();
  }
}

export function filterPromptSkills<T extends { name: string }>(
  skills: T[],
  selected: SkillChoice[],
): T[] {
  const names = new Set(selected.map((skill) => skill.name));
  return skills.filter((skill) => names.has(skill.name));
}

export function selectedAgents<T extends { name: string; catalogueOnly?: boolean }>(
  settings: SettingsManager,
  agents: T[],
  globalSnapshot?: GlobalSelectionSnapshot,
): { agents: T[]; configured: boolean; error?: string } {
  const project = settings.getProjectSettings() as ResourceSettings;
  const global = settings.getGlobalSettings() as ResourceSettings;
  const nestedSelection = (settings: ResourceSettings) => {
    if (!Object.hasOwn(settings, "subagents")) return { present: false as const };
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
      return { present: true as const, error: "subagents must be an object" };
    if (!Object.hasOwn(subagents, "agents")) return { present: false as const };
    return { present: true as const, value: subagents.agents };
  };
  const projectSelection = nestedSelection(project);
  const currentGlobalSelection = nestedSelection(global);
  const globalSelection = globalSnapshot
    ? globalSnapshot.present
      ? { present: true as const, value: globalSnapshot.names }
      : { present: false as const }
    : currentGlobalSelection;
  const chosen = projectSelection.present ? projectSelection : globalSelection;
  if ("error" in chosen) return { agents: [], configured: true, error: chosen.error };
  if (!chosen.present)
    return { agents: agents.filter((agent) => !agent.catalogueOnly), configured: false };
  const selection = chosen.value;
  if (
    !Array.isArray(selection) ||
    selection.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim())
  )
    return {
      agents: [],
      configured: true,
      error: "subagents.agents must be a list of non-empty names",
    };
  const names = new Set(selection);
  if (names.size !== selection.length)
    return {
      agents: [],
      configured: true,
      error: "subagents.agents must not contain duplicate names",
    };
  const known = new Set(agents.map((agent) => agent.name));
  const invalid = [...names].filter((name) => !known.has(name));
  if (invalid.length)
    return {
      agents: [],
      configured: true,
      error: `subagents.agents contains unknown or untrusted names: ${invalid.join(", ")}`,
    };
  return { agents: agents.filter((agent) => names.has(agent.name)), configured: true };
}

async function updateProjectSettingsFile(
  cwd: string,
  update: (settings: Record<string, unknown>) => void,
): Promise<void> {
  const file = join(resolve(cwd), ".pi", "settings.json");
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw Error(`Refusing to write through non-directory project settings path ${directory}`);
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile("{}\n");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lock(file, {
    realpath: false,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw Error(`Refusing to replace non-regular settings file ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let current: Record<string, unknown> = {};
    try {
      const text = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error(`Project settings must contain a JSON object: ${file}`);
      current = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    update(current);

    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  } finally {
    await release();
  }
}

export async function assertSafeProjectSettingsLocation(cwd: string): Promise<void> {
  const file = join(resolve(cwd), ".pi", "settings.json");
  const directory = dirname(file);
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
      throw Error(`Refusing to write through non-directory project settings path ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
      throw Error(`Refusing to write through non-directory project settings path ${directory}`);
  }
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw Error(`Refusing to replace non-regular settings file ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writeProjectAgentSelection(
  cwd: string,
  names: string[] | undefined,
): Promise<void> {
  return updateProjectSettingsFile(cwd, (current) => {
    const subagents = current.subagents;
    if (
      subagents !== undefined &&
      (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    )
      throw Error("Project settings subagents value must be an object");
    const nextSubagents = { ...(subagents as Record<string, unknown> | undefined) };
    if (names === undefined) delete nextSubagents.agents;
    else nextSubagents.agents = names;
    if (Object.keys(nextSubagents).length) current.subagents = nextSubagents;
    else delete current.subagents;
  });
}

export function removeProjectSkillSelection(cwd: string): Promise<void> {
  return updateProjectSettingsFile(cwd, (current) => {
    const subagents = current.subagents;
    if (
      subagents !== undefined &&
      (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    )
      throw Error("Project settings subagents value must be an object");
    if (subagents && typeof subagents === "object") {
      const nextSubagents = { ...(subagents as Record<string, unknown>) };
      const managedPaths = nextSubagents.skillPaths;
      const createdSkillsSetting = nextSubagents.skillPathsCreatedSetting;
      if (
        managedPaths !== undefined &&
        (!Array.isArray(managedPaths) || managedPaths.some((path) => typeof path !== "string"))
      )
        throw Error("Project subagents.skillPaths must be a list of paths");
      if (createdSkillsSetting !== undefined && typeof createdSkillsSetting !== "boolean")
        throw Error("Project subagents.skillPathsCreatedSetting must be a boolean");
      if (
        current.skills !== undefined &&
        (!Array.isArray(current.skills) || current.skills.some((path) => typeof path !== "string"))
      )
        throw Error("Project skills must be a list of paths");
      const managed = new Set(
        (Array.isArray(managedPaths) ? managedPaths : []).map((path) => resolve(cwd, path)),
      );
      if (managed.size && Array.isArray(current.skills)) {
        const retainedPaths = current.skills.filter(
          (path): path is string => typeof path === "string" && !managed.has(resolve(cwd, path)),
        );
        if (retainedPaths.length) current.skills = retainedPaths;
        else if (createdSkillsSetting) delete current.skills;
        else current.skills = [];
      }
      delete nextSubagents.skills;
      delete nextSubagents.skillPaths;
      delete nextSubagents.skillPathsCreatedSetting;
      if (Object.keys(nextSubagents).length) current.subagents = nextSubagents;
      else delete current.subagents;
    }
  });
}

export function writeProjectSkillSelection(
  cwd: string,
  paths: string[],
  names: string[],
): Promise<void> {
  return updateProjectSettingsFile(cwd, (current) => {
    applySkillSelection(current, cwd, paths, names);
  });
}

function applySkillSelection(
  current: Record<string, unknown>,
  cwd: string,
  paths: string[],
  names: string[],
) {
  const subagents = current.subagents;
  if (
    subagents !== undefined &&
    (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
  )
    throw Error("Project settings subagents value must be an object");
  if (
    current.skills !== undefined &&
    (!Array.isArray(current.skills) || current.skills.some((path) => typeof path !== "string"))
  )
    throw Error("Project skills must be a list of paths");
  const existingManagedPaths = (subagents as Record<string, unknown> | undefined)?.skillPaths;
  const createdSkillsSetting = (subagents as Record<string, unknown> | undefined)
    ?.skillPathsCreatedSetting;
  if (
    existingManagedPaths !== undefined &&
    (!Array.isArray(existingManagedPaths) ||
      existingManagedPaths.some((path) => typeof path !== "string"))
  )
    throw Error("Project subagents.skillPaths must be a list of paths");
  if (createdSkillsSetting !== undefined && typeof createdSkillsSetting !== "boolean")
    throw Error("Project subagents.skillPathsCreatedSetting must be a boolean");
  const previousManaged = new Set(
    (Array.isArray(existingManagedPaths) ? existingManagedPaths : []).map((path) =>
      resolve(cwd, path),
    ),
  );
  if (paths.some((path) => typeof path !== "string" || !path.trim()))
    throw Error("Selected skill paths must be strings");
  const selectedPaths = [...new Set(paths)];
  const selectedNames = [...new Set(names)];
  if (
    names.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim()) ||
    selectedNames.length !== names.length
  )
    throw Error("Selected skill names must be non-empty and unique");
  const selectedPathSet = new Set(selectedPaths.map((path) => resolve(cwd, path)));
  const existingPaths = (Array.isArray(current.skills) ? current.skills : []).filter(
    (path): path is string =>
      typeof path === "string" &&
      (!previousManaged.has(resolve(cwd, path)) || selectedPathSet.has(resolve(cwd, path))),
  );
  const finalPaths = [...new Set([...existingPaths, ...selectedPaths])];
  const createdSetting =
    createdSkillsSetting === true || (current.skills === undefined && selectedPaths.length > 0);
  if (finalPaths.length) current.skills = finalPaths;
  else if (Array.isArray(current.skills)) {
    if (createdSetting) delete current.skills;
    else current.skills = [];
  }
  current.subagents = {
    ...(subagents as Record<string, unknown> | undefined),
    skills: selectedNames,
    skillPaths: selectedPaths,
    ...(createdSetting ? { skillPathsCreatedSetting: true } : {}),
  };
}

/** Persist only resource types supplied by the loaded extensions. */
export interface ResourceDefaultsSelection {
  skills?: string[];
  agents?: string[];
  instructions?: string[];
}
export function writeProjectResourceSelection(
  cwd: string,
  selection: ResourceDefaultsSelection,
  paths: string[],
): Promise<void> {
  return updateProjectSettingsFile(cwd, (current) => {
    if (selection.skills !== undefined) applySkillSelection(current, cwd, paths, selection.skills);
    if (selection.agents !== undefined) {
      const subagents = current.subagents;
      if (
        subagents !== undefined &&
        (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
      )
        throw Error("Project subagents value must be an object");
      current.subagents = {
        ...(subagents as Record<string, unknown> | undefined),
        agents: selection.agents,
      };
    }
    if (selection.instructions !== undefined) {
      const context = current.localContext;
      if (
        context !== undefined &&
        (!context || typeof context !== "object" || Array.isArray(context))
      )
        throw Error("Project localContext value must be an object");
      current.localContext = {
        ...(context as Record<string, unknown> | undefined),
        instructions: selection.instructions,
      };
    }
  });
}

export function writeGlobalResourceDefaults(
  agentDir: string,
  selection: ResourceDefaultsSelection,
): Promise<void> {
  return updateSettingsFile(join(resolve(agentDir), "settings.json"), (current) => {
    if (selection.skills !== undefined || selection.agents !== undefined) {
      const subagents = current.subagents;
      if (
        subagents !== undefined &&
        (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
      )
        throw Error("Global subagents must be an object");
      current.subagents = {
        ...(subagents as Record<string, unknown> | undefined),
        ...(selection.skills !== undefined ? { skills: selection.skills } : {}),
        ...(selection.agents !== undefined ? { agents: selection.agents } : {}),
      };
    }
    if (selection.instructions !== undefined) {
      const context = current.localContext;
      if (
        context !== undefined &&
        (!context || typeof context !== "object" || Array.isArray(context))
      )
        throw Error("Global localContext must be an object");
      current.localContext = {
        ...(context as Record<string, unknown> | undefined),
        instructions: selection.instructions.filter((id) => id.startsWith("catalogue:")),
      };
    }
  });
}
