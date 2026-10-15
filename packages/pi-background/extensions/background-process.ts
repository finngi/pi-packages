/** Session-owned subprocess transport and Pi completion delivery. */
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { MAX_NODE_TIMER_DELAY_MS } from "pi-runtime/timers";
import { Type } from "typebox";
import { completionContent } from "../lib/background/completion.ts";
import { BackgroundProcesses, outputPreview } from "../lib/background/processes.ts";
import type { ReadResult, Snapshot } from "../lib/background/types.ts";
import { securitySelected, securityService } from "../lib/security-service.ts";
import { SECURITY_PRESENCE } from "pi-contracts";

interface EncodedRead extends Omit<ReadResult, "chunks"> {
  chunks: {
    stream: "stdout" | "stderr";
    start: number;
    end: number;
    data: string;
    encoding: "base64";
  }[];
}

import type {
  BackgroundPolicyUpdate,
  BackgroundService,
  ServiceRequest,
} from "../lib/background/service.ts";

export default function (pi: ExtensionAPI) {
  let processes = new BackgroundProcesses();
  let epoch = 0;
  let closed = false;
  let bashRegistered = false;
  let backgroundToolRegistered = false;
  let admit: BackgroundPolicyUpdate["admit"] | undefined;
  let wakeBudget = 3;
  const securityProviderPresent = () => {
    let active = false;
    pi.events.emit(SECURITY_PRESENCE, {
      respond: (present: boolean) => {
        active ||= present;
      },
    });
    return active;
  };
  const foregroundWaits = new Map<string, () => void>();
  const yieldForegroundWaits = () => {
    for (const yieldWait of foregroundWaits.values()) yieldWait();
  };
  pi.on("input", (event) => {
    if (event.source !== "extension") wakeBudget = 3;
    if (event.source !== "extension" && event.streamingBehavior === "steer") yieldForegroundWaits();
  });
  pi.events.on("background:policy", (value) => {
    const policy = value as BackgroundPolicyUpdate;
    admit = policy.admit;
    policy.pending?.push(processes.cancelWhere(policy.cancel, policy.reason));
  });
  const exit = () => {
    closed = true;
    epoch++;
    processes.killAll();
  };
  pi.on("session_start", async () => {
    epoch++;
    await processes.close();
    processes = new BackgroundProcesses();
    closed = false;
    wakeBudget = 3;
    process.removeListener("exit", exit);
    process.on("exit", exit);
    const activeBeforeRegistration = pi.getActiveTools();
    const providerPresent = securityProviderPresent();
    const activeBash = activeBeforeRegistration.includes("bash");
    // Let Pi apply its native --tools, --exclude-tools, modifiers and defaultTools rules.
    // defaultActive:false preserves a previously selected Bash without activating it in a
    // restricted session; native refresh also handles explicit names and wildcard patterns.
    if (!providerPresent && !bashRegistered) {
      if (securitySelected()) registerRefusingBash();
      else registerHostBash();
    }
    // Keep the process inspector opt-in. In particular, late registration must not widen a
    // child session's private tool list or a user's explicit parent tool selection.
    const backgroundOwnedBySecurity = providerPresent && !securitySelected();
    registerBackgroundProcessTool(
      backgroundOwnedBySecurity,
      activeBash && process.env.PI_SUBAGENT !== "1",
    );
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    epoch++;
    await processes.close();
    process.removeListener("exit", exit);
  });
  function sessionService(): BackgroundService {
    // Bind capabilities to this session generation. Holding a handle cannot operate on a replacement session.
    const sessionEpoch = epoch;
    const manager = processes;
    const assertCurrentSession = () => {
      if (closed || sessionEpoch !== epoch)
        throw new Error("Background process capability belongs to an ended session");
    };
    const service: BackgroundService = {
      launch(spec, options = {}) {
        assertCurrentSession();
        // No default launcher is exposed to the model; trusted clients supply admission/protocol policy.
        admit?.(spec);
        const handle = manager.launch(spec);
        if (options.notify !== false)
          void handle.done
            .then((snapshot) => {
              if (closed || sessionEpoch !== epoch) return;
              if (options.notifyIfCurrent && !options.notifyIfCurrent()) return;
              const read = manager.read(handle.id, 0, 8000);
              const wake = wakeBudget > 0;
              if (wake) wakeBudget--;
              pi.sendMessage(
                {
                  customType: "background-process-result",
                  content: completionContent(snapshot, read),
                  display: true,
                  details: snapshot,
                },
                {
                  deliverAs: wake ? "followUp" : "nextTurn",
                  triggerTurn: wake,
                },
              );
            })
            .catch(() => {
              /* session teardown owns late delivery failures */
            });
        return handle;
      },
      status(id) {
        assertCurrentSession();
        return manager.status(id);
      },
      read(id, cursor, maxBytes) {
        assertCurrentSession();
        return manager.read(id, cursor, maxBytes);
      },
      write(id, data, end) {
        assertCurrentSession();
        return manager.write(id, data, end);
      },
      cancel(id, reason) {
        assertCurrentSession();
        manager.cancel(id, reason);
      },
      async close() {
        if (sessionEpoch !== epoch) return;
        closed = true;
        epoch++;
        await manager.close();
      },
    };
    return service;
  }
  pi.events.on("background:service", (value) => {
    (value as ServiceRequest).respond(sessionService());
  });
  async function runManagedShell(spec: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: unknown;
    signal?: AbortSignal;
    foreground?: boolean;
    timeout?: number;
    mode: "host" | "sandbox";
    label: string;
    onData?: (stream: "stdout" | "stderr", data: Buffer) => void;
    onComplete?: () => Promise<void>;
    requireNoSecurity?: boolean;
  }): Promise<{
    result?: AgentToolResult;
    yielded?: {
      content: { type: "text"; text: string }[];
      details: { id: string; running: true; yielded?: true };
    };
  }> {
    const launchEpoch = epoch;
    const manager = processes;
    const timeout = spec.timeout ?? (spec.input as { timeout?: unknown } | null)?.timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" ||
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout * 1000 > MAX_NODE_TIMER_DELAY_MS)
    )
      throw Error(
        `Shell timeout must be a finite positive number no greater than ${MAX_NODE_TIMER_DELAY_MS / 1000} seconds`,
      );
    if (spec.signal?.aborted) throw Error("aborted");
    if (closed || epoch !== launchEpoch) throw Error("shell launch belongs to an ended session");
    if (spec.requireNoSecurity && (securitySelected() || securityProviderPresent()))
      throw Error("Plain host Bash is unavailable while pi-security is selected or active.");
    let backgrounded = spec.foreground === false;
    const startedAt = Date.now();
    const launched = sessionService().launch(
      {
        command: spec.command,
        args: spec.args,
        env: spec.env,
        cwd: spec.cwd,
        owner: "bash",
        label: spec.label,
        mode: spec.mode,
        stdin: "closed",
        ...(typeof timeout === "number" ? { timeoutMs: timeout * 1000 } : {}),
        ...(spec.onData ? { onData: spec.onData } : {}),
      },
      { notify: true, notifyIfCurrent: () => backgrounded },
    );
    if (spec.onComplete) void launched.done.then(() => spec.onComplete?.()).catch(() => {});
    if (spec.foreground === false)
      return {
        yielded: {
          content: [{ type: "text", text: JSON.stringify({ id: launched.id, running: true }) }],
          details: { id: launched.id, running: true },
        },
      };
    let removeWait: (() => void) | undefined;
    let removeAbort: (() => void) | undefined;
    const yielded = new Promise<"yielded">((resolve) => {
      let settled = false;
      const detach = () => {
        if (settled) return;
        settled = true;
        backgrounded = true;
        foregroundWaits.delete(launched.id);
        removeWait?.();
        removeAbort?.();
        resolve("yielded");
      };
      foregroundWaits.set(launched.id, detach);
      removeWait = () => foregroundWaits.delete(launched.id);
      if (spec.signal) {
        const onAbort = () => detach();
        spec.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => spec.signal?.removeEventListener("abort", onAbort);
        if (spec.signal.aborted) detach();
      }
    });
    const outcome = await Promise.race([
      launched.done.then((snapshot) => ({ kind: "completed" as const, snapshot })),
      yielded.then(() => ({ kind: "yielded" as const })),
    ]);
    const snapshot = outcome.kind === "completed" ? outcome.snapshot : manager.status(launched.id);
    if (outcome.kind === "yielded" && snapshot.status === "running") {
      removeWait?.();
      removeAbort?.();
      return {
        yielded: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: launched.id, running: true, yielded: true }),
            },
          ],
          details: { id: launched.id, running: true, yielded: true },
        },
      };
    }
    removeWait?.();
    removeAbort?.();
    const read = manager.read(launched.id, 0, 4 * 1024 * 1024);
    const output = outputPreview(read);
    const truncated = read.gap || read.nextCursor < snapshot.outputBytes;
    const boundedOutput = truncated
      ? `${output}${output ? "\n" : ""}[Output truncated. Use background_process to read retained output.]`
      : output;
    const exitCode =
      snapshot.exitCode ??
      (snapshot.signal ? 128 + (requireSignalNumber(snapshot.signal) ?? 1) : 1);
    const details = {
      execution: spec.mode,
      output: boundedOutput || "(no output)",
      truncated,
      exit_code: exitCode,
      wall_time_seconds: (Date.now() - startedAt) / 1000,
      ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    };
    const failureDetail = snapshot.reason ? `\n[Process detail: ${snapshot.reason}]` : "";
    return {
      result: {
        content: [
          {
            type: "text",
            text: `${details.output}${exitCode === 0 ? "" : `\n[Command exited with code ${exitCode}]`}${failureDetail}`,
          },
        ],
        details,
        structuredContent: details,
        isError: exitCode !== 0,
      } as AgentToolResult,
    };
  }

  if (securitySelected()) {
    pi.events.on("pi-security:transport:v1", (value) => {
      const request = value as { version: number; respond(service: unknown): void };
      if (request.version !== 1) return;
      request.respond({
        extensionPath: fileURLToPath(import.meta.url),
        async startShell(spec: {
          toolCallId: string;
          input: unknown;
          cwd: string;
          signal?: AbortSignal;
          foreground?: boolean;
        }) {
          const preparationEpoch = epoch;
          const service = securityService(pi.events);
          const { foreground, ...shellSpec } = spec;
          const capability = await service.prepareShell(shellSpec);
          try {
            capability.assertCurrent();
            if (closed || epoch !== preparationEpoch)
              throw Error("shell preparation belongs to an ended session");
            const result = await runManagedShell({
              command: capability.argv[0]!,
              args: capability.argv.slice(1),
              env: capability.env,
              cwd: capability.cwd,
              input: spec.input,
              signal: spec.signal,
              foreground,
              mode: capability.execution ?? "sandbox",
              label: capability.execution === "host" ? "approved host bash" : "sandboxed bash",
              onComplete: () => capability.release(),
            });
            if (result.yielded) return result.yielded;
            return result.result;
          } catch (error) {
            await capability.release();
            throw error;
          }
        },
      });
    });
  }
  function registerRefusingBash() {
    const unavailable = createBashToolDefinition(process.cwd());
    pi.registerTool({
      ...unavailable,
      defaultActive: false,
      async execute() {
        throw new Error("Security is selected, but the secured Bash tool is unavailable.");
      },
    });
    bashRegistered = true;
  }
  function registerHostBash() {
    const cwd = process.cwd();
    const definition = createBashToolDefinition(cwd, {
      operations: {
        async exec(command, shellCwd, options) {
          const { result, yielded } = await runManagedShell({
            command: "/bin/bash",
            args: ["-lc", command],
            cwd: shellCwd,
            env: options.env ?? process.env,
            signal: options.signal,
            timeout: options.timeout,
            mode: "host",
            label: "host bash",
            requireNoSecurity: true,
            onData: (_stream, data) => options.onData(data),
          });
          if (yielded) {
            options.onData(
              Buffer.from(
                `[Process ${yielded.details.id} is continuing in the background. Use background_process to inspect it.]\n`,
              ),
            );
            return { exitCode: 0 };
          }
          const details = result?.structuredContent as { exit_code?: number } | undefined;
          return { exitCode: details?.exit_code ?? 1 };
        },
      },
    });
    pi.registerTool({ ...definition, defaultActive: false });
    bashRegistered = true;
  }
  function registerBackgroundProcessTool(skip: boolean, defaultActive: boolean) {
    // Native refresh applies --tools/--exclude-tools matches after this late registration. Child
    // sessions never gain the parent's default, but may activate it when the native allowlist names it.
    if (skip || backgroundToolRegistered) return;
    pi.registerTool({
      name: "background_process",
      defaultActive,
      promptSnippet: "List, inspect, read or cancel existing background jobs.",
      label: "Background process",
      description:
        "List session jobs, or inspect/read/cancel one by run ID. Launch behavior is supplied by the calling extension. Read uses a byte cursor; gaps explicitly mark output dropped from the bounded buffer. UTF-8 text is a preview of the byte window; exact chunks are base64 in details. Generic shell stdin is closed; only trusted protocol clients can write input.",
      exposure: "direct",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("status"),
          Type.Literal("read"),
          Type.Literal("cancel"),
        ]),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })),
      }),
      async execute(_id, params): Promise<AgentToolResult<Snapshot | EncodedRead | Snapshot[]>> {
        if (closed) throw new Error("Background process session is closed");
        if (params.action === "list") {
          const jobs = processes
            .list()
            .map(({ adapterMetadata: _metadata, ...snapshot }) => snapshot);
          return {
            content: [
              { type: "text", text: jobs.length ? JSON.stringify(jobs) : "No background jobs." },
            ],
            details: jobs,
          };
        }
        if (!params.id) throw new Error("A process ID is required");
        if (params.action === "cancel") processes.cancel(params.id);
        const snapshot = processes.status(params.id);
        // Opaque trusted-client authority stays in the host transport and never enters model-visible output.
        const { adapterMetadata: _adapterMetadata, ...publicSnapshot } = snapshot;
        if (params.action !== "read")
          return {
            content: [{ type: "text", text: JSON.stringify(publicSnapshot) }],
            details: publicSnapshot,
          };
        const output = processes.read(params.id, params.cursor, params.maxBytes);
        return {
          content: [
            {
              type: "text",
              text: `${output.gap ? `[Output gap: retained bytes start at ${output.retainedFrom}]\n` : ""}${outputPreview(output)}\nNext byte cursor: ${output.nextCursor}`,
            },
          ],
          details: {
            ...output,
            chunks: output.chunks.map((chunk) => ({
              ...chunk,
              data: chunk.data.toString("base64"),
              encoding: "base64" as const,
            })),
          },
        };
      },
    });
    backgroundToolRegistered = true;
  }
  pi.registerCommand("jobs", {
    description: "List or inspect session background jobs: list, read ID [CURSOR], cancel ID",
    async handler(args, ctx) {
      if (closed) throw new Error("Background process session is closed");
      const [action = "list", id, cursorText] = args.trim().split(/\s+/);
      if (action === "list") {
        const rows = processes
          .list()
          .map(
            (job) =>
              `${job.id}  ${job.status}  ${job.label}${job.reason ? ` — ${job.reason}` : ""}`,
          );
        ctx.ui.notify(rows.join("\n") || "No background jobs.", "info");
        return;
      }
      if (!id || (action !== "read" && action !== "cancel"))
        throw new Error("Use /jobs list, /jobs read ID [CURSOR], or /jobs cancel ID");
      if (action === "cancel") {
        processes.cancel(id);
        ctx.ui.notify(`Cancelled background process ${id}.`, "info");
        return;
      }
      const cursor = cursorText === undefined ? 0 : Number(cursorText);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid output cursor");
      const read = processes.read(id, cursor);
      ctx.ui.notify(
        `${read.gap ? `[Output gap: retained bytes start at ${read.retainedFrom}]\n` : ""}${outputPreview(read)}\nNext byte cursor: ${read.nextCursor}`,
        "info",
      );
    },
  });
  pi.registerCommand("background", {
    description: "Yield a foreground shell or goal wait while its work continues",
    async handler(args, ctx) {
      if (args.trim()) throw new Error("Use /background without arguments");
      const count = foregroundWaits.size;
      let goalWaitCount = 0;
      pi.events.emit("goal:yield-wait:v1", {
        respond: (found: number) => {
          if (Number.isFinite(found) && found > 0) goalWaitCount = found;
        },
      });
      if (!count) {
        ctx.ui.notify(
          goalWaitCount
            ? `Yielded ${goalWaitCount} goal wait${goalWaitCount === 1 ? "" : "s"} to the conversation.`
            : "No foreground shell command or goal wait is waiting.",
          "info",
        );
        return;
      }
      yieldForegroundWaits();
      ctx.ui.notify(
        `Continued ${count} shell command${count === 1 ? "" : "s"} in the background${
          goalWaitCount
            ? ` and yielded ${goalWaitCount} goal wait${goalWaitCount === 1 ? "" : "s"}`
            : ""
        }.`,
        "info",
      );
    },
  });
}

function requireSignalNumber(signal: NodeJS.Signals): number | undefined {
  return osConstants.signals[signal];
}
