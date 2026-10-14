import type {
  GrepToolDetails,
  truncateHead as truncateHeadType,
  truncateLine as truncateLineType,
  formatSize as formatSizeType,
} from "@earendil-works/pi-coding-agent";
import type { HelperCall, HelperRequest, HelperResponse } from "./file-protocol.ts";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { detectSupportedImageMimeTypeFromFile } = (await import(
  pathToFileURL(path.join(sdkRoot, "utils/mime.js")).href
)) as {
  detectSupportedImageMimeTypeFromFile: (
    file: string,
  ) => Promise<"image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined>;
};
const { truncateHead, truncateLine, formatSize, DEFAULT_MAX_BYTES } = (await import(
  pathToFileURL(path.join(sdkRoot, "core/tools/truncate.js")).href
)) as {
  truncateHead: typeof truncateHeadType;
  truncateLine: typeof truncateLineType;
  formatSize: typeof formatSizeType;
  DEFAULT_MAX_BYTES: number;
};
const [rg, fd] = process.argv.slice(2);
const active = new Map<number, AbortController>();
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_ERROR_BYTES = 8 * 1024;
const MAX_CONCURRENT_COMMANDS = 2;
const MAX_QUEUED_COMMANDS = 16;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_LINES = 100;
let runningCommands = 0;
type CommandWaiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
};
const commandWaiters: CommandWaiter[] = [];
const send = (frame: HelperResponse) => process.stdout.write(JSON.stringify(frame) + "\n");
const requestIds = new WeakMap<AbortSignal, number>();
function signalCommand(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group is already gone.
    }
  }
  child.kill(signal);
}
function commandGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function releaseCommandSlot() {
  runningCommands--;
  const waiter = commandWaiters.shift();
  if (!waiter) return;
  waiter.signal.removeEventListener("abort", waiter.abort);
  runningCommands++;
  waiter.resolve(releaseCommandSlot);
}
function acquireCommandSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error("command aborted"));
  if (runningCommands < MAX_CONCURRENT_COMMANDS) {
    runningCommands++;
    return Promise.resolve(releaseCommandSlot);
  }
  if (commandWaiters.length >= MAX_QUEUED_COMMANDS)
    return Promise.reject(new Error("too many searches are queued; retry after one finishes"));
  return new Promise((resolve, reject) => {
    const waiter: CommandWaiter = {
      signal,
      resolve,
      reject,
      abort: () => {
        const index = commandWaiters.indexOf(waiter);
        if (index >= 0) commandWaiters.splice(index, 1);
        reject(new Error("command aborted"));
      },
    };
    commandWaiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}
function command(
  exe: string,
  args: string[],
  signal: AbortSignal,
): Promise<{
  out: string;
  err: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
}> {
  return acquireCommandSlot(signal).then(
    (release) =>
      new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(exe, args, {
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          release();
          reject(error);
          return;
        }
        const output: Buffer[] = [];
        let outputBytes = 0,
          err = "",
          truncated = false,
          spawnError: Error | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        const reportGroup = (state: "started" | "stopped") => {
          const id = requestIds.get(signal);
          if (id !== undefined && child.pid) send({ id, processGroup: { pid: child.pid, state } });
        };
        const stop = () => {
          signalCommand(child, "SIGTERM");
          killTimer ??= setTimeout(() => {
            signalCommand(child, "SIGKILL");
            killTimer = undefined;
            reportGroup("stopped");
          }, 250);
        };
        if (child.pid) reportGroup("started");
        const abort = () => stop();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout!.on("data", (b) => {
          const buffer = Buffer.isBuffer(b) ? b : Buffer.from(b);
          const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
          if (buffer.length > remaining) {
            if (remaining > 0) output.push(buffer.subarray(0, remaining));
            outputBytes += Math.max(remaining, 0);
            truncated = true;
            stop();
          } else {
            output.push(buffer);
            outputBytes += buffer.length;
          }
        });
        child.stderr!.on("data", (b) => {
          err = (err + b.toString()).slice(-MAX_COMMAND_ERROR_BYTES);
        });
        child.once("error", (error) => {
          spawnError = error;
        });
        child.once("close", (code, exitSignal) => {
          signal.removeEventListener("abort", abort);
          release();
          if (child.pid && commandGroupExists(child.pid)) stop();
          else {
            if (killTimer) clearTimeout(killTimer);
            killTimer = undefined;
            reportGroup("stopped");
          }
          if (spawnError) {
            reject(spawnError);
            return;
          }
          resolve({
            out: Buffer.concat(output, outputBytes).toString("utf8"),
            err,
            code,
            signal: exitSignal,
            truncated,
          });
        });
      }),
    (error: Error) => Promise.reject(error),
  );
}
async function execute(...[op, a, signal]: HelperCall) {
  switch (op) {
    case "readFile":
      return (await fs.readFile(a.path)).toString("base64");
    case "access":
      await fs.access(a.path, a.write ? constants.R_OK | constants.W_OK : constants.R_OK);
      return null;
    case "detectImageMimeType":
      return (await detectSupportedImageMimeTypeFromFile(a.path)) ?? null;
    case "writeFile":
      await fs.writeFile(a.path, a.content);
      return null;
    case "mkdir":
      await fs.mkdir(a.path, { recursive: true });
      return null;
    case "exists":
      try {
        await fs.access(a.path);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    case "stat":
      return { isDirectory: (await fs.stat(a.path)).isDirectory() };
    case "readdir":
      return await fs.readdir(a.path);
    case "rename":
      await fs.rename(a.from, a.to);
      return null;
    case "glob": {
      const args = [
        "--glob",
        "--color=never",
        "--hidden",
        "--max-results",
        String(a.options.limit),
      ];
      let insideGit = false;
      for (let p = a.cwd; ; p = path.dirname(p)) {
        try {
          await fs.access(path.join(p, ".git"));
          insideGit = true;
          break;
        } catch {}
        if (path.dirname(p) === p) break;
      }
      if (!insideGit) args.push("--no-require-git");
      for (const ignore of a.options.ignore) args.push("--exclude", ignore);
      let pattern = a.pattern;
      if (pattern.includes("/")) {
        args.push("--full-path");
        if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
          pattern = "**/" + pattern;
      }
      args.push("--", pattern, a.cwd);
      const r = await command(fd, args, signal);
      if (r.truncated) throw Error("fd output limit reached; refine the pattern");
      if (r.code !== 0) throw Error(r.err || `fd exited ${r.code}`);
      return r.out.split("\n").filter(Boolean);
    }
    case "grep": {
      const searchPath = a.path;
      const isDir = (await fs.stat(searchPath)).isDirectory();
      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (a.ignoreCase) args.push("--ignore-case");
      if (a.literal) args.push("--fixed-strings");
      if (a.glob) args.push("--glob", a.glob);
      args.push("--", a.pattern, searchPath);
      const r = await command(rg, args, signal);
      const stoppedAtOutputLimit = r.truncated && r.code === null && r.signal === "SIGTERM";
      if (r.code !== 0 && r.code !== 1 && !stoppedAtOutputLimit)
        throw Error(r.err || `rg exited ${r.code ?? r.signal ?? "unknown"}`);
      if (stoppedAtOutputLimit && r.err) throw Error(r.err);
      const limit = Math.max(1, a.limit ?? 100),
        requestedContext = a.context ?? 0;
      if (!Number.isFinite(requestedContext)) throw Error("grep context must be a finite number");
      const context = Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(requestedContext))),
        contextCapped = requestedContext > MAX_CONTEXT_LINES;
      const lastCompleteLine = r.out.lastIndexOf("\n");
      const completeOutput =
        r.truncated && lastCompleteLine >= 0
          ? r.out.slice(0, lastCompleteLine)
          : r.truncated
            ? ""
            : r.out;
      const matches = [];
      let matchLimitReached = false;
      for (const line of completeOutput.split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type !== "match") continue;
        if (matches.length >= limit) {
          matchLimitReached = true;
          break;
        }
        matches.push(event);
      }
      if (!matches.length)
        return {
          content: [
            {
              type: "text" as const,
              text: r.truncated
                ? "Search output limit reached; refine the pattern"
                : "No matches found",
            },
          ],
        };
      const output = [];
      let linesTruncated = false,
        contextOmitted = false,
        contextBytesRead = 0;
      const contextCache = new Map<string, string | null>();
      async function contextLines(file: string, lineNumber: number): Promise<[number, string][]> {
        if (context <= 0) return [];
        let text = contextCache.get(file);
        if (text === undefined) {
          const remaining = MAX_CONTEXT_SEARCH_BYTES - contextBytesRead;
          if (remaining <= 0) {
            contextOmitted = true;
            contextCache.set(file, null);
            return [];
          }
          const budget = Math.min(MAX_CONTEXT_FILE_BYTES, remaining);
          let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            handle = await fs.open(file, "r");
            const info = await handle.stat();
            if (!info.isFile() || info.size > budget) {
              contextOmitted = true;
              contextCache.set(file, null);
              return [];
            }
            const buffer = Buffer.allocUnsafe(budget + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              const result = await handle.read(
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead,
              );
              if (result.bytesRead === 0) break;
              bytesRead += result.bytesRead;
            }
            if (bytesRead > budget) {
              contextOmitted = true;
              contextCache.set(file, null);
              return [];
            }
            contextBytesRead += bytesRead;
            text = buffer
              .subarray(0, bytesRead)
              .toString("utf8")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            contextCache.set(file, text);
          } catch {
            contextOmitted = true;
            contextCache.set(file, null);
            return [];
          } finally {
            await handle?.close();
          }
        }
        if (text === null) return [];
        const firstLine = Math.max(1, lineNumber - context),
          lastLine = lineNumber + context,
          selected: [number, string][] = [];
        let currentLine = 1,
          start = 0;
        for (let index = 0; index <= text.length; index++) {
          if (index !== text.length && text[index] !== "\n") continue;
          if (currentLine >= firstLine && currentLine <= lastLine)
            selected.push([currentLine, text.slice(start, index)]);
          if (currentLine >= lastLine) break;
          currentLine++;
          start = index + 1;
        }
        return selected;
      }
      for (const e of matches) {
        const file = e.data.path.text,
          n = e.data.line_number,
          label = isDir ? path.relative(searchPath, file) : path.basename(file);
        const selected = await contextLines(file, n);
        const rows = selected.length
          ? selected
          : [
              [
                n,
                e.data.lines.text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, ""),
              ] as [number, string],
            ];
        for (const [i, text] of rows) {
          const truncated = truncateLine(text);
          linesTruncated ||= truncated.wasTruncated;
          output.push(
            i === n ? `${label}:${i}: ${truncated.text}` : `${label}-${i}- ${truncated.text}`,
          );
        }
      }
      const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let text = truncation.content;
      const details: GrepToolDetails = {},
        notices = [];
      if (matchLimitReached) {
        details.matchLimitReached = limit;
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (linesTruncated) {
        details.linesTruncated = true;
        notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
      }
      if (r.truncated) notices.push("Search output limit reached; refine the pattern");
      if (contextOmitted)
        notices.push(
          "Context omitted for files exceeding the 256 KiB per-file or 8 MiB search budget",
        );
      if (contextCapped) notices.push(`Context capped at ${MAX_CONTEXT_LINES} lines per match`);
      if (notices.length) text += `\n\n[${notices.join(". ")}]`;
      return {
        content: [{ type: "text" as const, text }],
        ...(Object.keys(details).length ? { details } : {}),
      };
    }
    default:
      throw Error(`unknown helper op ${op}`);
  }
}
let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  let i: number;
  while ((i = pending.indexOf(10)) >= 0) {
    const bytes = pending.subarray(0, i);
    pending = pending.subarray(i + 1);
    let frame: HelperRequest;
    try {
      frame = JSON.parse(bytes.toString("utf8"));
    } catch {
      process.exit(2);
    }
    if (frame.cancel) {
      active.get(frame.id)?.abort();
      continue;
    }
    const controller = new AbortController();
    active.set(frame.id, controller);
    requestIds.set(controller.signal, frame.id);
    execute(...([frame.op, frame.args, controller.signal] as HelperCall))
      .then(
        (result) => send({ id: frame.id, result }),
        (e) =>
          send({
            id: frame.id,
            error: {
              message: e.message,
              code: (e as NodeJS.ErrnoException).code,
              errno: e.errno,
              syscall: e.syscall,
              path: e.path,
            },
          }),
      )
      .finally(() => active.delete(frame.id));
  }
});
process.stdin.on("end", () => {
  for (const c of active.values()) c.abort();
});
send({ ready: true });
