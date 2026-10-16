import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { scope: { type: "string" } } });
const scope = values.scope;
if (scope && !/^[a-z0-9][a-z0-9-]*$/.test(scope)) throw Error("Invalid npm scope");

const root = fileURLToPath(new URL("../", import.meta.url));
const release = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (
  scope &&
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.test(release.version)
)
  throw Error("Public alpha builds require a root version such as 0.1.0-alpha.1");
const output = join(root, ".artifacts", scope ? "public-packages" : "packages");
// Keep previous versions and unscoped development artifacts out of a public release batch.
if (scope) await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const manifests = new Map();
for (const entry of await readdir(join(root, "packages"))) {
  const source = join(root, "packages", entry);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  manifests.set(manifest.name, { source, manifest });
}

// npm's standard bundleDependencies lets each artifact carry its workspace helpers
// without publishing those helpers or requiring a sibling install.
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
  const { manifest: original } = manifests.get(name);
  // Gallery entries are capabilities, not the libraries they carry.
  if (scope && !original.pi?.extensions?.length) continue;
  // npm needs the canonical macOS temporary path to include bundled dependencies.
  const stage = await realpath(await mkdtemp(join(tmpdir(), "pi-package-")));
  try {
    if (!scope) await stagePackage(name, stage);
    else {
      // A native wrapper keeps workspace import identities intact, including self-imports.
      // npm bundles the complete existing package; no helper needs a registry release.
      const dependency = join(stage, "node_modules", name);
      await stagePackage(name, dependency);
      const packed = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
      const version = release.version;
      const manifest = {
        name: `@${scope}/${name}`,
        version,
        description: original.description,
        license: original.license,
        repository: original.repository,
        bugs: original.bugs,
        engines: original.engines,
        keywords: ["pi-package"],
        publishConfig: { access: "public", tag: "alpha" },
        peerDependencies: original.peerDependencies,
        dependencies: { [name]: original.version },
        bundleDependencies: [name],
        pi: Object.fromEntries(
          Object.entries(packed.pi).map(([kind, paths]) => [
            kind,
            paths.map((path) => `./node_modules/${name}/${path.replace(/^\.\//, "")}`),
          ]),
        ),
      };
      await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      const repository = original.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
      const readme = (await readFile(join(dependency, "README.md"), "utf8")).replace(
        /\]\((?![a-z][a-z0-9+.-]*:|#)([^\s)]+)\)/gi,
        (_match, target) => {
          const url = new URL(target, `${repository}/blob/main/packages/${name}/`);
          return `](${url.href})`;
        },
      );
      await writeFile(
        join(stage, "README.md"),
        `# @${scope}/${name}\n\nExperimental alpha; tested with Node 24 and stock Pi 1.2.0.\n\n` +
          `\`pi install npm:@${scope}/${name}@${version}\`\n\n` +
          `This download includes its workspace dependencies. No sibling packages are required.\n\n` +
          readme.replace(/^# [^\n]+\n/, ""),
      );
      for (const filename of await readdir(dependency))
        if (/^LICENSE/.test(filename)) await cp(join(dependency, filename), join(stage, filename));
    }
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
