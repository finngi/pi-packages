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
export type ResourceSelectionValue = Record<string, boolean> | undefined;
export type ResourceMode = "any" | "interactive";
export type ResourceModeState = "inherit" | ResourceMode;
export type ResourceModes = Record<string, ResourceMode> | undefined;

type ResourceSettings = {
  subagents?: { agents?: ResourceSelectionValue; skills?: ResourceSelectionValue };
  localContext?: { instructions?: ResourceSelectionValue };
  resourceSessionTypes?: Partial<Record<ResourceKind, ResourceModes>>;
};

export function readResourceModes(
  settings: SettingsManager,
  scope: "project" | "global",
  kind: ResourceKind,
): ResourceModes {
  const source = (
    scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()
  ) as ResourceSettings;
  const modes = source.resourceSessionTypes;
  if (modes === undefined) return undefined;
  if (!modes || typeof modes !== "object" || Array.isArray(modes))
    throw Error("resourceSessionTypes must be an object");
  return validateResourceModes(modes[kind]);
}

export function validateResourceModes(value: unknown): ResourceModes {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([id, mode]) => !id.trim() || (mode !== "any" && mode !== "interactive"),
    )
  )
    throw Error("Resource session types must map non-empty IDs to any or interactive");
  return value as ResourceModes;
}

export function resourceModeState(value: ResourceModes, id: string): ResourceModeState {
  return value && Object.hasOwn(value, id) ? value[id]! : "inherit";
}

export function resolveResourceMode(
  global: ResourceModes,
  project: ResourceModes,
  id: string,
): { mode: ResourceMode; source: "project" | "global" | "native" } {
  for (const [source, values] of [
    ["project", project],
    ["global", global],
  ] as const) {
    const mode = resourceModeState(values, id);
    if (mode !== "inherit") return { mode, source };
  }
  return { mode: "any", source: "native" };
}

export function resourceApplies(
  settings: SettingsManager,
  kind: ResourceKind,
  id: string,
  interactive: boolean,
): boolean {
  return (
    interactive ||
    resolveResourceMode(
      readResourceModes(settings, "global", kind),
      readResourceModes(settings, "project", kind),
      id,
    ).mode === "any"
  );
}

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
  values?: Record<string, boolean>;
}
function snapshotValue(snapshot: GlobalSelectionSnapshot): ResourceSelectionValue {
  if (!snapshot.present) return undefined;
  return snapshot.values ?? {};
}
function hasExplicitSelection(value: ResourceSelectionValue): boolean {
  return !!value && Object.keys(value).length > 0;
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
  if (Array.isArray(value))
    throw Error(
      `${kind === "instructions" ? "localContext.instructions" : `subagents.${kind}`} in settings.json uses the old list format; edit it into an ID-to-boolean map such as {"id": true, "other": false}`,
    );
  if (!value || typeof value !== "object")
    throw Error(`${kind} selection must be an ID-to-boolean map`);
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
  if (Object.hasOwn(value, id)) return value[id] ? "on" : "off";
  return "inherit";
}

export function resolveResourceSelection(
  global: ResourceSelectionValue,
  project: ResourceSelectionValue,
  id: string,
  nativeDefault: boolean,
  session?: ResourceSelectionValue,
): {
  globalState: ResourceDefaultState;
  projectState: ResourceDefaultState;
  effective: boolean;
  source: "session" | "project" | "global" | "native";
} {
  const globalState = resourceSelectionState(global, id);
  const projectState = resourceSelectionState(project, id);
  const sessionState = resourceSelectionState(session, id);
  if (sessionState !== "inherit")
    return { globalState, projectState, effective: sessionState === "on", source: "session" };
  if (projectState !== "inherit")
    return { globalState, projectState, effective: projectState === "on", source: "project" };
  if (globalState !== "inherit")
    return { globalState, projectState, effective: globalState === "on", source: "global" };
  return { globalState, projectState, effective: nativeDefault, source: "native" };
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
}

export interface ResourceDefaultsWrite {
  scope: "project" | "global";
  selections: Partial<
    Record<
      ResourceKind,
      {
        values: Record<string, boolean | undefined>;
        knownIds: string[];
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
  return writeResourceDefaults({
    scope: options.scope,
    cwd: options.cwd,
    agentDir: options.agentDir,
    selections: {
      [options.kind]: {
        values: { [options.id]: options.state === "inherit" ? undefined : options.state === "on" },
        knownIds: options.knownIds,
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
      const next: Record<string, boolean> = Object.assign(
        Object.create(null),
        validateResourceSelection(before, kind),
      );
      if (selection.snapshot) {
        const known = new Set(selection.knownIds);
        for (const id of Object.keys(next)) if (!known.has(id)) delete next[id];
      }
      for (const [id, state] of Object.entries(selection.values)) {
        if (state === undefined) delete next[id];
        else next[id] = state;
      }
      const value = Object.keys(next).length ? next : undefined;
      writeSelectionValue(settings, kind, value);
    }
  });
}

/** Session type is independent of selection; editing it must preserve all saved ON/OFF values. */
function writeModeValues(
  settings: Record<string, unknown>,
  kind: ResourceKind,
  values: Record<string, ResourceMode | undefined>,
) {
  const raw = settings.resourceSessionTypes;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)))
    throw Error("resourceSessionTypes must be an object");
  const modes = { ...(raw as Partial<Record<ResourceKind, ResourceModes>> | undefined) };
  const next = { ...validateResourceModes(modes[kind]) };
  for (const [id, mode] of Object.entries(values)) {
    if (mode === undefined) delete next[id];
    else next[id] = mode;
  }
  if (Object.keys(next).length) modes[kind] = next;
  else delete modes[kind];
  if (Object.keys(modes).length) settings.resourceSessionTypes = modes;
  else delete settings.resourceSessionTypes;
}

export function writeResourceMode(options: {
  scope: "project" | "global";
  kind: ResourceKind;
  id: string;
  mode: ResourceModeState;
  cwd?: string;
  agentDir?: string;
}): Promise<void> {
  return settingsFileUpdate(options.scope, options, (settings) => {
    writeModeValues(settings, options.kind, {
      [options.id]: options.mode === "inherit" ? undefined : options.mode,
    });
  });
}

export function configuredSkillChoices(
  cwd: string,
  agentDir: string,
  loaded: Array<{ name: string; path: string }>,
  packs: ResourcePackage[] = [],
): SkillChoice[] {
  // Native Pi has already applied source trust, package filters, CLI exclusions and collisions.
  // Re-read metadata only for those exact loaded files; never discover another skill root.
  const metadata = new Map(
    loadSkills({
      cwd,
      agentDir,
      skillPaths: loaded.map((skill) => skill.path),
      includeDefaults: false,
    }).skills.map((skill) => [resolve(cwd, skill.filePath), skill]),
  );
  const packSkills = new Map(
    packs.flatMap((pack) => pack.skills.map((file) => [resolve(cwd, file), pack] as const)),
  );
  return loaded
    .filter((skill) => metadata.has(resolve(cwd, skill.path)))
    .map((skill) => {
      const key = resolve(cwd, skill.path),
        details = metadata.get(key),
        pack = packSkills.get(key);
      return {
        name: skill.name,
        description: details?.description ?? "Currently loaded by Pi",
        path: skill.path,
        toggleable: true,
        defaultSelected: true,
        ...(details?.disableModelInvocation ? { manualOnly: true } : {}),
        ...(pack ? { packName: pack.name, packKeywords: resourcePackageKeywords(pack) } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectedSkills(
  settings: SettingsManager,
  choices: SkillChoice[],
  ignoreInvalidProjectSelection = false,
  globalSnapshot?: GlobalSelectionSnapshot,
  interactive = true,
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
  return choices
    .filter(
      (choice) =>
        choice.toggleable &&
        resourceApplies(settings, "skills", choice.name, interactive) &&
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
  interactive = true,
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
  const configured = hasExplicitSelection(projectRaw) || hasExplicitSelection(globalRaw);
  return {
    agents: agents.filter(
      (agent) =>
        resourceApplies(settings, "agents", agent.name, interactive) &&
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
