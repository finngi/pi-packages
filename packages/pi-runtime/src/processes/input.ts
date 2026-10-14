import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/** Resolve on pipe acceptance, or reject and release listeners on failure/deadline. */
export function writeToPipe(
  child: ChildProcess,
  input: Writable,
  data: Uint8Array,
  deadlineMs: number,
  onDeadline: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("error", fail);
      child.removeListener("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error) => finish(error);
    const closed = () => finish(new Error("Process closed while writing input"));
    const timer = setTimeout(() => {
      onDeadline();
      input.destroy();
      finish(new Error("Process input write deadline reached"));
    }, deadlineMs);
    input.once("error", fail);
    child.once("close", closed);
    input.write(Buffer.from(data), (error) => finish(error));
  });
}
