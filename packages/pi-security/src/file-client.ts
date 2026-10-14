import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { LoadedPolicy, ProfileOptions } from "./types.ts";
import type { wrapShell as wrapFunction } from "./wrap-shell.ts";
import type {
  FileClient,
  HelperOperation,
  HelperArguments,
  HelperResults,
  HelperResponse,
} from "./file-protocol.ts";
interface ClientOptions extends ProfileOptions {
  loaded: LoadedPolicy;
  mode: "read-only" | "write";
  wrapShell: typeof wrapFunction;
  compileProfile: Parameters<typeof compileFileProfile>[2]["compileProfile"];
  executables?: { node?: string; rg?: string; fd?: string };
}
const HELPER_SHUTDOWN_GRACE_MS = 1000;
const HELPER_FORCE_KILL_GRACE_MS = 250;
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostExecutable } from "./host-executables.ts";
import { compileFileProfile } from "./file-profile.ts";
import { sandboxCommand } from "./linux-executor.ts";

export async function createFileClient({
  loaded,
  mode,
  wrapShell,
  compileProfile,
  policyPath,
  extensionPath,
  executables = {},
  writeGrants,
}: ClientOptions): Promise<FileClient> {
  const helperLoaded = writeGrants?.length
    ? { ...loaded, filesystem: { ...loaded.filesystem, writeAllow: [] } }
    : loaded;
  const helperPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".js") ? "./file-helper.js" : "./file-helper.ts",
      import.meta.url,
    ),
  );
  const trusted = await Promise.all([
    resolveHostExecutable(["node"], [], executables.node ?? process.execPath),
    resolveHostExecutable(["rg"], loaded.policy.env.path, executables.rg),
    resolveHostExecutable(["fd", "fdfind"], loaded.policy.env.path, executables.fd),
  ]);
  const profileText =
    process.platform === "linux"
      ? undefined
      : await compileFileProfile(helperLoaded, mode, {
          compileProfile,
          policyPath,
          extensionPath,
          helperPath,
          writeGrants,
          executables: trusted,
        });
  const pending = new Map<
    number,
    {
      resolve: (result: HelperResults[HelperOperation] | undefined) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  let child: ChildProcessWithoutNullStreams | undefined,
    closed = false,
    restarts = 0,
    counter = 0,
    launching: Promise<void> | undefined;
  const profileDirectories = new Set<string>();
  const closedHelpers = new WeakSet<ChildProcessWithoutNullStreams>();
  const commandGroups = new Map<number, Set<number>>();
  let commandGroupCleanup: Promise<void> | undefined;
  const signalGroup = (pid: number, signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else process.kill(pid, signal);
    } catch {}
  };
  const stopCommandGroups = () => {
    if (commandGroupCleanup) return commandGroupCleanup;
    if (!commandGroups.size) return Promise.resolve();
    for (const group of commandGroups.values())
      for (const pid of group) signalGroup(pid, "SIGTERM");
    commandGroupCleanup = new Promise<void>((resolve) => {
      setTimeout(() => {
        for (const group of commandGroups.values())
          for (const pid of group) signalGroup(pid, "SIGKILL");
        commandGroups.clear();
        commandGroupCleanup = undefined;
        resolve();
      }, HELPER_FORCE_KILL_GRACE_MS);
    });
    return commandGroupCleanup;
  };
  const writeFrame = (
    c: ChildProcessWithoutNullStreams,
    frame: object,
    onError?: (error: Error) => void,
  ) => {
    if (c.stdin.destroyed || c.stdin.writableEnded || c.stdin.writableFinished) return false;
    try {
      c.stdin.write(JSON.stringify(frame) + "\n", (error) => {
        if (error) onError?.(error);
      });
      return true;
    } catch (error) {
      onError?.(error as Error);
      return false;
    }
  };
  const started = performance.now();
  async function launch() {
    if (closed) throw Error("helper closed");
    const wrapped = wrapShell(
      { argv: [trusted[0], helperPath, trusted[1], trusted[2]] },
      { write: mode === "write", network: [] },
      helperLoaded,
      { profileText, policyPath, extensionPath, writeGrants },
    );
    const dir = await mkdtemp(
      path.join(loaded.tempIsolation?.launchDir ?? loaded.tmp, "helper-profile-"),
    );
    profileDirectories.add(dir);
    try {
      if (closed) throw Error("helper closed");
      const profilePath = path.join(dir, "helper.sb");
      await writeFile(profilePath, wrapped.profile, { mode: 0o600 });
      if (closed) throw Error("helper closed");
      const [executable, ...args] = sandboxCommand(wrapped, profilePath);
      const c = spawn(executable, args, {
        cwd: loaded.project,
        env: wrapped.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = c;
      let bytes = Buffer.alloc(0),
        stderr = "",
        ready = false;
      const boot = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          c.kill();
          reject(Error("helper ready timeout"));
        }, 10000);
        c.stdout.on("data", (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          let i: number;
          while ((i = bytes.indexOf(10)) >= 0) {
            const line = bytes.subarray(0, i);
            bytes = bytes.subarray(i + 1);
            let frame: HelperResponse;
            try {
              frame = JSON.parse(line.toString("utf8"));
            } catch {
              c.kill();
              continue;
            }
            if (frame.processGroup) {
              if (
                frame.id === undefined ||
                !Number.isSafeInteger(frame.processGroup.pid) ||
                frame.processGroup.pid <= 0
              )
                continue;
              const group = commandGroups.get(frame.id);
              if (frame.processGroup.state === "started") {
                const pids = group ?? new Set<number>();
                pids.add(frame.processGroup.pid);
                commandGroups.set(frame.id, pids);
              } else if (group) {
                group.delete(frame.processGroup.pid);
                if (!group.size) commandGroups.delete(frame.id);
              }
              continue;
            }
            if (frame.ready) {
              ready = true;
              clearTimeout(timer);
              resolve();
              continue;
            }
            const p = pending.get(frame.id!);
            if (!p) continue;
            pending.delete(frame.id!);
            p.cleanup();
            if (frame.error) p.reject(Object.assign(Error(frame.error.message), frame.error));
            else p.resolve(frame.result);
          }
        });
        c.stderr.on("data", (b) => {
          stderr = (stderr + b).slice(-8192);
        });
        c.stdin.on("error", (error) => {
          const failure = Error(`helper input failed: ${error.message}`);
          for (const p of pending.values()) {
            p.cleanup();
            p.reject(failure);
          }
          pending.clear();
        });
        c.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        c.once("close", (code, signal) => {
          closedHelpers.add(c);
          void stopCommandGroups();
          clearTimeout(timer);
          if (child === c) child = undefined;
          const e = Error(`helper exited ${code ?? signal}: ${stderr}`);
          if (!ready) reject(e);
          for (const p of pending.values()) {
            p.cleanup();
            p.reject(e);
          }
          pending.clear();
        });
      });
      await boot;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      profileDirectories.delete(dir);
      throw error;
    }
  }
  await launch();
  const readyMs = performance.now() - started;
  async function ensure() {
    if (closed) throw Error("helper closed");
    if (child) return;
    if (launching) return launching;
    if (restarts >= 1) throw Error("helper restart exhausted");
    restarts++;
    launching = launch().finally(() => {
      launching = undefined;
    });
    return launching;
  }
  return {
    readyMs,
    async request<K extends HelperOperation>(
      op: K,
      args: HelperArguments[K],
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<HelperResults[K]> {
      if (signal?.aborted) throw Error("Operation aborted");
      await ensure();
      return new Promise<HelperResults[K]>((resolve, reject) => {
        if (closed || signal?.aborted) {
          reject(Error(closed ? "helper closed" : "Operation aborted"));
          return;
        }
        const helper = child;
        if (!helper) {
          reject(Error("helper unavailable"));
          return;
        }
        const id = ++counter;
        const abort = () => {
          if (!pending.delete(id)) return;
          if (!closed && child === helper) writeFrame(helper, { id, cancel: true });
          cleanup();
          reject(Error("Operation aborted"));
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        pending.set(id, {
          resolve: (result) => resolve(result as HelperResults[K]),
          reject,
          cleanup,
        });
        signal?.addEventListener("abort", abort, { once: true });
        const wrote = writeFrame(helper, { id, op, args }, (error) => {
          if (error && pending.delete(id)) {
            cleanup();
            reject(error);
          }
        });
        if (!wrote && pending.delete(id)) {
          cleanup();
          reject(Error("helper input is closed"));
        }
      });
    },
    async close() {
      closed = true;
      const stop = async (c: ChildProcessWithoutNullStreams) => {
        await new Promise<void>((resolve) => {
          let finished = false;
          let grace: NodeJS.Timeout | undefined;
          let force: NodeJS.Timeout | undefined;
          const finish = () => {
            if (finished) return;
            finished = true;
            if (grace) clearTimeout(grace);
            if (force) clearTimeout(force);
            c.removeListener("close", finish);
            resolve();
          };
          const signalTree = (signal: NodeJS.Signals) => {
            if (process.platform !== "win32" && c.pid) {
              try {
                process.kill(-c.pid, signal);
                return;
              } catch {
                // Fall back to killing the helper itself if its group is gone.
              }
            }
            c.kill(signal);
          };
          c.once("close", finish);
          if (closedHelpers.has(c)) {
            finish();
            return;
          }
          grace = setTimeout(() => {
            if (finished) return;
            signalTree("SIGTERM");
            force = setTimeout(() => signalTree("SIGKILL"), HELPER_FORCE_KILL_GRACE_MS);
          }, HELPER_SHUTDOWN_GRACE_MS);
          if (!c.stdin.destroyed && !c.stdin.writableEnded) c.stdin.end();
        });
      };
      const current = child;
      if (current) await stop(current);
      await launching?.catch(() => {});
      const launchedDuringClose = child;
      if (launchedDuringClose && launchedDuringClose !== current) await stop(launchedDuringClose);
      await commandGroupCleanup;
      await Promise.all(
        [...profileDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
      );
      profileDirectories.clear();
    },
  };
}
