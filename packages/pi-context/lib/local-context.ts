import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { catalogueInstructionId } from "./instruction-selection.ts";

export const LOCAL_FILE = "AGENTS.local.md";
export const INSTRUCTIONS_DIR = join(".agents", "instructions");
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
  path: string;
  content: string;
}

/** Every directory from the filesystem root down to cwd: the walk pi itself makes for AGENTS.md and CLAUDE.md. */
export function chain(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === parse(dir).root) return dirs;
  }
}

/** pi's `-nc` / `--no-context-files` turns context files off; the option is not visible to extensions, only the arguments are. */
export function contextFilesDisabled(argv: string[]): boolean {
  return argv.some((arg) => arg === "-nc" || arg === "--no-context-files");
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !parse(rel).root);
}

/** Nearest ordinary repository/worktree marker containing a source directory. */
function repositoryRoot(sourceDir: string): string | undefined {
  for (let dir = resolve(sourceDir); ; dir = dirname(dir)) {
    const marker = join(dir, ".git");
    try {
      const info = lstatSync(marker);
      if (info.isSymbolicLink()) {
        // A redirecting .git entry is not a project boundary.
      } else if (info.isDirectory() && statSync(join(marker, "HEAD")).isFile()) {
        return real(dir);
      } else if (info.isFile()) {
        const text = readRegular(marker)?.trim() ?? "";
        const match = /^gitdir:\s*(.+)$/.exec(text);
        if (match) {
          const gitDir = resolve(dir, match[1]!);
          if (statSync(join(gitDir, "HEAD")).isFile()) return real(dir);
        }
      }
    } catch {
      // Continue to the next ancestor when metadata is absent or incomplete.
    }
    if (dir === parse(dir).root) return undefined;
  }
}

/**
 * Project context is bounded by its nearest Git root. Without Git, the context-owning directory is the
 * boundary; home-level context uses the home directory. This is path containment, not a trust prompt.
 */
function contextSourceRoot(sourceDir: string): string {
  const home = real(homedir());
  const source = resolve(sourceDir);
  const canonicalSource = real(source);
  if (canonicalSource === home) return home;
  const repository = repositoryRoot(source);
  if (repository) return repository;
  return canonicalSource;
}

/** Read one eager context file only when its resolved path stays inside its source boundary. */
function readContextFile(path: string, sourceDir: string): string | undefined {
  let fd: number | undefined;
  try {
    const target = realpathSync(path);
    const root = contextSourceRoot(sourceDir);
    if (!isWithin(root, target)) return undefined;
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    // O_NOFOLLOW closes the final-component race where available. The inode check below is the
    // fallback for platforms that do not expose it.
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    if (noFollow === 0 && before.ino === 0) return undefined;
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const stat = fstatSync(fd);
    const targetAgain = realpathSync(target);
    const after = lstatSync(target);
    const resolvedAgain = realpathSync(path);
    if (
      targetAgain !== target ||
      !isWithin(root, targetAgain) ||
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.nlink !== 1 ||
      resolvedAgain !== target ||
      !isWithin(root, resolvedAgain)
    )
      return undefined;
    // A pathname boundary cannot tell where another hardlink points. Reject every multiply-linked file.
    return stat.isFile() &&
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.nlink === 1 &&
      stat.size <= 1024 * 1024
      ? readFileSync(fd, "utf8")
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The file's text, or undefined when it is not a readable regular file (a directory, a pipe, no permission). */
export function readRegular(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= 1024 * 1024 ? readFileSync(fd, "utf8") : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The name of the context file pi takes from `dir`: its first candidate that reads as a regular file. */
function contextName(dir: string): string | undefined {
  return CONTEXT_NAMES.find((name) => readRegular(join(dir, name)) !== undefined);
}

/**
 * The main checkout, when cwd is in a linked worktree nested inside it and the worktree's own context file
 * shadows the main one's: pi (findShadowedContextFile) then skips the main checkout's context file. Canonical path.
 */
function shadowedCheckout(cwd: string): string | undefined {
  for (const dir of chain(cwd).reverse()) {
    const dotGit = join(dir, ".git");
    if (!existsSync(dotGit)) continue;
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return undefined;
      const text = stat.isFile() ? (readRegular(dotGit)?.trim() ?? "") : "";
      if (!text.startsWith("gitdir: ")) continue;
      const gitDir = resolve(dir, text.slice(8).trim());
      if (!existsSync(join(gitDir, "HEAD"))) return undefined;
      const commondir = join(gitDir, "commondir");
      const common = real(
        existsSync(commondir) ? resolve(gitDir, readRegular(commondir)?.trim() ?? "") : gitDir,
      );
      const main = dirname(common);
      const worktree = real(dir);
      if (!worktree.startsWith(`${main}${sep}`) || real(join(main, ".git")) !== common)
        return undefined;
      const ours = contextName(worktree);
      const theirs = contextName(main);
      return ours !== undefined &&
        theirs !== undefined &&
        real(join(main, theirs)) === join(main, ours)
        ? main
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The local files that load, in walk order: each a readable regular file, none from a main checkout a nested
 * worktree shadows, and each real file once, counting `loaded` (files pi already has) as seen.
 */
export function localFiles(cwd: string, loaded: string[] = []): ContextFile[] {
  const shadowed = shadowedCheckout(cwd);
  const seen = new Set(loaded.map(real));
  const out: ContextFile[] = [];
  for (const dir of chain(cwd)) {
    if (shadowed !== undefined && real(dir) === shadowed) continue;
    const path = join(dir, LOCAL_FILE);
    const content = readContextFile(path, dir);
    if (content === undefined || seen.has(real(path))) continue;
    seen.add(real(path));
    out.push({ path, content });
  }
  return out;
}

/**
 * Puts each directory's AGENTS.local.md straight after that directory's own context files, so a personal file
 * reads as a continuation of the team's. Files pi took from outside the walk (the agent directory) stay first.
 * Unreadable additions are left out; selected behavioral snippets are assembled separately.
 */
export function withLocalFiles(files: ContextFile[], cwd: string): ContextFile[] {
  const dirs = chain(cwd);
  const directoryOf = (path: string) => {
    const folder = dirname(resolve(cwd, path));
    return real(folder.endsWith(`${sep}${INSTRUCTIONS_DIR}`) ? dirname(dirname(folder)) : folder);
  };
  const inWalk = new Set(dirs.map(real));
  const locals = localFiles(
    cwd,
    files.map((file) => resolve(cwd, file.path)),
  );
  const result = files.filter((file) => !inWalk.has(directoryOf(file.path)));
  const emittedDirectories = new Set<string>();
  for (const dir of dirs) {
    const directory = real(dir);
    if (emittedDirectories.has(directory)) continue;
    emittedDirectories.add(directory);
    result.push(...files.filter((file) => directoryOf(file.path) === directory));
    result.push(...locals.filter((file) => directoryOf(file.path) === directory));
  }
  return result;
}

export function localInstructionChoices(cwd: string): ContextFile[] {
  return chain(cwd).flatMap((dir) => chosenInstructions(dir));
}

/** Pack files are already bounded by their owning pack; selection still uses catalogue IDs. */
export function selectedPackInstructions(
  files: ContextFile[],
  selected: string[] | undefined,
  loaded: string[],
) {
  if (!selected) return [];
  const wanted = new Set(selected),
    seen = new Set(loaded.map(real));
  return files.filter((file) => {
    if (!wanted.has(catalogueInstructionId(dirname(file.path), basename(file.path)))) return false;
    const canonical = real(file.path);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/** Select local behavioral snippets in walk order without repeating an already loaded source. */
export function selectedLocalInstructions(
  cwd: string,
  selected: string[] | undefined,
  loaded: string[] = [],
  choices = localInstructionChoices(cwd),
): ContextFile[] {
  const seen = new Set(loaded.map(real));
  const shadowed = shadowedCheckout(cwd);
  return choices.filter((file) => {
    if (shadowed && real(dirname(dirname(dirname(file.path)))) === shadowed) return false;
    const canonical = real(file.path);
    if (seen.has(canonical)) return false;
    if (selected && !selected.includes(`local:${relative(resolve(cwd), file.path)}`)) return false;
    seen.add(canonical);
    return true;
  });
}

/** Adds selected catalogue files once by canonical path, keeping already loaded sources first. */
export function selectedCatalogueInstructions(
  catalogues: string[],
  selected: string[],
  loaded: string[] = [],
): ContextFile[] {
  const wanted = new Set(selected);
  const seen = new Set(loaded.map(real));
  const out: ContextFile[] = [];
  for (const catalogue of catalogues) {
    let names: string[];
    try {
      names = readdirSync(catalogue)
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const id = catalogueInstructionId(catalogue, name);
      if (!wanted.has(id)) continue;
      if (seen.has(real(join(catalogue, name)))) continue;
      const file = readCatalogueInstruction(catalogue, name);
      if (!file) continue;
      const canonical = real(file.path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(file);
    }
  }
  return out;
}

/** Read one catalogue entry with the same regular-file, containment, and size checks as prompt loading. */
export function readCatalogueInstruction(catalogue: string, name: string): ContextFile | undefined {
  if (name !== name.split(/[\\/]/).at(-1) || !name.endsWith(".md")) return undefined;
  const path = join(catalogue, name);
  const content = readContextFile(path, catalogue);
  return content === undefined ? undefined : { path, content };
}

/** Read a directory's behavioral snippets in filename order. */
export function chosenInstructions(dir: string): ContextFile[] {
  const folder = join(dir, INSTRUCTIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(folder)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(folder, name);
    const content = readContextFile(path, dir);
    return content === undefined ? [] : [{ path, content }];
  });
}

/** Local files that exist, even as a dangling symlink, but cannot be loaded, so a personal instruction does not vanish without a word. */
export function unreadableLocalFiles(cwd: string): string[] {
  const present = (file: string) => {
    try {
      return Boolean(lstatSync(file));
    } catch {
      return false;
    }
  };
  return chain(cwd)
    .map((dir) => join(dir, LOCAL_FILE))
    .filter((file) => present(file) && readContextFile(file, dirname(file)) === undefined);
}
