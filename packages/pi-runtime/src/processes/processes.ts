import { type ChildProcess, spawn } from "node:child_process";
import { MAX_NODE_TIMER_DELAY_MS } from "../timers.ts";
import { newSemanticId } from "../semantic-id.ts";

import { writeToPipe } from "./input.ts";
import { OutputBuffer } from "./output-buffer.ts";
import type { LaunchSpec, ProcessLimits, ReadResult, Snapshot, Stream } from "./types.ts";

export { outputPreview } from "./output-buffer.ts";
export type {
  LaunchSpec,
  ProcessLimits,
  ProcessResult,
  ReadResult,
  Snapshot,
  Status,
  Stream,
} from "./types.ts";

interface Job {
  snapshot: Snapshot;
  process: ChildProcess;
  spec: LaunchSpec;
  output: OutputBuffer;
  done: Promise<Snapshot>;
  finish: (value: Snapshot) => void;
  inputPending: number;
  writesPending: number;
  inputClosed: boolean;
  spawned: boolean;
  finalized: boolean;
  timers: Set<NodeJS.Timeout>;
}
/** A session-owned transport. Admission and protocol meaning belong to the trusted caller. */
const MIB = 1024 * 1024;
const MAX_PENDING_WRITES = 128;
const MAX_RESULT_BYTES = 4 * MIB;
// Generous desktop safeguards: at defaults, retained output is at most 512 MiB,
// pending input 320 MiB across four commands and sixteen agents, and answer text 128 MiB.
const DEFAULT_BUFFER_BYTES = 16 * MIB;

export class BackgroundProcesses {
  private jobs = new Map<string, Job>();
  private closed = false;
  readonly limits: Required<ProcessLimits>;
  constructor(limits: ProcessLimits = {}) {
    this.limits = {
      concurrent: 4,
      concurrentAgents: 16,
      retained: 32,
      outputBytes: DEFAULT_BUFFER_BYTES,
      inputBytes: DEFAULT_BUFFER_BYTES,
      killGraceMs: 1000,
      drainMs: 1000,
      writeMs: 30000,
      ...limits,
    };
    for (const name of ["concurrent", "concurrentAgents", "retained"] as const) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1)
        throw new Error(`${name} must be a positive safe integer`);
    }
    for (const name of ["killGraceMs", "drainMs", "writeMs"] as const) {
      const value = this.limits[name];
      if (!Number.isFinite(value) || value < 0 || value > MAX_NODE_TIMER_DELAY_MS)
        throw new Error(`${name} must be between 0 and ${MAX_NODE_TIMER_DELAY_MS} ms`);
    }
    for (const name of ["outputBytes", "inputBytes"] as const) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1)
        throw new Error(`${name} must be a positive safe integer`);
    }
  }
  launch(spec: LaunchSpec): { id: string; done: Promise<Snapshot> } {
    if (this.closed) throw new Error("Background process session is closed");
    const agent = spec.owner === "subagent";
    const limit = agent ? this.limits.concurrentAgents : this.limits.concurrent;
    if (
      [...this.jobs.values()].filter((j) => !j.finalized && (j.spec.owner === "subagent") === agent)
        .length >= limit
    )
      throw new Error(`At most ${limit} ${agent ? "subagents" : "shell commands"} may run at once`);
    if (
      spec.timeoutMs !== undefined &&
      (!Number.isFinite(spec.timeoutMs) ||
        spec.timeoutMs <= 0 ||
        spec.timeoutMs > MAX_NODE_TIMER_DELAY_MS)
    )
      throw new Error(
        `Process timeout must be a finite positive number no greater than ${MAX_NODE_TIMER_DELAY_MS} ms`,
      );
    while (this.jobs.size >= this.limits.retained) {
      const oldest = [...this.jobs].find(([, j]) => j.finalized);
      if (!oldest) throw new Error("Background process retention limit reached");
      this.jobs.delete(oldest[0]);
    }
    spec = { ...spec }; // The job owns callback lifetime independently of the caller.
    const id = newSemanticId("process");
    const proc = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: [spec.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let finish!: (value: Snapshot) => void;
    const done = new Promise<Snapshot>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      snapshot: {
        id,
        owner: spec.owner,
        label: spec.label,
        status: "running",
        exitCode: null,
        signal: null,
        outputBytes: 0,
        retainedFrom: 0,
        executionExited: false,
        streamsClosed: false,
      },
      process: proc,
      spec,
      output: new OutputBuffer(this.limits.outputBytes),
      done,
      finish,
      inputPending: 0,
      writesPending: 0,
      inputClosed: spec.stdin !== "pipe",
      spawned: false,
      finalized: false,
      timers: new Set(),
    };
    this.jobs.set(id, job);
    if (spec.timeoutMs !== undefined)
      this.timer(job, spec.timeoutMs, () => this.cancel(id, "Process timeout"));
    const append = (stream: Stream, data: Buffer) => {
      if (job.finalized) return;
      try {
        spec.onData?.(stream, data);
      } catch (error) {
        spec.onData = undefined;
        this.cancel(id, `Protocol parser failed: ${String(error)}`);
      }
      job.output.append(stream, data);
      job.snapshot.outputBytes = job.output.totalBytes;
      job.snapshot.retainedFrom = job.output.retainedFrom;
    };
    proc.stdout?.on("data", (data) => append("stdout", data));
    proc.stderr?.on("data", (data) => append("stderr", data));
    // Errors on a broken input pipe must never become an unhandled process exception.
    proc.stdin?.on("error", () => {
      job.inputClosed = true;
    });
    proc.on("spawn", () => {
      job.spawned = true;
    });
    proc.on("error", (error) => {
      if (job.finalized) return;
      job.snapshot.reason = String(error);
      job.snapshot.status = "failed";
      // Spawn failures are followed by close. Errors after spawn can also report a failed
      // kill/send; wait briefly for close, then resolve the job as failed without claiming
      // that execution or its streams exited.
      if (job.spawned)
        this.timer(job, this.limits.killGraceMs, () => {
          if (job.finalized) return;
          job.snapshot.reason = `Process error did not produce a close event: ${String(error)}`;
          job.snapshot.status = "failed";
          this.finalize(job);
        });
    });
    proc.on("exit", (code, signal) => {
      job.snapshot.executionExited = true;
      job.snapshot.exitCode = code;
      job.snapshot.signal = signal;
      // A grandchild can keep inherited pipes open after its parent exits.
      this.timer(job, this.limits.drainMs, () => {
        if (job.finalized) return;
        this.kill(job, "SIGKILL");
        job.snapshot.reason ??= "Output drain deadline reached; descendants were stopped";
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        void this.finalize(job);
      });
    });
    proc.on("close", () => {
      // A spawn failure emits `error` and `close` without `exit`. Treat `close`
      // as the terminal confirmation for execution and its stdio streams.
      job.snapshot.executionExited = true;
      job.snapshot.streamsClosed = true;
      void this.finalize(job);
    });
    return { id, done };
  }
  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown background process: ${id}`);
    return job;
  }
  status(id: string): Snapshot {
    return { ...this.get(id).snapshot };
  }
  list(): Snapshot[] {
    return [...this.jobs.values()].map((job) => ({ ...job.snapshot }));
  }
  read(id: string, cursor = 0, maxBytes = Math.min(16384, this.limits.outputBytes)): ReadResult {
    return this.get(id).output.read(cursor, maxBytes);
  }
  /** Trusted clients only. Resolves when accepted by the pipe, not when consumed by the child. */
  async write(id: string, data: Uint8Array, end = false): Promise<void> {
    const job = this.get(id);
    const input = job.process.stdin;
    if (job.finalized || job.snapshot.executionExited || job.inputClosed || !input)
      throw new Error("Process input is closed");
    if (job.inputPending + data.byteLength > this.limits.inputBytes)
      throw new Error("Process input queue limit exceeded");
    if (job.writesPending >= MAX_PENDING_WRITES)
      throw new Error("Too many pending process input writes");
    job.writesPending++;
    job.inputPending += data.byteLength;
    if (end) job.inputClosed = true;
    try {
      await writeToPipe(job.process, input, data, this.limits.writeMs, () => {
        this.cancel(id, "Process input write deadline reached");
      });
      if (end) input.end();
    } finally {
      job.inputPending -= data.byteLength;
      job.writesPending--;
    }
  }
  cancel(id: string, reason = "Cancelled"): void {
    const job = this.get(id);
    if (job.finalized || job.snapshot.status === "cancelled") return;
    job.snapshot.reason = reason;
    job.snapshot.status = "cancelled";
    job.inputClosed = true;
    this.kill(job, "SIGTERM");
    this.timer(job, this.limits.killGraceMs, () => this.kill(job, "SIGKILL"));
  }
  private kill(job: Job, signal: NodeJS.Signals): void {
    if (!job.process.pid) return;
    try {
      process.platform === "win32"
        ? job.process.kill(signal)
        : process.kill(-job.process.pid, signal);
    } catch {
      try {
        job.process.kill(signal);
      } catch {}
    }
  }
  private timer(job: Job, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      job.timers.delete(timer);
      fn();
    }, ms);
    job.timers.add(timer);
  }
  private finalize(job: Job): void {
    if (job.finalized) return;
    job.finalized = true;
    for (const timer of job.timers) clearTimeout(timer);
    job.timers.clear();
    // Even descendants which closed their pipes are session-owned, not daemons.
    this.kill(job, "SIGKILL");
    if (job.snapshot.status === "running")
      job.snapshot.status = job.snapshot.exitCode === 0 ? "completed" : "failed";
    try {
      job.snapshot.result = job.spec.onComplete?.({ ...job.snapshot });
      const result = job.snapshot.result;
      if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Completion parser must return synchronously");
      }
      if (result?.summary && result.summary.length > 1000)
        result.summary = `${result.summary.slice(0, 1000)}[summary truncated]`;
      if (result?.text && Buffer.byteLength(result.text) > MAX_RESULT_BYTES)
        result.text =
          Buffer.from(result.text).subarray(0, MAX_RESULT_BYTES).toString("utf8") +
          `\n[Result truncated after ${MAX_RESULT_BYTES} bytes]`;
    } catch (error) {
      job.snapshot.result = undefined;
      job.snapshot.status = "failed";
      job.snapshot.reason = `Completion parser failed: ${String(error)}`;
    }
    if (job.snapshot.result?.failed && job.snapshot.status === "completed")
      job.snapshot.status = "failed";
    job.spec.onData = undefined;
    job.spec.onComplete = undefined;
    job.finish({ ...job.snapshot });
  }
  ids(): string[] {
    return [...this.jobs.keys()];
  }
  cancelWhere(predicate: (snapshot: Snapshot) => boolean, reason: string): Promise<void> {
    const selected = [...this.jobs.values()].filter(
      (job) => !job.finalized && predicate(job.snapshot),
    );
    for (const job of selected) this.cancel(job.snapshot.id, reason);
    return Promise.allSettled(selected.map((job) => job.done)).then(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.ids()) this.cancel(id, "Session ended");
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
    this.jobs.clear();
  }
  /** Synchronous exit handler: no async cleanup can be relied on during process exit. */
  killAll(): void {
    for (const job of this.jobs.values())
      if (!job.finalized) {
        job.snapshot.status = "cancelled";
        job.snapshot.reason = "Host process exited";
        this.kill(job, "SIGKILL");
        this.finalize(job);
      }
  }
}
