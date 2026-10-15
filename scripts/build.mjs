import { readdir, mkdir, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = [
  "pi-contracts",
  "pi-resource-browser",
  "pi-runtime",
  "pi-background",
  "pi-permissions",
  "pi-resources",
  "pi-delegation",
  "pi-goal",
  "pi-context",
  "pi-codex-search",
];
async function assets(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name),
      target = join(output, entry.name);
    if (entry.isDirectory()) await assets(source, target);
    else if (!entry.name.endsWith(".ts")) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}
const selected = process.argv[2] === "--package" ? process.argv[3] : undefined;
if (selected && !packages.includes(selected)) throw Error("Unknown package");
for (const name of selected ? [selected] : packages) {
  const directory = join(root, "packages", name);
  const library = ["pi-contracts", "pi-runtime", "pi-resource-browser"].includes(name);
  await rm(join(directory, "dist"), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(directory, "tsconfig.build.json")],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const entries = await readdir(directory);
  for (const subdir of library ? [] : ["extensions", "lib"])
    if (entries.includes(subdir))
      await assets(join(directory, subdir), join(directory, "dist", subdir));
}
