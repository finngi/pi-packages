import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DefaultPackageManager,
  parseArgs,
  type SettingsManager,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

export interface ResourcePackage {
  name: string;
  root: string;
  globalDefaultable?: boolean;
  description: string;
  keywords: string[];
  skills: string[];
  agents: string[];
  instructions: Array<{ catalogue: string; path: string; content: string }>;
}

export function withinResourceRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Read package data through a bounded regular file; never execute package entrypoints. */
export function readResourceFile(root: string, file: string): string {
  const canonical = realpathSync(file);
  if (!withinResourceRoot(root, canonical)) throw Error("resource path escapes pack root");
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw Error("resource must be a bounded regular file without hard links");
    const bytes = Buffer.allocUnsafe(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > 1024 * 1024) throw Error("resource exceeds the discovery byte limit");
    const body = bytes.subarray(0, length).toString("utf8");
    const after = lstatSync(canonical);
    if (
      realpathSync(file) !== canonical ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.nlink !== 1
    )
      throw Error("resource changed during discovery");
    return body;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function declaredDirectories(root: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || isAbsolute(path)))
    throw Error("pi.agents and pi.instructions must be relative directory arrays");
  return [
    ...new Set(
      value.map((path) => {
        const canonical = realpathSync(resolve(root, path));
        if (!withinResourceRoot(root, canonical) || !statSync(canonical).isDirectory())
          throw Error("resource directory escapes package root or is not a directory");
        return canonical;
      }),
    ),
  ];
}

/** Only the two resource types missing from native Pi need a descriptor reader. */
export function readResourcePackage(directory: string, skills: string[] = []): ResourcePackage {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readResourceFile(root, join(root, "package.json")));
  if (!manifest || typeof manifest.name !== "string" || !manifest.name.trim())
    throw Error("package.json requires a package name");
  if (manifest.description !== undefined && typeof manifest.description !== "string")
    throw Error("package description must be a string");
  if (
    manifest.keywords !== undefined &&
    (!Array.isArray(manifest.keywords) ||
      manifest.keywords.some((word: unknown) => typeof word !== "string"))
  )
    throw Error("package keywords must be strings");
  const agents = declaredDirectories(root, manifest.pi?.agents);
  const catalogues = declaredDirectories(root, manifest.pi?.instructions);
  const instructions = catalogues.flatMap((catalogue) =>
    readdirSync(catalogue)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({
        catalogue,
        path: join(catalogue, name),
        content: readResourceFile(root, join(catalogue, name)),
      })),
  );
  return {
    name: manifest.name,
    root,
    description: manifest.description ?? "",
    keywords: manifest.keywords ?? [],
    skills,
    agents,
    instructions,
  };
}

/** Native Pi owns sources, identity, trust and skill filtering; discovery never installs packages. */
export async function discoverResourcePackages(
  settings: SettingsManager,
  cwd: string,
  agentDir: string,
  loaded?: SourceInfo[],
  temporarySources: string[] = parseArgs(process.argv.slice(2)).extensions ?? [],
) {
  const manager = new DefaultPackageManager({ settingsManager: settings, cwd, agentDir });
  const skipped = new Set<string>();
  const paths = await manager.resolve(async (source) => {
    skipped.add(source);
    return "skip";
  });
  const roots = new Map<string, string[]>();
  const personalRoots = new Set<string>();
  const temporaryRoots = new Set<string>();
  const problems: string[] = [];
  // CLI packages have already passed Pi's resolver. Look up their roots without installing again.
  for (const source of temporarySources) {
    if (source.startsWith("builtin:")) continue;
    try {
      // Pi 1.2 implements this scope, but its exported declaration omits it.
      // @ts-expect-error Native getInstalledPath supports temporary package locations.
      const directory = manager.getInstalledPath(source, "temporary");
      if (!directory || !statSync(directory).isDirectory()) continue;
      const root = realpathSync(directory);
      temporaryRoots.add(root);
      roots.set(
        root,
        (loaded ?? [])
          .filter((skill) => {
            try {
              return withinResourceRoot(root, realpathSync(skill.path));
            } catch {
              return false;
            }
          })
          .map((skill) => skill.path),
      );
    } catch {
      problems.push(`${source}: temporary package resources could not be resolved`);
    }
  }
  for (const [kind, resources] of Object.entries(paths))
    for (const resource of resources) {
      if (!resource.metadata.packageRoot) continue;
      const root = realpathSync(resource.metadata.packageRoot);
      const skills = roots.get(root) ?? [];
      if (resource.metadata.scope === "user") personalRoots.add(root);
      if (
        kind === "skills" &&
        resource.enabled &&
        (!loaded || loaded.some((source) => source.path === resource.path))
      )
        skills.push(resource.path);
      roots.set(root, skills);
    }
  // Native resolution has no output record for a package containing only custom resource types.
  for (const entry of manager.listConfiguredPackages().reverse()) {
    // Pi supplies the installed root for local, Git and npm sources; never resolve caches ourselves.
    if (!entry.installedPath || skipped.has(entry.source)) continue;
    const root = realpathSync(entry.installedPath);
    if (entry.scope === "user") personalRoots.add(root);
    if (statSync(root).isDirectory() && !roots.has(root)) roots.set(root, []);
  }
  const packs: ResourcePackage[] = [],
    names = new Set<string>(),
    temporaryNames = new Set<string>();
  for (const [root, skills] of roots) {
    if (!existsSync(join(root, "package.json"))) continue;
    try {
      const pack = readResourcePackage(root, [...new Set(skills)]);
      pack.globalDefaultable = personalRoots.has(root);
      if (!pack.skills.length && !pack.agents.length && !pack.instructions.length) continue;
      // Explicit CLI content takes precedence over another configured copy of that package.
      if (names.has(pack.name) && !temporaryRoots.has(root) && temporaryNames.has(pack.name))
        continue;
      if (names.has(pack.name)) throw Error("duplicate package name");
      names.add(pack.name);
      if (temporaryRoots.has(root)) temporaryNames.add(pack.name);
      packs.push(pack);
    } catch {
      problems.push(`${root}: package resources could not be read`);
    }
  }
  return { packs, problems };
}

/** Pack metadata augments the existing resource browser search, never the model prompt. */
export function resourcePackageKeywords(pack: ResourcePackage): string {
  return [pack.name, pack.description, ...pack.keywords].join(" ");
}
