import { mkdir, mkdtemp, readFile, writeFile, cp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url)),
  output = join(root, ".artifacts", "packages");
await mkdir(output, { recursive: true });
const names = [
  "pi-contracts",
  "pi-runtime",
  "pi-resource-browser",
  "pi-security",
  "pi-permissions",
  "pi-bg",
  "pi-subagents",
  "pi-goal",
  "pi-local-context",
  "pi-codex-search",
];
for (const name of names) {
  const stage = await mkdtemp(join(tmpdir(), "pi-package-"));
  try {
    const source = join(root, "packages", name),
      manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    delete manifest.private;
    delete manifest.scripts;
    delete manifest.devDependencies;
    if (manifest.pi)
      manifest.pi.extensions = manifest.pi.extensions.map((entry) =>
        entry.replace(/^\.\//, "./dist/").replace(/\.ts$/, ".js"),
      );
    if (manifest.bin)
      for (const key of Object.keys(manifest.bin))
        manifest.bin[key] = manifest.bin[key]
          .replace(/^src\//, "dist/src/")
          .replace(/\.ts$/, ".js");
    if (["pi-contracts", "pi-runtime"].includes(name))
      for (const key of Object.keys(manifest.exports)) {
        const base = key === "." ? "index" : key.slice(2);
        manifest.exports[key] = { types: `./dist/${base}.d.ts`, default: `./dist/${base}.js` };
      }
    if (name === "pi-security")
      manifest.exports["./permissions"] = {
        types: "./dist/src/permission-extension.d.ts",
        default: "./dist/src/permission-extension.js",
      };
    await cp(join(source, "dist"), join(stage, "dist"), { recursive: true });
    if (manifest.pi?.skills?.length)
      await cp(join(source, "skills"), join(stage, "skills"), { recursive: true });
    await cp(join(source, "README.md"), join(stage, "README.md")).catch(() => {});
    for (const filename of await readdir(source))
      if (/^LICENSE/.test(filename) || filename === "PROVENANCE.md")
        await cp(join(source, filename), join(stage, filename));
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
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
