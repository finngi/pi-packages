import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { Decision, WrappedShell } from "./types.ts";
interface StartOptions {
  command: string;
  cwd: string;
  decision: Decision;
  signal?: AbortSignal;
  timeout?: number;
}
interface JobResult {
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
interface Job {
  id: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  state: "running" | "done";
  settled: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  escalationTimer?: NodeJS.Timeout;
  done?: Promise<JobResult>;
}
interface BackgroundOptions {
  prepare: (spec: Pick<StartOptions, "command" | "decision" | "signal">) => Promise<
    WrappedShell & {
      profileRoot?: string;
      assertCurrent?: () => void;
      release?: () => void | Promise<void>;
    }
  >;
  /** Internal test seam for exercising the job lifecycle without a platform sandbox. */
  spawnProcess?: typeof spawn;
}
import { spawn } from "node:child_process";
import { MAX_NODE_TIMER_DELAY_MS, newSemanticId } from "pi-runtime";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { sandboxCommand } from "./linux-executor.ts";

const OUTPUT_LIMIT = 256 * 1024;
const CANCEL_WAIT_MS = 1_000;
const SHUTDOWN_WAIT_MS = 1_000;
const appendStderr = (job: Job, text: string) => {
  job.stderr = (job.stderr + text).slice(-OUTPUT_LIMIT);
};
const MAX_CONCURRENT_JOBS = 4;
const MAX_RETAINED_JOBS = 32;
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function createBackgroundJobs({ prepare, spawnProcess = spawn }: BackgroundOptions) {
  const jobs = new Map<string, Job>();
  const starting = new Set<Promise<{ id: string; done: Promise<JobResult> }>>();
  // Reservations cover async preparation and profile setup before a process is
  // inserted into jobs. They prevent concurrent starts from bypassing either cap.
  const reservations = new Map<symbol, string | undefined>();
  const reservedEvictions = new Set<string>();
  let closed = false;
  const lookup = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw Error("unknown background job");
    return job;
  };
  const kill = (job: Job, signal: NodeJS.Signals = "SIGTERM") => {
    if (job.child?.pid)
      try {
        process.kill(-job.child.pid, signal);
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        if (error.code !== "ESRCH")
          appendStderr(
            job,
            `\nprocess cleanup could not send ${signal}: ${error.code ?? error.message}`,
          );
      }
  };
  const clearEscalation = (job: Job) => {
    if (job.escalationTimer) clearTimeout(job.escalationTimer);
    job.escalationTimer = undefined;
  };
  const stopAndEscalate = (job: Job) => {
    kill(job);
    if (job.escalationTimer) return;
    job.escalationTimer = setTimeout(() => {
      job.escalationTimer = undefined;
      if (job.state === "running") kill(job, "SIGKILL");
    }, 200);
    job.escalationTimer.unref();
  };
  async function start(options: StartOptions) {
    if (closed) throw Error("background jobs closed");
    if (options.decision?.verdict !== "allow") throw Error("background requires allowed binding");
    if (options.signal?.aborted) throw Error("aborted");
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout * 1000 > MAX_NODE_TIMER_DELAY_MS)
    )
      throw Error(
        `Process timeout must be a finite positive number no greater than ${MAX_NODE_TIMER_DELAY_MS / 1000} seconds`,
      );
    const active =
      reservations.size + [...jobs.values()].filter((job) => job.state === "running").length;
    if (active >= MAX_CONCURRENT_JOBS)
      throw Error(`At most ${MAX_CONCURRENT_JOBS} background processes may run at once`);
    let evictId: string | undefined;
    if (jobs.size + reservations.size - reservedEvictions.size >= MAX_RETAINED_JOBS) {
      const oldestCompleted = [...jobs].find(
        ([id, job]) => job.state === "done" && !reservedEvictions.has(id),
      );
      if (!oldestCompleted) {
        throw Error(`Background process history is full (${MAX_RETAINED_JOBS} entries)`);
      }
      evictId = oldestCompleted[0];
    }
    const reservation = Symbol("background-start");
    reservations.set(reservation, evictId);
    if (evictId) reservedEvictions.add(evictId);
    const pending = runStart(options, () => {
      if (evictId) {
        jobs.delete(evictId);
        reservedEvictions.delete(evictId);
      }
      reservations.delete(reservation);
    });
    starting.add(pending);
    try {
      return await pending;
    } finally {
      reservations.delete(reservation);
      if (evictId) reservedEvictions.delete(evictId);
      starting.delete(pending);
    }
  }
  async function runStart(
    { command, cwd, decision, signal, timeout }: StartOptions,
    releaseReservation: () => void,
  ) {
    const prepared = await prepare({ command, decision, signal });
    let dir: string | undefined;
    try {
      if (closed || signal?.aborted) throw Error("aborted");
      if (
        (prepared.execution !== "host" && !prepared.profile?.includes("(deny default)")) ||
        !Array.isArray(prepared.argv) ||
        !prepared.argv.length ||
        !path.isAbsolute(prepared.env?.TMPDIR ?? "")
      )
        throw Error("invalid prepared background executor");
      if (prepared.execution !== "host")
        dir = await mkdtemp(path.join(prepared.profileRoot ?? prepared.env.TMPDIR!, "background-"));
      const file = dir ? path.join(dir, "command.sb") : "";
      if (dir) await writeFile(file, prepared.profile, { mode: 0o600 });
      if (closed || signal?.aborted) throw Error("aborted");
      prepared.assertCurrent?.();
      const [executable, ...args] = sandboxCommand(prepared, file);
      const child = spawnProcess(executable, args, {
        cwd,
        env: prepared.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const id = newSemanticId("process"),
        job: Job = {
          id,
          child,
          state: "running",
          settled: false,
          stdout: "",
          stderr: "",
          exitCode: null,
        };
      jobs.set(id, job);
      releaseReservation();
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              stopAndEscalate(job);
            }, timeout * 1000);
      for (const key of ["stdout", "stderr"] as const)
        child[key].on("data", (data) => {
          job[key] = (job[key] + data.toString()).slice(-OUTPUT_LIMIT);
        });
      job.done = new Promise<void>((resolve) => {
        let error: Error | undefined;
        child.once("error", (e) => {
          error = e;
        });
        child.once("close", (code, bySignal) => {
          if (timer) clearTimeout(timer);
          clearEscalation(job);
          job.exitCode = code ?? 1;
          job.state = "done";
          if (error) job.stderr += error.message;
          if (bySignal) job.signal = bySignal;
          resolve();
        });
      })
        .then(async () => {
          // A shell may have exited while leaving descendants in its owned process group.
          kill(job, "SIGKILL");
          await prepared.release?.();
          if (dir) await rm(dir, { recursive: true, force: true });
          return { id, exitCode: job.exitCode, stdout: job.stdout, stderr: job.stderr };
        })
        .finally(() => {
          job.settled = true;
        });
      return { id, done: job.done! };
    } catch (error) {
      await prepared.release?.();
      if (dir) await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    start,
    list() {
      return [...jobs.keys()].map((id) => {
        const { state, exitCode, signal } = lookup(id);
        return { id, state, exitCode, ...(signal ? { signal } : {}) };
      });
    },
    status(id: string) {
      const { state, exitCode, signal } = lookup(id);
      return { id, state, exitCode, ...(signal ? { signal } : {}) };
    },
    read(id: string) {
      const { stdout, stderr } = lookup(id);
      return { id, stdout, stderr };
    },
    async cancel(id: string) {
      const job = lookup(id);
      if (job.state === "running") {
        stopAndEscalate(job);
      }
      const result = job.done ? await withTimeout(job.done, CANCEL_WAIT_MS) : undefined;
      if (!result)
        throw Error(
          job.state === "running"
            ? `Background process ${id} is still running after cancellation; its sandbox and resources remain active. Inspect its status or output, then retry cancellation.`
            : `Background process ${id} stopped, but its cleanup is still pending; its sandbox resources remain active.`,
        );
      return result;
    },
    async close() {
      closed = true;
      const pendingStarts = [...starting];
      const pending = [...jobs.values()].filter((job) => !job.settled);
      for (const job of pending) if (job.state === "running") stopAndEscalate(job);
      await withTimeout(
        Promise.allSettled([...pendingStarts, ...pending.map((job) => job.done!)]),
        SHUTDOWN_WAIT_MS,
      );
      return {
        activeJobs: pending.filter((job) => !job.settled).map((job) => job.id),
        pendingStarts: starting.size,
      };
    },
    async whenIdle() {
      await Promise.allSettled([...starting]);
      await Promise.allSettled([...jobs.values()].map((job) => job.done).filter(Boolean));
    },
  };
}
