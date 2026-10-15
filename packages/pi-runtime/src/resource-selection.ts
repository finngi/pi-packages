import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { type ResourcePackage, resourcePackageKeywords } from "./resource-packages.ts";

const { lock } = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

export type ResourceKind = "skills" | "agents" | "instructions";
export type ResourceDefaultState = "inherit" | "on" | "off";
export type ResourceSelectionValue = string[] | Record<string, boolean> | undefined;

type ResourceSettings = {
  skills?: string[];
  subagents?: {
    agents?: ResourceSelectionValue;
    skills?: ResourceSelectionValue;
    skillPaths?: string[];
    skillPathsCreatedSetting?: boolean;
  };
  resources?: { skillCatalogues?: string[] };
  localContext?: { instructions?: ResourceSelectionValue };
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
  values?: Record<string, boolean>;
}
function snapshotValue(snapshot: GlobalSelectionSnapshot): ResourceSelectionValue {
  if (!snapshot.present) return undefined;
  return snapshot.values ?? snapshot.names ?? [];
}
function hasExplicitSelection(value: ResourceSelectionValue): boolean {
  return Array.isArray(value) ? true : !!value && Object.keys(value).length > 0;
}

function selectionValue(settings: ResourceSettings, kind: ResourceKind): ResourceSelectionValue {
  if (kind === "skills" || kind === "agents") {
    if (
      settings.subagents !== undefined &&
      (!settings.subagents ||
        typeof settings.subagents !== "object" ||
        Array.isArray(settings.subagents))
    )
      throw Error("Settings subagents must be an object");
    return settings.subagents?.[kind];
  }
  if (
    settings.localContext !== undefined &&
    (!settings.localContext ||
      typeof settings.localContext !== "object" ||
      Array.isArray(settings.localContext))
  )
    throw Error("Settings localContext must be an object");
  return settings.localContext?.instructions;
}

export function readResourceSelection(
  settings: SettingsManager,
  scope: "project" | "global",
  kind: ResourceKind,
): ResourceSelectionValue {
  const source = (
    scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()
  ) as ResourceSettings;
  return validateResourceSelection(selectionValue(source, kind), kind);
}

export function validateResourceSelection(
  value: unknown,
  kind: ResourceKind,
): ResourceSelectionValue {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (
      value.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim()) ||
      new Set(value).size !== value.length
    )
      throw Error(`${kind} selection must contain unique non-empty IDs`);
    return value as string[];
  }
  if (!value || typeof value !== "object")
    throw Error(`${kind} selection must be a list or ID-to-boolean map`);
  const entries = Object.entries(value);
  if (entries.some(([id, selected]) => !id.trim() || typeof selected !== "boolean"))
    throw Error(`${kind} selection map must contain non-empty IDs and boolean values`);
  return value as Record<string, boolean>;
}

export function resourceSelectionState(
  value: ResourceSelectionValue,
  id: string,
): ResourceDefaultState {
  if (value === undefined) return "inherit";
  if (Array.isArray(value)) return value.includes(id) ? "on" : "off";
  if (Object.hasOwn(value, id)) return value[id] ? "on" : "off";
  return "inherit";
}

export function resolveResourceSelection(
  global: ResourceSelectionValue,
  project: ResourceSelectionValue,
  id: string,
  nativeDefault: boolean,
): {
  globalState: ResourceDefaultState;
  projectState: ResourceDefaultState;
  effective: boolean;
  source: "project" | "global" | "native";
} {
  const globalState = resourceSelectionState(global, id);
  const projectState = resourceSelectionState(project, id);
  if (projectState !== "inherit")
    return { globalState, projectState, effective: projectState === "on", source: "project" };
  if (globalState !== "inherit")
    return { globalState, projectState, effective: globalState === "on", source: "global" };
  return { globalState, projectState, effective: nativeDefault, source: "native" };
}

function legacyMap(value: ResourceSelectionValue, knownIds: string[]): Record<string, boolean> {
  const result = Object.create(null) as Record<string, boolean>;
  if (value === undefined) return result;
  if (!Array.isArray(value)) {
    for (const [id, selected] of Object.entries(value)) result[id] = selected;
    return result;
  }
  const selected = new Set(value);
  for (const id of knownIds) result[id] = selected.has(id);
  for (const id of value) if (!knownIds.includes(id)) result[id] = true;
  return result;
}

function writeSelectionValue(
  settings: Record<string, unknown>,
  kind: ResourceKind,
  value: ResourceSelectionValue,
) {
  if (kind === "skills" || kind === "agents") {
    const subagents = settings.subagents;
    if (
      subagents !== undefined &&
      (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    )
      throw Error("Settings subagents value must be an object");
    const next = { ...(subagents as Record<string, unknown> | undefined) };
    if (value === undefined) delete next[kind];
    else next[kind] = value;
    if (Object.keys(next).length) settings.subagents = next;
    else delete settings.subagents;
  } else {
    const context = settings.localContext;
    if (
      context !== undefined &&
      (!context || typeof context !== "object" || Array.isArray(context))
    )
      throw Error("Settings localContext value must be an object");
    const next = { ...(context as Record<string, unknown> | undefined) };
    if (value === undefined) delete next.instructions;
    else next.instructions = value;
    if (Object.keys(next).length) settings.localContext = next;
    else delete settings.localContext;
  }
}

export interface ResourceDefaultWrite {
  scope: "project" | "global";
  kind: ResourceKind;
  id: string;
  state: ResourceDefaultState;
  knownIds: string[];
  cwd?: string;
  agentDir?: string;
  /** Selected extension skill paths, keyed by skill ID, for project skill writes. */
  skillPaths?: Record<string, string>;
  /** Native baseline for known IDs; false is used when omitted. */
  nativeDefaults?: Record<string, boolean>;
  /** Effective lower-scope values used to maintain project skill paths. */
  fallbackValues?: Record<string, boolean>;
}

export interface ResourceDefaultsWrite {
  scope: "project" | "global";
  selections: Partial<
    Record<
      ResourceKind,
      {
        values: Record<string, boolean | undefined>;
        knownIds: string[];
        skillPaths?: Record<string, string>;
        nativeDefaults?: Record<string, boolean>;
        fallbackValues?: Record<string, boolean>;
        /** Bulk save: discard saved IDs that are no longer known in this category. */
        snapshot?: boolean;
      }
    >
  >;
  cwd?: string;
  agentDir?: string;
}

function settingsFileUpdate(
  scope: "project" | "global",
  options: { cwd?: string; agentDir?: string },
  update: (settings: Record<string, unknown>) => void,
) {
  if (scope === "project") {
    if (!options.cwd) throw Error("Project resource defaults require a project directory");
    return updateProjectSettingsFile(options.cwd, update);
  }
  if (!options.agentDir) throw Error("Global resource defaults require an agent directory");
  return updateSettingsFile(join(resolve(options.agentDir), "settings.json"), update);
}

export function writeResourceDefault(options: ResourceDefaultWrite): Promise<void> {
  const fallbackValues = options.nativeDefaults ?? {};
  return writeResourceDefaults({
    scope: options.scope,
    cwd: options.cwd,
    agentDir: options.agentDir,
    selections: {
      [options.kind]: {
        values: { [options.id]: options.state === "inherit" ? undefined : options.state === "on" },
        knownIds: options.knownIds,
        ...(options.skillPaths ? { skillPaths: options.skillPaths } : {}),
        ...(options.nativeDefaults ? { nativeDefaults: options.nativeDefaults } : {}),
        ...(options.fallbackValues
          ? { fallbackValues: options.fallbackValues }
          : { fallbackValues }),
      },
    },
  });
}

export function writeResourceDefaults(options: ResourceDefaultsWrite): Promise<void> {
  return settingsFileUpdate(options.scope, options, (settings) => {
    for (const kind of ["skills", "agents", "instructions"] as const) {
      const selection = options.selections[kind];
      if (!selection) continue;
      const before = selectionValue(settings as ResourceSettings, kind);
      const next = legacyMap(before, selection.knownIds);
      if (selection.snapshot) {
        const known = new Set(selection.knownIds);
        for (const id of Object.keys(next)) if (!known.has(id)) delete next[id];
      }
      for (const [id, state] of Object.entries(selection.values)) {
        if (state === undefined) delete next[id];
        else next[id] = state;
      }
      const value = Object.keys(next).length ? next : undefined;
      if (options.scope === "project" && kind === "skills") {
        const selected = selection.knownIds.filter((id) =>
          Object.hasOwn(next, id)
            ? next[id] === true
            : (selection.fallbackValues?.[id] ?? selection.nativeDefaults?.[id] ?? false),
        );
        const paths = selected
          .filter((id) => !(selection.nativeDefaults?.[id] ?? false))
          .flatMap((id) => selection.skillPaths?.[id] ?? []);
        applySkillSelection(settings, options.cwd!, paths, selected);
        writeSelectionValue(settings, kind, value);
      } else writeSelectionValue(settings, kind, value);
    }
  });
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
  let projectRaw: ResourceSelectionValue;
  let currentGlobalRaw: ResourceSelectionValue;
  try {
    projectRaw = readResourceSelection(settings, "project", "skills");
    currentGlobalRaw = readResourceSelection(settings, "global", "skills");
  } catch (error) {
    if (ignoreInvalidProjectSelection) return [];
    throw error;
  }
  const globalRaw = globalSnapshot
    ? validateResourceSelection(snapshotValue(globalSnapshot), "skills")
    : currentGlobalRaw;
  const byName = new Map(choices.filter((x) => x.toggleable).map((x) => [x.name, x]));
  for (const [label, raw] of [
    ["project", projectRaw],
    ["global", globalRaw],
  ] as const) {
    if (!Array.isArray(raw)) continue;
    const missing = raw.filter((name) => !byName.has(name));
    if (missing.length) {
      if (ignoreInvalidProjectSelection && label === "project") return [];
      throw Error(`${label} subagents.skills contains unknown skill names: ${missing.join(", ")}`);
    }
  }
  return choices
    .filter(
      (choice) =>
        choice.toggleable &&
        resolveResourceSelection(globalRaw, projectRaw, choice.name, choice.defaultSelected)
          .effective,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
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
  if (
    project.subagents !== undefined &&
    (!project.subagents ||
      typeof project.subagents !== "object" ||
      Array.isArray(project.subagents))
  )
    return { agents: [], configured: true, error: "subagents must be an object" };
  if (
    global.subagents !== undefined &&
    (!global.subagents || typeof global.subagents !== "object" || Array.isArray(global.subagents))
  )
    return { agents: [], configured: true, error: "subagents must be an object" };
  let projectRaw: ResourceSelectionValue, globalRaw: ResourceSelectionValue;
  try {
    projectRaw = readResourceSelection(settings, "project", "agents");
    const currentGlobalRaw = readResourceSelection(settings, "global", "agents");
    globalRaw = globalSnapshot
      ? validateResourceSelection(snapshotValue(globalSnapshot), "agents")
      : currentGlobalRaw;
  } catch (error) {
    return {
      agents: [],
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const known = new Set(agents.map((agent) => agent.name));
  for (const [label, raw] of [
    ["project", projectRaw],
    ["global", globalRaw],
  ] as const) {
    if (!Array.isArray(raw)) continue;
    const invalid = raw.filter((name) => !known.has(name));
    if (invalid.length)
      return {
        agents: [],
        configured: true,
        error: `${label} subagents.agents contains unknown or untrusted names: ${invalid.join(", ")}`,
      };
  }
  const configured = hasExplicitSelection(projectRaw) || hasExplicitSelection(globalRaw);
  return {
    agents: agents.filter(
      (agent) =>
        resolveResourceSelection(globalRaw, projectRaw, agent.name, !agent.catalogueOnly).effective,
    ),
    configured,
  };
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
