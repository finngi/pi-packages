import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)),
  output = join(root, ".artifacts", "packages");
await mkdir(output, { recursive: true });
const manifests = new Map();
for (const entry of await readdir(join(root, "packages"))) {
  const source = join(root, "packages", entry);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  manifests.set(manifest.name, { source, manifest });
}

// These packages are unreleased. npm's standard bundleDependencies lets one local
// artifact carry its declared workspace helpers without a registry or sibling install.
async function stagePackage(name, stage, ancestors = []) {
  if (ancestors.includes(name))
    throw Error(`Cyclic workspace dependencies: ${[...ancestors, name]}`);
  const { source, manifest: original } = manifests.get(name);
  const manifest = structuredClone(original);
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  if (manifest.pi?.extensions)
    manifest.pi.extensions = manifest.pi.extensions.map((entry) =>
      entry.replace(/^\.\//, "./dist/").replace(/\.ts$/, ".js"),
    );
  if (manifest.bin)
    for (const key of Object.keys(manifest.bin))
      manifest.bin[key] = manifest.bin[key].replace(/^src\//, "dist/src/").replace(/\.ts$/, ".js");
  const compiledExport = (value) => {
    if (typeof value === "string") {
      if (!value.endsWith(".ts") || value.endsWith(".d.ts")) return value;
      const compiled = value.replace(/^\.\/(?:src\/)?/, "./dist/").replace(/\.ts$/, ".js");
      return compiled;
    }
    return Object.fromEntries(
      Object.entries(value).map(([condition, target]) => [
        condition,
        condition === "types" &&
        typeof target === "string" &&
        target.endsWith(".ts") &&
        !target.endsWith(".d.ts")
          ? compiledExport(target).replace(/\.js$/, ".d.ts")
          : compiledExport(target),
      ]),
    );
  };
  if (manifest.exports) manifest.exports = compiledExport(manifest.exports);
  await mkdir(stage, { recursive: true });
  await cp(join(source, "dist"), join(stage, "dist"), { recursive: true });
  if (manifest.pi?.skills?.length)
    await cp(join(source, "skills"), join(stage, "skills"), { recursive: true });
  await cp(join(source, "README.md"), join(stage, "README.md")).catch(() => {});
  for (const filename of await readdir(source))
    if (/^LICENSE/.test(filename) || filename === "PROVENANCE.md")
      await cp(join(source, filename), join(stage, filename));
  const localDependencies = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
    manifests.has(dependency),
  );
  if (localDependencies.length) manifest.bundleDependencies = localDependencies;
  for (const dependency of localDependencies) {
    await stagePackage(dependency, join(stage, "node_modules", dependency), [...ancestors, name]);
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const name of manifests.keys()) {
  // npm needs the canonical macOS temporary path to include bundled dependencies.
  const stage = await realpath(await mkdtemp(join(tmpdir(), "pi-package-")));
  try {
    await stagePackage(name, stage);
    const result = spawnSync(
      "npm",
      ["pack", stage, "--pack-destination", output, "--ignore-scripts", "--json"],
      { encoding: "utf8", cwd: root },
    );
    if (result.status !== 0) throw Error(result.stderr);
    console.log(JSON.parse(result.stdout)[0].filename);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
