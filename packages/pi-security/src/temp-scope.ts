import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TempIsolation } from "./types.ts";

export const contains = (root: string, target: string) =>
  target === root || target.startsWith(root.endsWith("/") ? root : root + path.sep);
const quote = (value: string) => {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f-\x9f]/.test(value))
    throw Error("unsafe temp path");
  return JSON.stringify(value);
};
function metadataAncestors(base: string, readableRoots: string[]) {
  const ancestors = new Set<string>();
  for (const root of readableRoots) {
    if (root === base || !contains(base, root)) continue;
    for (let parent = path.dirname(root); contains(base, parent); parent = path.dirname(parent)) {
      if (!readableRoots.some((readable) => contains(readable, parent))) ancestors.add(parent);
      if (parent === base) break;
    }
  }
  return [...ancestors].sort();
}
export function tempIsolationRules({
  base,
  own,
  launchDir,
  resourceReadAllow = [],
}: TempIsolation) {
  if (!contains(base, own) || contains(own, launchDir)) throw Error("invalid temp isolation");
  if (resourceReadAllow.some((x) => !contains(launchDir, x)))
    throw Error("invalid selected resource roots");
  const exceptions = resourceReadAllow.map((x) => ` (require-not (subpath ${quote(x)}))`).join("");
  const metadataOnly = metadataAncestors(base, [own, ...resourceReadAllow]);
  const metadataExceptions = metadataOnly
    .map((directory) => ` (require-not (literal ${quote(directory)}))`)
    .join("");
  const metadataDenials = metadataOnly
    .map((directory) => `(deny file-read-data (literal ${quote(directory)}))\n`)
    .join("");
  const readDeny = `(deny file-read* (require-all (subpath ${quote(base)}) (require-not (subpath ${quote(own)}))${metadataExceptions}${exceptions}))\n${metadataDenials}`;
  return `${readDeny}(deny file-write* (require-all (subpath ${quote(base)}) (require-not (subpath ${quote(own)}))))\n(deny file-write* (subpath ${quote(launchDir)}))\n`;
}
async function checked(directory: string) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error("symlink in temp ownership path");
  }
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077)
    throw Error("unsafe temp owner or permissions");
  return realpath(absolute);
}
export async function createTempScope({
  base,
  sessionTmp,
  launchDir: inheritedLaunchDir,
  retainSessionTmpOnClose = false,
}: {
  base?: string;
  sessionTmp?: string;
  launchDir?: string;
  retainSessionTmpOnClose?: boolean;
} = {}) {
  base ??= path.join(await realpath(os.tmpdir()), `pi-${process.getuid!()}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  base = await checked(base);
  const tmp = sessionTmp ? await checked(sessionTmp) : await mkdtemp(path.join(base, "s-"));
  if (!contains(base, tmp)) throw Error("session outside temp base");
  const launchDir = inheritedLaunchDir
    ? await checked(inheritedLaunchDir)
    : await mkdtemp(tmp === base ? base + ".launch-" : path.join(base, "l-"));
  const registered = new Set([tmp]);
  const retainedChildren = new Set<string>();
  let closed = false;
  return {
    base,
    tmp,
    launchDir,
    async allocateChild(parentTmp: string) {
      if (closed || !registered.has(parentTmp)) throw Error("unknown parent temp");
      await checked(parentTmp);
      const child = await mkdtemp(path.join(parentTmp, "c-"));
      registered.add(child);
      return child;
    },
    async removeChild(childTmp: string) {
      if (!registered.has(childTmp) || childTmp === tmp) throw Error("unknown child temp");
      await checked(childTmp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rm(childTmp, { recursive: true, force: true });
      retainedChildren.delete(childTmp);
      for (const entry of registered) if (contains(childTmp, entry)) registered.delete(entry);
    },
    async retainChild(childTmp: string) {
      if (!registered.has(childTmp) || childTmp === tmp || path.dirname(childTmp) !== tmp)
        throw Error("unknown child temp");
      // Retain only the exact registered direct-child path. Do not inspect or follow it here:
      // collection can fail precisely because the child changed its mode or replaced the root.
      // close() leaves this directory entry untouched and never traverses a replacement symlink.
      retainedChildren.add(childTmp);
    },
    async close() {
      if (closed) return;
      await checked(tmp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await checked(launchDir);
      if (!retainSessionTmpOnClose) {
        if (retainedChildren.size === 0) await rm(tmp, { recursive: true, force: true });
        else {
          for (const name of await readdir(tmp)) {
            const entry = path.join(tmp, name);
            if (!retainedChildren.has(entry)) await rm(entry, { recursive: true, force: true });
          }
        }
      }
      if (!inheritedLaunchDir) await rm(launchDir, { recursive: true, force: true });
      closed = true;
      registered.clear();
      retainedChildren.clear();
    },
  };
}
