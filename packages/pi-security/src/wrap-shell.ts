import type { LoadedPolicy, ExecutionPermissions, WrapOptions, WrappedShell } from "./types.ts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { validateWriteGrants } from "./write-grants.ts";
import { assertPermissions } from "./permissions.ts";
import { compileProfile } from "./profiles.ts";
import { compileProfileAsync } from "./profile-compiler.ts";
import { linuxSandboxArgv, sandboxCommand } from "./linux-executor.ts";
import { MAX_NODE_TIMER_DELAY_MS } from "pi-runtime";

const scrub =
  /^(?:PI_POLICY_LAUNCH|PI_SUBAGENT(?:_.*)?|PI_SECURITY_.*|PIP_(?:EXTRA_)?INDEX_URL|UV_(?:EXTRA_)?INDEX_URL|BASH_ENV|ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|CDPATH|IFS|PS4|DYLD_.*|LD_.*)$/;
const credentialName =
  /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|SECRET|TOKEN|JWT|PASSWORD|PGPASSWORD|MYSQL_PWD|CREDENTIALS?|PRIVATE(?:_KEY)?|AUTH(?:ORIZATION|_TOKEN)?|DSN|(?:DATABASE|DB|REDIS|MONGO(?:DB)?|POSTGRES|MYSQL)_(?:URL|URI)|CONNECTION_(?:STRING|URL)|SIGNING_KEY|ENCRYPTION_KEY|CLIENT_SECRET|PAT|KEY)(?:_|$)/i;
const scrubEnvironmentName = (name: string) => scrub.test(name) || credentialName.test(name);
export function wrapShell(
  command: string | { argv: string[] },
  permissions: ExecutionPermissions,
  loaded: LoadedPolicy,
  options: WrapOptions = {},
): WrappedShell {
  assertPermissions(permissions, loaded);
  validateWriteGrants(options.writeGrants ?? [], loaded, permissions);
  const host = permissions.execution === "host";
  const profile = host
    ? ""
    : process.platform === "linux"
      ? "(deny default) linux-bwrap"
      : (options.profileText ?? compileProfile(loaded, permissions, options));
  const argv =
    typeof command === "string"
      ? ["/bin/bash", "--noprofile", "--norc", "-c", command]
      : command?.argv;
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw Error("invalid executor argv");
  if (!host && (typeof profile !== "string" || !profile.includes("(deny default)")))
    throw Error("executor requires deny-default profile");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      host
        ? !scrub.test(key) && !["NODE_OPTIONS", "NODE_PATH"].includes(key)
        : !scrubEnvironmentName(key),
    ),
  );
  const configuredPath = loaded.policy?.env?.path;
  env.PATH = configuredPath?.length
    ? configuredPath.join(":")
    : host && process.env.PATH
      ? process.env.PATH
      : `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  if (host && process.env.PI_SUBAGENT === "1") delete env.PI_CODING_AGENT_DIR;
  env.TMPDIR = loaded.tmp.endsWith("/") ? loaded.tmp : `${loaded.tmp}/`;
  env.GOCACHE = path.join(loaded.tmp, "go-cache");
  env.UV_CACHE_DIR = path.join(loaded.tmp, "uv-cache");
  env.npm_config_cache = path.join(loaded.tmp, "npm-cache");
  if (!permissions.write) env.GIT_OPTIONAL_LOCKS = "0";
  Object.assign(env, options.envAssign);
  for (const key of Object.keys(env))
    if (
      host
        ? scrub.test(key) || ["NODE_OPTIONS", "NODE_PATH"].includes(key)
        : scrubEnvironmentName(key)
    )
      delete env[key];
  return {
    profile,
    ...(host ? { execution: "host" as const } : {}),
    argv: [...argv],
    env,
    ...(!host && process.platform === "linux"
      ? { sandboxArgv: linuxSandboxArgv(argv, permissions, loaded) }
      : {}),
  };
}

export async function wrapShellAsync(
  command: string | { argv: string[] },
  permissions: ExecutionPermissions,
  loaded: LoadedPolicy,
  options: WrapOptions = {},
  signal?: AbortSignal,
): Promise<WrappedShell> {
  signal?.throwIfAborted();
  const profileText =
    permissions.execution === "host"
      ? ""
      : (options.profileText ??
        (process.platform === "linux"
          ? undefined
          : await compileProfileAsync(loaded, permissions, options, signal)));
  signal?.throwIfAborted();
  options.assertCurrent?.();
  return wrapShell(command, permissions, loaded, { ...options, profileText });
}

export function shellOperations(
  loaded: LoadedPolicy,
  permissions: ExecutionPermissions,
  options: WrapOptions = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (signal?.aborted) throw Error("aborted");
      if (
        timeout !== undefined &&
        (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_NODE_TIMER_DELAY_MS)
      )
        throw Error(
          `Shell timeout must be a finite positive number no greater than ${MAX_NODE_TIMER_DELAY_MS / 1000} seconds`,
        );
      options.assertCurrent?.();
      const wrapped = await wrapShellAsync(command, permissions, loaded, options, signal);
      const { profile, env } = wrapped;
      const profileDir =
        wrapped.execution === "host"
          ? undefined
          : await mkdtemp(path.join(loaded.tempIsolation?.launchDir ?? loaded.tmp, "profile-"));
      const profilePath = profileDir ? path.join(profileDir, "command.sb") : "";
      try {
        if (profileDir) await writeFile(profilePath, profile, { mode: 0o600 });
        options.assertCurrent?.();
      } catch (error) {
        if (profileDir) await rm(profileDir, { recursive: true, force: true });
        throw error;
      }
      const [executable, ...args] = sandboxCommand(wrapped, profilePath);
      const child = spawn(executable, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      let timedOut = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const signalGroup = (signalName: NodeJS.Signals) => {
        if (child.pid)
          try {
            process.kill(-child.pid, signalName);
          } catch {}
      };
      // A foreground command owns its whole group. Main-process exit ends that capability.
      const exited = () => {
        if (force) clearTimeout(force);
        signalGroup("SIGKILL");
      };
      child.once("exit", exited);
      const stop = () => {
        signalGroup("SIGTERM");
        force ??= setTimeout(() => signalGroup("SIGKILL"), 250);
      };
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stop();
            }, timeout * 1000);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        const [code, killedBy] = await new Promise<[number | null, NodeJS.Signals | null]>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (exitCode, bySignal) => resolve([exitCode, bySignal]));
          },
        );
        if (signal?.aborted) throw Error("aborted");
        if (timedOut) throw Error(`timeout:${timeout}`);
        return { exitCode: code ?? (killedBy ? 128 + (osConstants.signals[killedBy] ?? 0) : 1) };
      } finally {
        if (timer) clearTimeout(timer);
        if (force) clearTimeout(force);
        signalGroup("SIGKILL");
        child.removeListener("exit", exited);
        signal?.removeEventListener("abort", stop);
        if (profileDir) await rm(profileDir, { recursive: true, force: true });
      }
    },
  };
}
