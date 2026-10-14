import type { LoadedPolicy, ExecutionPermissions, WrappedShell } from "./types.ts";
import path from "node:path";
import { assertHostCapabilities } from "./host-capabilities.ts";
import { assertPermissions } from "./permissions.ts";
import { chmodSync, existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
const within = (root: string, target: string) => target === root || target.startsWith(root + "/");
const absolute = (value: string) => {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value))
    throw Error("unsafe Linux scope path");
  return path.resolve(value);
};
const plainRoot = (value: string) => {
  const root = absolute(value.replace(/\/\*\*$/, ""));
  if (/[?*[]/.test(root)) throw Error("Linux scope glob unsupported");
  return root;
};
export function linuxSandboxArgv(
  command: string[],
  permissions: ExecutionPermissions,
  loaded: LoadedPolicy,
) {
  assertHostCapabilities(loaded.capabilities);
  if (process.platform !== "linux") throw Error("Linux executor requires Linux");
  if (permissions.network.length > 0) throw Error("Linux shell fetch execution is disabled");
  if (permissions.write)
    throw Error(
      "Linux writable shell execution is disabled because Bubblewrap cannot enforce write-deny rules for paths created after launch",
    );
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw Error("invalid Linux executor command");
  const own = realpathSync(absolute(loaded.tmp)),
    project = realpathSync(absolute(loaded.project));
  if (!loaded.tempIsolation?.launchDir)
    throw Error("Linux executor requires trusted launch metadata scope");
  const mask = path.join(
    realpathSync(absolute(loaded.tempIsolation.launchDir)),
    "linux-read-denied",
  );
  try {
    writeFileSync(mask, "", { flag: "wx", mode: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(mask).isFile() || lstatSync(mask).isSymbolicLink())
    throw Error("unsafe Linux denial mask");
  chmodSync(mask, 0);
  const base = loaded.tempIsolation?.base;
  const argv = [
    "/usr/bin/bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  if (base && !within("/tmp", base)) argv.push("--tmpfs", absolute(base));
  argv.push("--ro-bind", project, project);
  // The writable class was rejected above; retain the owned temp as read-only too.
  argv.push("--ro-bind", own, own);
  // Each tool gets a fresh PID/network namespace; /proc cannot reach the unsandboxed model client.
  // Only this session/child temp is restored after masking the shared temp base.
  for (const resource of loaded.tempIsolation?.resourceReadAllow ?? []) {
    const canonical = realpathSync(absolute(resource));
    if (!loaded.tempIsolation.launchDir || !within(loaded.tempIsolation.launchDir, canonical))
      throw Error("invalid child resource scope");
    argv.push("--ro-bind", canonical, canonical);
  }
  const writeDeny = loaded.filesystem.writeDeny.map(plainRoot);
  if (loaded.tempIsolation?.launchDir) writeDeny.push(absolute(loaded.tempIsolation.launchDir));
  for (const root of new Set(writeDeny)) if (existsSync(root)) argv.push("--ro-bind", root, root);
  const readDeny = loaded.filesystem.readDeny.map(plainRoot);
  if (loaded.tempIsolation?.launchDir) readDeny.push(absolute(loaded.tempIsolation.launchDir));
  for (const root of new Set(readDeny))
    if (existsSync(root)) {
      if (lstatSync(root).isDirectory()) argv.push("--tmpfs", root);
      else argv.push("--ro-bind", mask, root);
    }
  // Restore only the selected skill roots after hiding trusted launch metadata/credentials.
  for (const resource of loaded.tempIsolation?.resourceReadAllow ?? [])
    argv.push("--ro-bind", resource, resource);
  argv.push("--remount-ro", "/tmp", "--remount-ro", "/dev");
  if (base && !within("/tmp", base)) argv.push("--remount-ro", base);
  argv.push("--", ...command);
  return argv;
}

export function sandboxCommand(wrapped: WrappedShell, profilePath = "") {
  if (wrapped.execution === "host") return [...wrapped.argv];
  if (!profilePath) throw Error("sandbox profile path is required");
  if (process.platform === "linux") {
    if (!Array.isArray(wrapped.sandboxArgv) || wrapped.sandboxArgv[0] !== "/usr/bin/bwrap")
      throw Error("missing Linux kernel executor");
    return wrapped.sandboxArgv;
  }
  return ["/usr/bin/sandbox-exec", "-f", profilePath, ...wrapped.argv];
}
