import type { LoadedPolicy, ExecutionPermissions, ProfileOptions } from "./types.ts";
type SExpression = string | SExpression[];
import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { tempIsolationRules } from "./temp-scope.ts";
import { fetchProfileRules } from "./fetch-profile.ts";
import { canonicalWritePath, validateWriteGrants } from "./write-grants.ts";
import { protectedWriteNames, protectedWritePattern } from "./protected-paths.ts";
import { assertHostCapabilities } from "./host-capabilities.ts";
import { assertPermissions } from "./permissions.ts";

const protectedParentDepth =
  Math.max(...protectedWriteNames.map((name) => name.split("/").length)) - 1;

const base = readFileSync(new URL("./seatbelt-base.sb", import.meta.url), "utf8");

export function sbplString(value: string) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(value))
    throw Error("unsafe SBPL string");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
const regexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const protectedPattern = (value: string) =>
  regexLiteral(value).replace(
    /[a-z]/gi,
    (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`,
  );
const subpath = (value: string) => `(subpath ${sbplString(value)})`;
const literal = (value: string) => `(literal ${sbplString(value)})`;
const regex = (value: string) => `(regex ${sbplString(value)})`;

function protectedAncestors(root: string, explicitPaths: string[]) {
  const result = new Set([root]);
  const within = (target: string) =>
    target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const retain = (target: string) => {
    for (let parent = path.dirname(target); within(parent); parent = path.dirname(parent)) {
      result.add(parent);
      if (parent === root) break;
    }
  };
  for (const item of explicitPaths) {
    const target = item.endsWith("/**") ? item.slice(0, -3) : item;
    if (within(target)) {
      result.add(target);
      retain(target);
    }
    try {
      const canonical = realpathSync(target);
      if (within(canonical)) {
        result.add(canonical);
        retain(canonical);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    // The native resolver avoids resolving every ancestor again in JavaScript. The
    // following directory read verifies its type, so a separate lstat is redundant.
    if (realpathSync.native(directory) !== directory)
      throw Error("write scope directory changed during profile compilation");
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
        throw Error("write scope directory changed during profile compilation", { cause: error });
      throw error;
    }
    // No protected ancestor is traversed: a possible match therefore needs only
    // the entry name and the vocabulary's longest parent suffix, not its full path.
    const suffix = protectedParentDepth
      ? path.relative(root, directory).split(path.sep).slice(-protectedParentDepth).join("/")
      : "";
    const prefix = suffix ? `${suffix}/` : "";
    for (const entry of entries) {
      if (protectedWritePattern.test(prefix + entry.name)) retain(path.join(directory, entry.name));
      else if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  return result;
}

function grantHardlinks(root: string): string[] {
  const found: string[] = [],
    pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    if (realpathSync.native(directory) !== directory) throw Error("extra write directory changed");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && lstatSync(target).nlink > 1) found.push(target);
    }
  }
  return found;
}

function globFilter(pattern: string) {
  if (pattern.endsWith("/**")) return subpath(pattern.slice(0, -3));
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("["))
    throw Error(`unsupported glob ${pattern}`);
  return subpath(pattern);
}

function validateSyntax(profile: string) {
  // Parse every emitted S-expression and reject anything outside this compiler's rule vocabulary.
  const tokens = profile.replace(/;[^\n]*/g, "").match(/\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g) ?? [];
  let index = 0;
  const atom = (): SExpression => {
    const token = tokens[index++];
    if (token === "(") {
      const list = [];
      while (tokens[index] !== ")") {
        if (index >= tokens.length) throw Error("unclosed SBPL form");
        list.push(atom());
      }
      index++;
      return list;
    }
    if (!token || token === ")") throw Error("bad SBPL form");
    return token;
  };
  const forms: SExpression[] = [];
  while (index < tokens.length) forms.push(atom());
  const top = new Set(["version", "deny", "allow"]);
  const operations = new Set([
    "default",
    "process-fork",
    "process-info*",
    "signal",
    "mach-priv-task-port",
    "user-preference-read",
    "mach-lookup",
    "ipc-posix-shm",
    "ipc-posix-sem",
    "iokit-open",
    "iokit-get-properties",
    "system-socket",
    "sysctl-read",
    "file-ioctl",
    "file-read-data",
    "file-write-data",
    "process-exec",
    "file-read*",
    "file-write*",
    "file-write-unlink",
    "file-write-create",
    "network-outbound",
  ]);
  const filters = new Set([
    "target",
    "global-name",
    "iokit-registry-entry-class",
    "iokit-user-client-class",
    "require-all",
    "require-not",
    "socket-domain",
    "socket-protocol",
    "sysctl-name",
    "sysctl-name-prefix",
    "literal",
    "subpath",
    "regex",
    "vnode-type",
    "remote",
  ]);
  for (const form of forms) {
    if (!Array.isArray(form) || !top.has(form[0] as string)) throw Error("unexpected SBPL rule");
    if (form[0] === "version") {
      if (form.length !== 2 || form[1] !== "1") throw Error("bad SBPL version");
      continue;
    }
    let filterStart = 1;
    while (typeof form[filterStart] === "string" && operations.has(form[filterStart] as string))
      filterStart++;
    if (filterStart === 1) throw Error("unknown SBPL operation");
    const checkFilter = (node: SExpression): void => {
      if (!Array.isArray(node) || !filters.has(node[0] as string))
        throw Error("unknown SBPL filter");
      if (
        node[0] === "remote" &&
        (node.length !== 3 || node[1] !== "ip" || !/^"localhost:[0-9]+"$/.test(node[2] as string))
      )
        throw Error("invalid fetch remote");
      for (const child of node.slice(1)) if (Array.isArray(child)) checkFilter(child);
    };
    for (const filter of form.slice(filterStart)) checkFilter(filter);
  }
  if (!forms.some((f) => Array.isArray(f) && f[0] === "deny" && f[1] === "default"))
    throw Error("profile is not deny default");
}

export function compileProfile(
  loaded: LoadedPolicy,
  permissions: ExecutionPermissions,
  { policyPath, extensionPath, fetchLease, writeGrants = [] }: ProfileOptions = {},
) {
  assertPermissions(permissions, loaded);
  if (permissions.execution === "host") throw Error("host execution has no sandbox profile");
  validateWriteGrants(writeGrants, loaded, permissions);
  const roots = [
    ...loaded.filesystem.writeAllow,
    ...writeGrants.filter((grant) => grant.kind === "directory").map((grant) => grant.path),
  ];
  let out = base.trimEnd() + "\n";
  assertHostCapabilities(loaded.capabilities);
  if (loaded.capabilities?.includes("gpu")) {
    out += '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))\n';
    out += '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))\n';
  }
  if (
    !out.includes("(deny default)") ||
    out.includes("distributed-notification-post") ||
    out.includes("com.apple.distributed_notifications")
  )
    throw Error("unsafe base profile");
  // The base permits reads and essential host services, but no regular-file writes or network.
  out += '(allow file-write* (literal "/dev/null"))\n';
  if (permissions.write) for (const root of roots) out += `(allow file-write* ${subpath(root)})\n`;
  if (permissions.write)
    for (const grant of writeGrants) {
      if (grant.kind === "directory")
        for (const alias of grantHardlinks(grant.path))
          out += `(deny file-read* file-write* ${literal(alias)})\n`;
      if (grant.kind === "file") out += `(allow file-write* ${literal(grant.path)})\n`;
      for (const parent of grant.createParents)
        out += `(allow file-write-create (require-all ${literal(parent)} (vnode-type DIRECTORY)))\n`;
    }
  const protectedAbsolute = [
    policyPath,
    process.env.PI_CODING_AGENT_DIR,
    extensionPath && path.dirname(extensionPath),
    path.join(process.env.HOME ?? "/", ".pi"),
    loaded.tempIsolation?.launchDir,
  ].filter((item): item is string => Boolean(item));
  for (const item of protectedAbsolute) out += `(deny file-write* ${subpath(item)})\n`;
  for (const root of roots) {
    out += `(deny file-read* ${regex(`^${regexLiteral(root)}/(.*/)?\\.pi/(agent/)?(auth\\.json|mcp\\.json|mcp-auth\\.json)(/.*)?$`)})\n`;
    for (const name of protectedWriteNames) {
      const escapedRoot = regexLiteral(root);
      const escapedName = protectedPattern(name);
      out += `(deny file-write* ${regex(`^${escapedRoot}/(.*/)?${escapedName}(/.*)?$`)})\n`;
      out += `(deny file-write-unlink file-write-create ${regex(`^${escapedRoot}/(.*/)?${escapedName}$`)})\n`;
    }
    // Cargo needs temporary-directory unlink/rename. Freeze ancestors of existing protected
    // entries instead; the name rules above prevent creating future protected descendants.
    if (permissions.write)
      for (const directory of protectedAncestors(root, [
        ...protectedAbsolute,
        ...loaded.filesystem.writeDeny,
        ...loaded.filesystem.readDeny,
      ])) {
        out += `(deny file-write-unlink (require-all ${literal(directory)} (vnode-type DIRECTORY)))\n`;
      }
  }
  for (const [operation, paths] of [
    ["file-write*", loaded.filesystem.writeDeny],
    ["file-read*", loaded.filesystem.readDeny],
  ] as const)
    for (const item of paths) {
      out += `(deny ${operation} ${globFilter(item)})\n`;
      const canonical = canonicalWritePath(item.replace(/\/\*\*$/, ""), loaded.project ?? "/");
      if (canonical !== item.replace(/\/\*\*$/, ""))
        out += `(deny ${operation} ${subpath(canonical)})\n`;
    }
  if (loaded.tempIsolation) out += tempIsolationRules(loaded.tempIsolation);
  if (permissions.network.length > 0) out += fetchProfileRules(fetchLease);
  validateSyntax(out);
  return out;
}
