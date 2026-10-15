import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  resolveResourceSelection,
  resolveResourceMode,
  validateResourceModes,
  type ResourceModes,
  validateResourceSelection,
  type ResourceSelectionValue,
} from "pi-resources/selection";

export type InstructionSettings = {
  localContext?: { instructions?: ResourceSelectionValue };
  resourceSessionTypes?: { instructions?: ResourceModes };
};

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
  interactive = true,
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
  if (globalSelection === undefined && projectSelection === undefined && !knownNames)
    return undefined;
  const known = knownNames ?? [
    ...new Set([
      ...Object.keys(globalSelection ?? {}),
      ...Object.keys(projectSelection ?? {}),
      ...nativeNames,
    ]),
  ];
  const native = new Set(nativeNames);
  const globalModes = validateResourceModes(global.resourceSessionTypes?.instructions);
  const projectModes = validateResourceModes(project.resourceSessionTypes?.instructions);
  return known.filter(
    (id) =>
      (interactive || resolveResourceMode(globalModes, projectModes, id).mode === "any") &&
      resolveResourceSelection(globalSelection, projectSelection, id, native.has(id)).effective,
  );
}
