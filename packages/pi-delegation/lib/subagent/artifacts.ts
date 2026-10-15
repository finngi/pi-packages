import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PreparedChild } from "pi-contracts";
import { newSemanticId } from "pi-runtime/semantic-id";

export interface ArtifactResult {
  id: string;
  directory: string;
  files: string[];
  omitted: string[];
  owned: boolean;
  scope: "scratch-collection" | "project-reference";
  externalEffects: "untracked";
}

export interface ArtifactCollectionLimits {
  maxFiles?: number;
  maxBytes?: number;
  maxEntries?: number;
}

const DEFAULT_ARTIFACT_LIMITS = {
  maxFiles: 5_000,
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
};

function collectionLimits(requested: ArtifactCollectionLimits) {
  return Object.fromEntries(
    Object.entries(DEFAULT_ARTIFACT_LIMITS).map(([key, fallback]) => {
      const value = requested[key as keyof ArtifactCollectionLimits];
      if (value === undefined) return [key, fallback];
      if (!Number.isSafeInteger(value) || value < 1)
        throw Error(`Artifact collection ${key} must be a positive safe integer`);
      return [key, Math.min(value, fallback)];
    }),
  ) as typeof DEFAULT_ARTIFACT_LIMITS;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function sameFile(first: { dev: number; ino: number }, second: { dev: number; ino: number }) {
  return first.dev === second.dev && first.ino === second.ino;
}

/** Create missing output parents one directory at a time and reject symlink leaves. */
async function ensureRealDirectory(path: string, rejectLeafSymlink = true): Promise<string> {
  const absolute = resolve(path);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    const canonicalParent = await ensureRealDirectory(parent, false);
    const child = join(canonicalParent, basename(absolute));
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    const childInfo = await lstat(child);
    const canonicalChild = await realpath(child);
    if (
      !childInfo.isDirectory() ||
      childInfo.isSymbolicLink() ||
      canonicalChild !== child ||
      !sameFile(childInfo, await lstat(canonicalChild))
    )
      throw Error("Artifact destination parent is not a real directory");
    return child;
  }
  if (info.isSymbolicLink() && rejectLeafSymlink)
    throw Error("Artifact destination parent is not a real directory");
  const canonical = await realpath(absolute);
  const canonicalInfo = await lstat(canonical);
  const currentInfo = await lstat(absolute);
  if (
    !canonicalInfo.isDirectory() ||
    (!info.isSymbolicLink() && !sameFile(info, canonicalInfo)) ||
    !sameFile(info, currentInfo)
  )
    throw Error("Artifact destination parent changed during validation");
  return canonical;
}

/** Copy from the opened regular-file descriptor so a later path replacement cannot redirect reads. */
async function copyRegularFile(
  source: string,
  destination: string,
  workspaceRoot: string,
  budget: { files: number; bytes: number },
  limits: typeof DEFAULT_ARTIFACT_LIMITS,
): Promise<boolean> {
  let canonical: string;
  let expected: Awaited<ReturnType<typeof lstat>>;
  try {
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return false;
    canonical = await realpath(source);
    if (!within(workspaceRoot, canonical)) return false;
    expected = await lstat(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!expected.isFile() || expected.nlink !== 1) return false;
  if (budget.files >= limits.maxFiles || expected.size > limits.maxBytes - budget.bytes)
    throw Error("Artifact collection budget exceeded");

  let input: Awaited<ReturnType<typeof open>>;
  try {
    input = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }

  try {
    const sourceInfo = await input.stat();
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1 || !sameFile(sourceInfo, expected))
      return false;
    const currentPath = await realpath(source);
    const currentInfo = await lstat(canonical);
    if (
      currentPath !== canonical ||
      !within(workspaceRoot, currentPath) ||
      !currentInfo.isFile() ||
      currentInfo.nlink !== 1 ||
      !sameFile(sourceInfo, currentInfo)
    )
      return false;

    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      output = await open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_TRUNC,
        0o600,
      );
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        if (position + bytesRead > limits.maxBytes - budget.bytes)
          throw Error("Artifact collection budget exceeded");
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten === 0) throw Error("Artifact copy made no write progress");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await output.chmod(sourceInfo.mode & 0o777);
      budget.files++;
      budget.bytes += position;
    } catch (error) {
      if (output) {
        const failedOutput = output;
        output = undefined;
        await failedOutput.close().catch(() => undefined);
        await unlink(destination).catch(() => undefined);
      }
      throw error;
    } finally {
      await output?.close();
    }
    return true;
  } finally {
    await input.close();
  }
}

export async function collectArtifacts(
  child: PreparedChild,
  directory: string,
  requestedLimits: ArtifactCollectionLimits = {},
): Promise<ArtifactResult> {
  const limits = collectionLimits(requestedLimits);
  const id = newSemanticId("artifact");
  if (child.workspaceKind === "project")
    return {
      id,
      directory: child.cwd,
      files: [],
      omitted: [],
      owned: false,
      scope: "project-reference",
      externalEffects: "untracked",
    };
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== "number" ||
    constants.O_DIRECTORY === 0
  )
    throw Error("Artifact collection requires O_NOFOLLOW and O_DIRECTORY support");
  const workspace = resolve(child.cwd);
  const expectedWorkspace = child.workspaceIdentity;
  if (!expectedWorkspace)
    throw Error("Scratch workspace identity is unavailable; original workspace retained");
  const workspaceInfo = await lstat(workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink())
    throw Error("Workspace root was replaced by a symlink; original workspace retained");
  const workspaceRoot = await realpath(workspace);
  const canonicalWorkspaceInfo = await lstat(workspaceRoot);
  if (
    workspaceRoot !== expectedWorkspace.path ||
    !canonicalWorkspaceInfo.isDirectory() ||
    !sameFile(workspaceInfo, canonicalWorkspaceInfo) ||
    !sameFile(workspaceInfo, expectedWorkspace)
  )
    throw Error("Workspace root changed before artifact collection; original workspace retained");
  const destinationParent = await ensureRealDirectory(directory),
    destination = join(destinationParent, id);
  await mkdir(destination, { mode: 0o700 });
  const destinationInfo = await lstat(destination);
  const canonicalDestination = await realpath(destination);
  if (
    !destinationInfo.isDirectory() ||
    destinationInfo.isSymbolicLink() ||
    canonicalDestination !== destination ||
    !sameFile(destinationInfo, await lstat(canonicalDestination))
  )
    throw Error("Artifact destination was replaced during creation; original workspace retained");
  const files: string[] = [],
    omitted: string[] = [],
    budget = { files: 0, bytes: 0, entries: 0 };
  const internal = child.env.PI_CODING_AGENT_DIR
    ? resolve(child.env.PI_CODING_AGENT_DIR)
    : undefined;
  async function copyDirectory(
    source: string,
    target: string,
    prefix: string,
    isRoot = false,
  ): Promise<boolean> {
    let canonical: string;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let openedInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) return false;
      canonical = await realpath(source);
      if (!within(workspaceRoot, canonical)) return false;
      const canonicalInfo = await lstat(canonical);
      if (!canonicalInfo.isDirectory() || !sameFile(sourceInfo, canonicalInfo)) return false;
      handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      openedInfo = await handle.stat();
      if (!openedInfo.isDirectory() || !sameFile(openedInfo, sourceInfo)) return false;
      const currentPath = await realpath(source);
      const currentInfo = await lstat(canonical);
      if (
        currentPath !== canonical ||
        !within(workspaceRoot, currentPath) ||
        !currentInfo.isDirectory() ||
        !sameFile(openedInfo, currentInfo)
      )
        return false;
    } catch (error) {
      if (["ELOOP", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return false;
      throw error;
    } finally {
      await handle?.close();
    }

    if (!isRoot) await mkdir(target, { mode: 0o700 });
    const directory = await opendir(canonical, { bufferSize: 32 });
    try {
      const currentPath = await realpath(source),
        currentInfo = await lstat(canonical);
      if (
        !openedInfo ||
        currentPath !== canonical ||
        !within(workspaceRoot, currentPath) ||
        !currentInfo.isDirectory() ||
        !sameFile(openedInfo, currentInfo)
      ) {
        if (!isRoot) await rm(target, { recursive: true, force: true }).catch(() => undefined);
        return false;
      }
      for await (const entry of directory) {
        if (++budget.entries > limits.maxEntries)
          throw Error("Artifact collection budget exceeded");
        const origin = join(canonical, entry.name),
          result = join(target, entry.name),
          relative = prefix + entry.name;
        if (
          origin === internal ||
          origin === destinationParent ||
          origin === destination ||
          entry.name === ".git"
        )
          continue;
        if (entry.isSymbolicLink()) {
          omitted.push(relative);
          continue;
        }
        if (entry.isDirectory()) {
          if (!(await copyDirectory(origin, result, `${relative}/`))) omitted.push(relative);
        } else if (entry.isFile()) {
          if (await copyRegularFile(origin, result, workspaceRoot, budget, limits))
            files.push(relative);
          else omitted.push(relative);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    const finalPath = await realpath(source),
      finalInfo = await lstat(canonical);
    if (
      !openedInfo ||
      finalPath !== canonical ||
      !within(workspaceRoot, finalPath) ||
      !finalInfo.isDirectory() ||
      !sameFile(openedInfo, finalInfo)
    )
      throw Error(
        "Workspace directory changed during artifact collection; source workspace retained",
      );
    return true;
  }
  try {
    if (!(await copyDirectory(workspaceRoot, destination, "", true)))
      throw Error("Workspace changed during artifact collection; original workspace retained");
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof Error && error.message === "Artifact collection budget exceeded")
      throw Error(
        `Artifact collection budget exceeded (${limits.maxFiles} files, ${limits.maxBytes} bytes, ${limits.maxEntries} entries); source workspace retained at ${workspace}`,
      );
    throw error;
  }
  return {
    id,
    directory: destination,
    files,
    omitted,
    owned: true,
    scope: "scratch-collection",
    externalEffects: "untracked",
  };
}
