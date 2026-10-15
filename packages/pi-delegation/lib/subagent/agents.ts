import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { readResourceFile, withinResourceRoot } from "pi-resources/discovery";
import { parseContext } from "./context.ts";
import type { ContextSetting } from "./context.ts";

export interface AgentDef {
  name: string;
  description: string;
  body: string;
  filePath: string;
  /** Canonical directory for a directory bundle; flat definitions have no private resource root. */
  bundleRoot?: string;
  /** Skills discovered inside this bundle. They are child-private and never advertised to the parent. */
  privateSkills?: Array<{ name: string; description: string; path: string }>;
  /** `inherit`, `provider/id[:level]`, or a bare alias matched against authenticated models. */
  model?: string;
  thinking?: string;
  /** Native built-in or extension tool names; omitted inherits selected parent task tools. */
  tools?: string[];
  /** Omitted or ["*"] uses saved scope skills plus the bundle; [] selects none. */
  skills?: string[];
  /** The default and ceiling for how much of the parent conversation a call may share. */
  context?: ContextSetting;
  targets?: string[];
}

export interface Discovery {
  agents: AgentDef[];
  problems: string[];
  warnings: string[];
}

export type FoundAgent = AgentDef & {
  source: "user" | "project" | "pack";
  catalogueOnly?: boolean;
  packName?: string;
  packKeywords?: string;
};

/** One directory of the walk up from the working directory, with the agent directories it holds (.pi before .agents). */
export interface ProjectLevel {
  root: string;
  dirs: string[];
}

export interface Found {
  agents: FoundAgent[];
  problems: string[];
  warnings: string[];
  /** Agent directories skipped because their level has no explicit trust decision. */
  ignored: string[];
  /** Project agents that replace a user agent of the same name, so the replacement is never silent. */
  overrides: string[];
}

/** pi's `parseFrontmatter`, injected so this module runs under plain `node --test`. */
export type ParseFrontmatter = (text: string) => {
  frontmatter: Record<string, unknown>;
  body: string;
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const NAME = /^[\w.:-]+$/;

function text(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

/** A YAML list or a comma-separated string. */
function names(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!items) throw new Error(`${key} must be a list of names`);
  const list = items.map((item) => {
    if (typeof item !== "string") throw new Error(`${key} must be a list of names`);
    return item.trim();
  });
  const kept = [...new Set(list.filter(Boolean))];
  const bad = kept.find((n) => !NAME.test(n) && !(key === "skills" && n === "*"));
  if (bad) throw new Error(`${key}: "${bad}" is not a valid name`);
  if (key === "skills" && kept.includes("*") && kept.length > 1)
    throw new Error('skills: use "*" alone or list individual skill names');
  return kept;
}

export function parseAgent(source: string, filePath: string, parse: ParseFrontmatter): AgentDef {
  const { frontmatter, body } = parse(source);
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
    throw new Error("frontmatter must be a YAML mapping");
  const name = text(frontmatter.name, "name");
  const description = text(frontmatter.description, "description");
  if (!name) throw new Error("missing name");
  if (!description) throw new Error("missing description");
  if (!NAME.test(name)) throw new Error("name is not a valid agent name");
  if (name !== basename(filePath, ".md"))
    throw new Error(`name "${name}" must match filename "${basename(filePath, ".md")}"`);
  const targets = names(frontmatter.targets, "targets");
  if (targets?.some((t) => !["pi", "claude"].includes(t)))
    throw new Error("targets must contain only pi or claude");
  if (frontmatter.permissionMode !== undefined)
    throw new Error(
      "permissionMode is no longer an agent setting; configure the optional pi-permissions package",
    );
  const tools = names(frontmatter.tools, "tools");
  const thinking = text(frontmatter.thinking, "thinking");
  if (thinking && !THINKING_LEVELS.includes(thinking))
    throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  return {
    name,
    description,
    body: body.trim(),
    filePath,
    model: text(frontmatter.model, "model"),
    thinking,
    tools,
    skills: names(frontmatter.skills, "skills"),
    context: parseContext(frontmatter.conversation),
    targets,
  };
}

/** One bad file is reported in `problems` and never stops the others. */
export function discoverAgents(
  dir: string,
  parse: ParseFrontmatter,
  sourceRoot?: string,
): Discovery {
  const agents: AgentDef[] = [];
  const problems: string[] = [],
    warnings: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT")
      problems.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return { agents, problems, warnings };
  }
  const seen = new Set<string>();
  const candidates: Array<{ entry: string; filePath: string; bundleRoot?: string }> = files.map(
    (file) => {
      const selectedPath = join(dir, file);
      let filePath = selectedPath;
      try {
        // Managed flat links can be named <agent>.local.md; parse the authored target name.
        filePath = realpathSync(selectedPath);
      } catch {
        // Keep the selected path so the normal per-file diagnostic reports the broken link.
      }
      return { entry: file, filePath };
    },
  );
  // A bundle is an immediate child directory with exactly one conventional entrypoint:
  // <agent-name>/<agent-name>.md. Nested Markdown files remain resources, never agents.
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".") || entry.name.includes("/")) continue;
      const candidate = join(dir, entry.name);
      if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
      let canonical: string;
      try {
        if (!statSync(candidate).isDirectory()) continue;
        canonical = realpathSync(candidate);
        if (sourceRoot && !withinResourceRoot(sourceRoot, canonical)) {
          warnings.push(`${entry.name}: agent bundle escapes resource pack`);
          continue;
        }
      } catch {
        continue;
      }
      // Managed directory links use <agent>.local, so derive identity from the canonical
      // authored directory. Its only entrypoint remains <canonical-directory-name>.md.
      const identity = basename(canonical);
      const entrypoint = join(canonical, `${identity}.md`);
      try {
        if (!statSync(entrypoint).isFile()) continue;
      } catch {
        continue;
      }
      const canonicalEntrypoint = realpathSync(entrypoint);
      if (sourceRoot && !withinResourceRoot(sourceRoot, canonicalEntrypoint)) continue;
      const entrypointRelative = relative(canonical, canonicalEntrypoint);
      if (
        entrypointRelative === ".." ||
        entrypointRelative.startsWith(`..${sep}`) ||
        isAbsolute(entrypointRelative)
      )
        continue;
      candidates.push({ entry: entry.name, filePath: canonicalEntrypoint, bundleRoot: canonical });
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT")
      problems.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Flat definitions precede same-named bundles; this preserves the established flat-file
  // behavior while making duplicate diagnostics independent of filesystem enumeration order.
  candidates.sort((a, b) => {
    const byName = basename(a.filePath, ".md").localeCompare(basename(b.filePath, ".md"));
    return (
      byName ||
      Number(Boolean(a.bundleRoot)) - Number(Boolean(b.bundleRoot)) ||
      a.filePath.localeCompare(b.filePath)
    );
  });
  const seenSources = new Set<string>();
  for (const candidate of candidates) {
    const { entry, filePath, bundleRoot } = candidate;
    try {
      const canonicalFile = realpathSync(filePath);
      if (sourceRoot && !withinResourceRoot(sourceRoot, canonicalFile)) {
        warnings.push(`${entry}: agent source escapes resource pack`);
        continue;
      }
      if (seenSources.has(canonicalFile)) continue;
      seenSources.add(canonicalFile);
      const agent = parseAgent(
        sourceRoot
          ? readResourceFile(sourceRoot, canonicalFile)
          : readFileSync(canonicalFile, "utf-8"),
        canonicalFile,
        parse,
      );
      if (agent.targets && !agent.targets.includes("pi")) continue;
      if (seen.has(agent.name)) {
        problems.push(`${entry}: duplicate agent name "${agent.name}"`);
        continue;
      }
      seen.add(agent.name);
      if (bundleRoot) {
        const skillsRoot = join(bundleRoot, "skills");
        const canonicalSkillsRoot = skillTreeIsContained(
          bundleRoot,
          skillsRoot,
          Boolean(sourceRoot),
        );
        const privateSkills = [];
        if (canonicalSkillsRoot === false) {
          warnings.push(
            `${canonicalFile}: private bundle skills were skipped because the skills directory is unsafe`,
          );
        } else if (canonicalSkillsRoot) {
          const loaded = loadSkillsFromDir({ dir: canonicalSkillsRoot, source: "path" });
          if (loaded.diagnostics.length)
            warnings.push(
              `${canonicalFile}: one or more private skills have loading warnings; check the bundle skills`,
            );
          const seenSkillFiles = new Set<string>();
          for (const skill of loaded.skills) {
            try {
              const canonicalSkill = realpathSync(skill.filePath);
              const rel = relative(canonicalSkillsRoot, canonicalSkill);
              if (
                !rel ||
                rel.startsWith(`..${sep}`) ||
                rel === ".." ||
                isAbsolute(rel) ||
                seenSkillFiles.has(canonicalSkill)
              )
                continue;
              seenSkillFiles.add(canonicalSkill);
              const { frontmatter } = parse(readFileSync(canonicalSkill, "utf-8"));
              const explicitName = frontmatter.name;
              privateSkills.push({
                // Pi falls back to the directory name. Use the canonical path so a safe
                // directory alias cannot rename a skill that omits frontmatter `name`.
                name:
                  typeof explicitName === "string" && explicitName
                    ? explicitName
                    : basename(dirname(canonicalSkill)),
                description: skill.description,
                path: canonicalSkill,
              });
            } catch {
              // A skill that disappeared during discovery is not passed to the child.
            }
          }
        }
        Object.assign(agent, { bundleRoot, privateSkills });
      }
      agents.push(agent);
    } catch (err) {
      problems.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { agents, problems, warnings };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Pi follows symlinks while loading skills, so validate and pin the resolved root first. */
function skillTreeIsContained(
  bundleRoot: string,
  skillsRoot: string,
  boundedReads = false,
): string | undefined | false {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(skillsRoot);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  const canonicalRoot = realpathSync(bundleRoot);
  const canonicalSkillsRoot = realpathSync(skillsRoot);
  const relativeSkillsRoot = relative(canonicalRoot, canonicalSkillsRoot);
  if (
    !relativeSkillsRoot ||
    relativeSkillsRoot === ".." ||
    relativeSkillsRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeSkillsRoot)
  )
    return false;
  const pending = [{ directory: skillsRoot, ancestors: new Set<string>() }];
  const visited = new Set<string>();
  while (pending.length) {
    const { directory, ancestors } = pending.pop()!;
    let canonicalDirectory: string;
    let entries: Dirent<string>[];
    try {
      canonicalDirectory = realpathSync(directory);
      const relativeDirectory = relative(canonicalSkillsRoot, canonicalDirectory);
      if (
        relativeDirectory === ".." ||
        relativeDirectory.startsWith(`..${sep}`) ||
        isAbsolute(relativeDirectory)
      )
        return false;
      if (ancestors.has(canonicalDirectory)) return false;
      if (visited.has(canonicalDirectory)) continue;
      visited.add(canonicalDirectory);
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      // Stock Pi reads ignore files before checking file type, and reads skill metadata
      // synchronously. Pack discovery must check those inputs before invoking it.
      if (
        boundedReads &&
        ([".gitignore", ".ignore", ".fdignore"].includes(entry.name) ||
          entry.name === "SKILL.md" ||
          (canonicalDirectory === canonicalSkillsRoot &&
            !entry.name.startsWith(".") &&
            !entry.isDirectory() &&
            entry.name.endsWith(".md")))
      ) {
        try {
          readResourceFile(canonicalSkillsRoot, child);
        } catch {
          return false;
        }
      }
      if (entry.isSymbolicLink()) {
        try {
          const canonicalChild = realpathSync(child);
          const relativeChild = relative(canonicalSkillsRoot, canonicalChild);
          if (
            relativeChild === ".." ||
            relativeChild.startsWith(`..${sep}`) ||
            isAbsolute(relativeChild)
          )
            return false;
          if (statSync(child).isDirectory()) {
            pending.push({
              directory: child,
              ancestors: new Set([...ancestors, canonicalDirectory]),
            });
          }
        } catch {
          return false;
        }
      } else if (entry.isDirectory()) {
        pending.push({
          directory: child,
          ancestors: new Set([...ancestors, canonicalDirectory]),
        });
      }
    }
  }
  return canonicalSkillsRoot;
}

/**
 * Every directory from `cwd` up to `/` that holds `.pi/agents` or `.agents/agents`, nearest first.
 * `~/.agents/agents` is the source that sync deploys to the user directory, so it is not a project level.
 */
export function projectLevels(
  cwd: string,
  home: string,
  isDir: (path: string) => boolean = isDirectory,
): ProjectLevel[] {
  const userSource = join(home, ".agents", "agents");
  const levels: ProjectLevel[] = [];
  for (let root = resolve(cwd); ; root = dirname(root)) {
    const dirs = [join(root, ".pi", "agents"), join(root, ".agents", "agents")].filter(
      (d) => d !== userSource && isDir(d),
    );
    if (dirs.length) levels.push({ root, dirs });
    if (dirname(root) === root) return levels;
  }
}

/**
 * Project levels nearest first, then the user's agents: the agent closest to the working directory wins, as in
 * Claude Code, Codex and pi's own skills. Project agent files are repo-controlled system prompts, so a level is
 * read only when `isTrusted(root)`, and a project agent that replaces a user agent is reported in `overrides`.
 * Any other clash is a problem, and the nearer file is kept.
 */
export function discover(
  userDir: string,
  levels: ProjectLevel[],
  isTrusted: (root: string) => boolean,
  parse: ParseFrontmatter,
): Found {
  const found: Found = { agents: [], problems: [], warnings: [], ignored: [], overrides: [] };
  const byName = new Map<string, FoundAgent>();
  const add = (dir: string, source: FoundAgent["source"]) => {
    const { agents, problems, warnings } = discoverAgents(dir, parse);
    found.problems.push(...problems);
    found.warnings.push(...warnings);
    for (const agent of agents) {
      const taken = byName.get(agent.name);
      if (taken && source === "user") {
        found.overrides.push(
          `${taken.filePath} replaces the user agent "${agent.name}" (${agent.filePath})`,
        );
        continue;
      }
      if (taken) {
        found.problems.push(
          `${agent.filePath}: agent name "${agent.name}" is already defined by ${taken.filePath}`,
        );
        continue;
      }
      const entry = { ...agent, source };
      byName.set(agent.name, entry);
      found.agents.push(entry);
    }
  };
  for (const level of levels) {
    if (!isTrusted(level.root))
      found.ignored.push(
        ...level.dirs.map((dir) => `${dir}: ${level.root} has no explicit trust decision`),
      );
    else for (const dir of level.dirs) add(dir, "project");
  }
  add(userDir, "user");
  return found;
}
