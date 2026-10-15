import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LOCAL_FILE } from "./local-context.ts";

const GIT_SAFE = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];
const MAX_EXCLUDE_BYTES = 1024 * 1024;
export interface IgnoreOutcome {
  file: string;
  status:
    | "added"
    | "already-ignored"
    | "already-present"
    | "tracked"
    | "outside-git"
    | "refused"
    | "unknown";
}

/** Only user settings can enable writes; malformed or missing settings opt out. */
export function autoGitIgnoreEnabled(
  agentDir: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  try {
    return JSON.parse(read(join(agentDir, "settings.json")))?.localContext?.autoGitIgnore === true;
  } catch {
    return false;
  }
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("GIT_") ||
        ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key),
    ),
  );
}
function git(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { code: number | undefined; text: string } {
  try {
    return {
      code: 0,
      text: execFileSync("git", [...GIT_SAFE, "-C", dir, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 65536,
      }).trim(),
    };
  } catch (error) {
    return { code: (error as { status?: number }).status, text: "" };
  }
}
function safeDirectory(path: string): boolean {
  const stat = lstatSync(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() &&
    realpathSync(path) === resolve(path)
  );
}

function readBacklink(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.())
      throw new Error("Invalid Git backlink");
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/** A registered linked worktree points back to this checkout; arbitrary .git redirects do not. */
function metadataBelongsTo(repository: string, common: string, gitDir: string): boolean {
  try {
    if (!safeDirectory(common) || !safeDirectory(gitDir)) return false;
    if (common === join(repository, ".git") && gitDir === common) return true;
    if (basename(common) !== ".git" || !gitDir.startsWith(join(common, "worktrees") + sep))
      return false;
    const entry = lstatSync(join(repository, ".git"));
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.uid !== process.getuid?.()
    )
      return false;
    const backlink = readBacklink(join(gitDir, "gitdir"));
    const shared = readBacklink(join(gitDir, "commondir"));
    return (
      realpathSync(resolve(gitDir, backlink)) === join(repository, ".git") &&
      realpathSync(resolve(gitDir, shared)) === common
    );
  } catch {
    return false;
  }
}

function safeExcludeTarget(common: string, target: string): boolean {
  try {
    if (target !== join(common, "info", "exclude") || !safeDirectory(common)) return false;
    try {
      if (!safeDirectory(dirname(target))) return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      const stat = lstatSync(target);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        stat.size <= MAX_EXCLUDE_BYTES
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch {
    return false;
  }
}

/** Append only to an owned, regular Git personal exclude file; never follow a redirecting symlink. */
function appendRule(common: string, target: string): "added" | "already-present" | "refused" {
  let fd: number | undefined;
  try {
    if (target !== join(common, "info", "exclude") || !safeDirectory(common)) return "refused";
    const info = dirname(target);
    try {
      if (!safeDirectory(info)) return "refused";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "refused";
      mkdirSync(info, { mode: 0o755 });
    }
    if (!safeDirectory(info) || constants.O_NOFOLLOW === undefined) return "refused";
    fd = openSync(
      target,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const stat = fstatSync(fd),
      current = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_EXCLUDE_BYTES ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      current.isSymbolicLink() ||
      !safeDirectory(info)
    )
      return "refused";
    const before = readFileSync(fd, "utf8");
    if (before.split("\n").some((line) => line.trimEnd() === LOCAL_FILE)) return "already-present";
    const added = `${before && !before.endsWith("\n") ? "\n" : ""}${LOCAL_FILE}\n`;
    return writeSync(fd, added) === Buffer.byteLength(added) ? "added" : "refused";
  } catch {
    return "refused";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function gitRepositoryRoot(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const result = git(realpathSync(cwd), ["rev-parse", "--show-toplevel"], gitEnv(env));
    return result.code === 0 ? realpathSync(result.text) : undefined;
  } catch {
    return undefined;
  }
}

/** Fixed ignore metadata for readable local files. Outcomes are silent, explicit and independently testable. */
export function ignoreLocalFiles(
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
  mayWrite: (repository: string) => boolean = () => true,
): IgnoreOutcome[] {
  const cleanEnv = gitEnv(env);
  return files.map((file) => {
    const result = (status: IgnoreOutcome["status"]): IgnoreOutcome => ({ file, status });
    let dir: string;
    try {
      dir = realpathSync(dirname(file));
    } catch {
      return result("unknown");
    }
    const inside = git(dir, ["rev-parse", "--is-inside-work-tree"], cleanEnv);
    if (inside.code === 128 || inside.text === "false") return result("outside-git");
    if (inside.code !== 0 || inside.text !== "true") return result("unknown");
    const repository = gitRepositoryRoot(dir, cleanEnv);
    if (!repository || !mayWrite(repository)) return result("refused");
    const paths = git(
      dir,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--absolute-git-dir",
        "--git-path",
        "info/exclude",
      ],
      cleanEnv,
    );
    if (paths.code !== 0) return result("unknown");
    const [common, gitDir, target, ...extra] = paths.text.split("\n");
    if (
      !common ||
      !gitDir ||
      !target ||
      extra.length ||
      /[\x00-\x1f]/.test(paths.text.replaceAll("\n", ""))
    )
      return result("refused");
    if (!metadataBelongsTo(repository, common, gitDir) || !safeExcludeTarget(common, target))
      return result("refused");
    // Use the file's lexical entry name: a symlink's target need not belong to this repository.
    const path = join(dir, LOCAL_FILE);
    const ignored = git(dir, ["check-ignore", "-q", "--", path], cleanEnv);
    if (ignored.code === 0) return result("already-ignored");
    if (ignored.code !== 1) return result("unknown");
    const tracked = git(dir, ["ls-files", "--error-unmatch", "--", path], cleanEnv);
    if (tracked.code === 0) return result("tracked");
    if (tracked.code !== 1) return result("unknown");
    return result(appendRule(common, target));
  });
}
