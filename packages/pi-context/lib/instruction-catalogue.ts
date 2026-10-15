import { basename, relative } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type ResourcePackage, resourcePackageKeywords } from "pi-runtime";
import {
  catalogueInstructionId,
  effectiveInstructions,
  type InstructionSettings,
} from "./instruction-selection.ts";
import { localInstructionChoices } from "./local-context.ts";

interface InstructionMetadata {
  id: string;
  name: string;
  description: string;
  keywords: string;
  path: string;
  packName?: string;
  globalDefaultable?: boolean;
  nativeDefault: boolean;
}

/** Setup discovery returns metadata only; context files and behavioral bodies stay separate. */
export function instructionCatalogue(
  global: InstructionSettings,
  project: InstructionSettings,
  cwd: string,
  trusted: boolean,
  enabled: boolean,
  packs: ResourcePackage[] = [],
) {
  const candidates: InstructionMetadata[] = [],
    problems: string[] = [];
  if (!enabled) return { candidates, selected: [] as string[], problems };
  const add = (
    id: string,
    path: string,
    content: string,
    pack?: { name: string; keywords: string; globalDefaultable?: boolean },
  ) => {
    let frontmatter: Record<string, unknown> = {};
    try {
      frontmatter = parseFrontmatter(content).frontmatter;
    } catch {
      problems.push(`${path}: instruction metadata could not be read`);
    }
    const item = {
      id,
      path,
      nativeDefault: id.startsWith("local:"),
      globalDefaultable: !id.startsWith("local:") && pack?.globalDefaultable !== false,
      name: typeof frontmatter.title === "string" ? frontmatter.title : basename(path, ".md"),
      description:
        typeof frontmatter.description === "string"
          ? frontmatter.description
          : "Agent/session guidance",
      keywords: [basename(path), pack?.keywords].filter(Boolean).join(" "),
      ...(pack ? { packName: pack.name } : {}),
    };
    if (!candidates.some((candidate) => candidate.id === id)) candidates.push(item);
  };
  for (const pack of packs)
    for (const file of pack.instructions)
      add(catalogueInstructionId(file.catalogue, basename(file.path)), file.path, file.content, {
        name: pack.name,
        globalDefaultable: pack.globalDefaultable,
        keywords: resourcePackageKeywords(pack),
      });
  const locals = trusted ? localInstructionChoices(cwd) : [];
  for (const file of locals) add(`local:${relative(cwd, file.path)}`, file.path, file.content);
  let selected: string[] = [];
  try {
    selected =
      effectiveInstructions(
        global,
        trusted ? project : {},
        candidates.map((file) => file.id),
        locals.map((file) => `local:${relative(cwd, file.path)}`),
      ) ?? [];
  } catch {
    problems.push("Saved instruction selection is invalid; inspect /instructions.");
  }
  return { candidates, selected, problems };
}
