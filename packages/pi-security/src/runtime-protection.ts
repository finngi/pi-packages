import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFilesystem } from "./policy.ts";
import type { LoadedPolicy } from "./types.ts";

async function packageRoot(entry: string): Promise<string> {
  let directory = dirname(await realpath(entry));
  for (;;) {
    if (await stat(join(directory, "package.json")).catch(() => undefined)) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw Error("Runtime package manifest unavailable");
    directory = parent;
  }
}

export async function protectRuntime(loaded: LoadedPolicy, entry: string): Promise<void> {
  const security = await packageRoot(entry),
    roots = [security];
  for (const name of ["pi-runtime", "pi-contracts"])
    roots.push(await packageRoot(fileURLToPath(import.meta.resolve(name))));
  for (const name of [
    "pi-bg",
    "pi-subagents",
    "pi-goal",
    "pi-local-context",
    "pi-codex-search",
    "pi-resource-browser",
  ]) {
    const sibling = join(dirname(security), name);
    if ((await stat(sibling).catch(() => undefined))?.isDirectory())
      roots.push(await realpath(sibling));
  }
  for (const root of roots)
    if (!loaded.filesystem.writeDeny.includes(root)) loaded.filesystem.writeDeny.push(root);
  materializeFilesystem(loaded.policy, loaded.filesystem);
}
