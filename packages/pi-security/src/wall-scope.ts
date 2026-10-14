import type { CallInput, LoadedPolicy } from "./types.ts";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { protectedWritePattern } from "./protected-paths.ts";
async function canonical(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(value)), path.basename(value));
  }
}
const within = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
export async function wallScope(tool: string, input: CallInput, loaded: LoadedPolicy) {
  if (!["read", "write", "edit", "ls", "find", "grep"].includes(tool)) return;
  const target = await canonical(path.resolve(loaded.project, input?.path ?? "."));
  const writing = ["write", "edit"].includes(tool);
  if (
    writing &&
    (!loaded.filesystem.writeAllow.some((root) => within(root, target)) ||
      protectedWritePattern.test(target))
  )
    throw Error("wall path outside permitted write scope");
  if (
    (writing ? loaded.filesystem.writeDeny : loaded.filesystem.readDeny).some((root) =>
      within(root.replace(/\/\*\*$/, ""), target),
    )
  )
    throw Error("wall path denied");
}
