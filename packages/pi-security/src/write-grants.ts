import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { protectedWritePattern } from "./protected-paths.ts";
import type { CallInput, Decision, LoadedPolicy, WriteGrant } from "./types.ts";

const within = (root: string, target: string) =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const plain = (root: string) => root.replace(/\/\*\*$/, "");

/** Resolve existing symlinks, retaining only nonexistent suffixes below a real directory. */
export function canonicalWritePath(value: string, cwd: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f-\x9f*?\[\]]/.test(value))
    throw Error("invalid writable path; use a file or directory, without glob characters");
  let current = path.resolve(cwd, value);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync(current);
      if (suffix.length && !lstatSync(canonical).isDirectory())
        throw Error("write destination ancestor is not a directory");
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink must not be mistaken for a new file.
      try {
        if (lstatSync(current).isSymbolicLink()) throw Error("dangling write destination symlink");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

export function writePathDenied(target: string, loaded: LoadedPolicy): boolean {
  const temp = loaded.tempIsolation;
  return (
    protectedWritePattern.test(target) ||
    [...loaded.filesystem.writeDeny, ...loaded.filesystem.readDeny].some((root) => {
      const literal = plain(root);
      return within(literal, target) || within(canonicalWritePath(literal, loaded.project), target);
    }) ||
    !!(
      temp &&
      ((within(temp.base, target) && !within(temp.own, target)) || within(temp.launchDir, target))
    )
  );
}

export function requestedWriteGrants(
  tool: string,
  input: CallInput,
  loaded: LoadedPolicy,
  cwd = loaded.project,
): WriteGrant[] {
  const writing = tool === "write" || tool === "edit";
  if (tool !== "bash" && !writing) return [];
  const requested = writing ? [input.path] : (input.permissions?.write ?? []);
  if (!Array.isArray(requested)) throw Error("permissions.write must be an array of paths");
  const grants: WriteGrant[] = [];
  for (const value of requested) {
    const target = canonicalWritePath(value as string, cwd);
    if (writePathDenied(target, loaded))
      throw Error("write destination is protected or explicitly denied");
    if (
      loaded.filesystem.writeAllow.some((root) =>
        within(canonicalWritePath(plain(root), loaded.project), target),
      )
    )
      continue;
    if (loaded.limits?.write === false)
      throw Error("extra write access exceeds write permission ceiling");
    const exists = (() => {
      try {
        return lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
    })();
    if (writing && exists?.isDirectory()) throw Error("file tool destination is a directory");
    if (exists?.isFile() && exists.nlink > 1)
      throw Error("extra write destination has multiple hard links");
    if (exists && !exists.isDirectory() && !exists.isFile())
      throw Error("write destination is not a regular file or directory");
    const createParents: string[] = [];
    for (let parent = path.dirname(target); ; ) {
      try {
        if (!lstatSync(parent).isDirectory())
          throw Error("write destination ancestor is not a directory");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (writePathDenied(parent, loaded)) throw Error("write destination ancestor is protected");
      createParents.push(parent);
      parent = path.dirname(parent);
    }
    if (!grants.some((grant) => grant.path === target))
      grants.push({
        path: target,
        source: path.resolve(cwd, value as string),
        kind: exists?.isDirectory() ? "directory" : "file",
        createParents,
      });
  }
  return grants;
}

/** Recheck spelling and hard limits just before sandbox launch; never mutate shared policy. */
export function validateWriteGrants(
  grants: WriteGrant[],
  loaded: LoadedPolicy,
  permissions: { write: boolean },
): void {
  if (grants.length && (!permissions.write || loaded.limits?.write === false))
    throw Error("write grant exceeds write permission ceiling");
  for (const grant of grants) {
    if (
      canonicalWritePath(grant.source, loaded.project) !== grant.path ||
      writePathDenied(grant.path, loaded)
    )
      throw Error("approved write destination changed or is denied");
    if (grant.kind === "directory" && !lstatSync(grant.path).isDirectory())
      throw Error("approved write directory changed");
    if (grant.kind === "file") {
      try {
        if (lstatSync(grant.path).nlink > 1)
          throw Error("extra write destination has multiple hard links");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (grant.kind !== "directory" && grant.kind !== "file") throw Error("invalid write grant");
    for (const parent of grant.createParents) {
      if (
        canonicalWritePath(parent, loaded.project) !== parent ||
        !within(parent, grant.path) ||
        writePathDenied(parent, loaded)
      )
        throw Error("approved write ancestor changed or is denied");
    }
  }
}

export function attachWriteGrants(decision: Decision, grants: WriteGrant[]): Decision {
  if (!grants.length || decision.verdict !== "allow") return decision;
  if (!decision.permissions?.write)
    return {
      verdict: "deny",
      ruleIds: decision.ruleIds,
      reason: "write grant exceeds write permission ceiling",
    };
  return { ...decision, writeGrants: grants };
}
