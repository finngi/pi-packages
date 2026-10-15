import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  resolveResourceSelection,
  validateResourceSelection,
  type ResourceSelectionValue,
} from "pi-runtime";

export type InstructionSettings = {
  resources?: { instructionCatalogues?: string[] };
  localContext?: { instructions?: ResourceSelectionValue };
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
  nativeNames: string[] = [],
): string[] | undefined {
  for (const settings of [global, project]) {
    if (
      settings.localContext !== undefined &&
      (!settings.localContext ||
        typeof settings.localContext !== "object" ||
        Array.isArray(settings.localContext))
    )
      throw Error("Settings localContext must be an object");
  }
  const globalSelection = validateResourceSelection(
    global.localContext?.instructions,
    "instructions",
  );
  const projectSelection = validateResourceSelection(
    project.localContext?.instructions,
    "instructions",
  );
  const names = (selection: ResourceSelectionValue) =>
    Array.isArray(selection)
      ? selection
      : selection && typeof selection === "object"
        ? Object.keys(selection).filter((id) => selection[id] === true)
        : [];
  if (globalSelection === undefined && projectSelection === undefined && !knownNames)
    return undefined;
  const known = knownNames ?? [
    ...new Set([...names(globalSelection), ...names(projectSelection), ...nativeNames]),
  ];
  if (knownNames) {
    const ids = new Set(knownNames);
    const configured = [
      ...new Set([
        ...(Array.isArray(globalSelection) ? globalSelection : []),
        ...(Array.isArray(projectSelection) ? projectSelection : []),
      ]),
    ];
    const unknown = configured.filter(
      (id) =>
        !ids.has(id) &&
        resolveResourceSelection(globalSelection, projectSelection, id, false).effective,
    );
    if (unknown.length)
      throw Error(
        `localContext.instructions contains unknown resource names: ${unknown.join(", ")}`,
      );
  }
  const native = new Set(nativeNames);
  return known.filter(
    (id) =>
      resolveResourceSelection(globalSelection, projectSelection, id, native.has(id)).effective,
  );
}
