import { mkdir, open, readFile, rename, lstat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

const { lock } = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

export type InstructionSettings = {
  resources?: { instructionCatalogues?: string[] };
  localContext?: { instructions?: string[] };
};

/** Resolve authored catalogue paths using the same home-relative convention as native Pi settings. */
export function normalizeInstructionCataloguePath(path: string, agentDir: string): string {
  const home = homedir();
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return resolve(isAbsolute(expanded) ? expanded : join(agentDir, expanded));
}

/** Validate settings before touching the filesystem; malformed user settings should fail closed. */
export function instructionCataloguePaths(
  settings: InstructionSettings,
  agentDir: string,
): string[] {
  const resources: unknown = settings.resources;
  if (
    resources !== undefined &&
    (!resources || typeof resources !== "object" || Array.isArray(resources))
  )
    throw Error("resources must be an object");
  const catalogues = (resources as { instructionCatalogues?: unknown } | undefined)
    ?.instructionCatalogues;
  if (catalogues === undefined) return [];
  if (!Array.isArray(catalogues) || catalogues.some((item) => typeof item !== "string"))
    throw Error("resources.instructionCatalogues must be a list of paths");
  return [...new Set(catalogues.map((item) => normalizeInstructionCataloguePath(item, agentDir)))];
}

export function catalogueInstructionId(root: string, file: string): string {
  let canonical = resolve(root);
  try {
    canonical = realpathSync(root);
  } catch {
    /* retain configured path for diagnostics */
  }
  const identity = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `catalogue:${identity}/${file}`;
}

export function effectiveInstructions(
  global: InstructionSettings,
  project: InstructionSettings,
  knownNames?: string[],
): string[] | undefined {
  const selection = Object.hasOwn(project.localContext ?? {}, "instructions")
    ? project.localContext?.instructions
    : global.localContext?.instructions;
  if (selection === undefined) return undefined;
  if (
    !Array.isArray(selection) ||
    selection.some((item) => typeof item !== "string") ||
    new Set(selection).size !== selection.length
  )
    throw Error("localContext.instructions must be a list of unique resource names");
  if (knownNames) {
    const known = new Set(knownNames);
    const unknown = selection.filter((name) => !known.has(name));
    if (unknown.length)
      throw Error(
        `localContext.instructions contains unknown resource names: ${unknown.join(", ")}`,
      );
  }
  return selection;
}

async function updateSettings(path: string, update: (settings: Record<string, unknown>) => void) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(directory);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
    throw Error(`Refusing to write through non-directory settings path ${directory}`);
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile("{}\n");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lock(path, {
    realpath: false,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    let settings: Record<string, unknown> = {};
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw Error(`Refusing to write non-regular settings file ${path}`);
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error(`Settings must be a JSON object: ${path}`);
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    update(settings);
    const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
      await file.sync();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await release();
  }
}

export function writeProjectInstructions(cwd: string, names: string[]) {
  return updateSettings(join(resolve(cwd), ".pi", "settings.json"), (settings) => {
    const existing = settings.localContext;
    if (
      existing !== undefined &&
      (!existing || typeof existing !== "object" || Array.isArray(existing))
    )
      throw Error("localContext must be an object");
    settings.localContext = {
      ...(existing as Record<string, unknown> | undefined),
      instructions: names,
    };
  });
}

export function writeGlobalDefaults(
  agentDir: string,
  key: "instructions" | "agents" | "skills",
  names: string[],
) {
  return updateSettings(join(agentDir, "settings.json"), (settings) => {
    if (key === "agents" || key === "skills") {
      const existing = settings.subagents;
      if (
        existing !== undefined &&
        (!existing || typeof existing !== "object" || Array.isArray(existing))
      )
        throw Error("subagents must be an object");
      settings.subagents = { ...(existing as Record<string, unknown> | undefined), [key]: names };
    } else {
      const existing = settings.localContext;
      if (
        existing !== undefined &&
        (!existing || typeof existing !== "object" || Array.isArray(existing))
      )
        throw Error("localContext must be an object");
      settings.localContext = {
        ...(existing as Record<string, unknown> | undefined),
        instructions: names,
      };
    }
  });
}
