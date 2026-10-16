import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { responsesFixture } from "../packages/pi-codex-search/tests/fixtures/responses-sse.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseScope = process.env.PI_PACKAGE_SCOPE;
const stockPeers = [
  "@earendil-works/pi-coding-agent@1.2.0",
  "@earendil-works/pi-ai@1.2.0",
  "@earendil-works/pi-tui@1.2.0",
  "@earendil-works/pi-mcp@1.2.0",
];
before(() => {
  for (const script of ["build.mjs", "pack.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "scripts", script),
        ...(script === "pack.mjs" && releaseScope ? ["--scope", releaseScope] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test("each artifact installs alone and its public API works on stock Pi", {
  timeout: 300000,
}, async (t) => {
  const artifactNames = [
    "pi-background",
    "pi-delegation",
    "pi-resources",
    "pi-goal",
    "pi-context",
    "pi-codex-search",
    "pi-permissions",
    "pi-contracts",
    "pi-runtime",
    "pi-resource-browser",
  ];
  for (const name of artifactNames.filter(
    (entry) =>
      !releaseScope || !["pi-contracts", "pi-runtime", "pi-resource-browser"].includes(entry),
  ))
    await t.test(name, { timeout: 60000 }, async () => {
      const installedName = releaseScope ? `@${releaseScope}/${name}` : name;
      const filename = releaseScope
        ? `${releaseScope}-${name}-0.1.0-alpha.0.tgz`
        : `${name}-0.1.0.tgz`;
      const directory = await mkdtemp(join(tmpdir(), `pi-independent-${name}-`));
      try {
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ private: true, type: "module" }),
        );
        // The only repository artifact supplied to npm is the extension under test.
        // Host peers are stock Pi packages, pinned to the SDK this repository tests.
        const install = spawnSync(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...stockPeers,
            `typebox@${JSON.parse(await readFile(join(root, "node_modules/typebox/package.json"), "utf8")).version}`,
            join(root, ".artifacts/packages", filename),
          ],
          { cwd: directory, encoding: "utf8", timeout: 45000 },
        );
        assert.equal(install.status, 0, install.stdout + install.stderr);
        const consumer = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        assert.deepEqual(
          Object.keys(consumer.dependencies).filter(
            (dependency) =>
              dependency.startsWith("pi-") || dependency.startsWith("@" + releaseScope + "/"),
          ),
          [installedName],
        );
        for (const sibling of artifactNames.filter((entry) => entry !== name || releaseScope))
          await assert.rejects(readFile(join(directory, "node_modules", sibling, "package.json")), {
            code: "ENOENT",
          });
        if (releaseScope) {
          const manifest = JSON.parse(
            await readFile(join(directory, "node_modules", installedName, "package.json"), "utf8"),
          );
          assert.deepEqual(manifest.keywords, ["pi-package"]);
          assert.equal(manifest.publishConfig.tag, "alpha");
          assert.deepEqual(manifest.bundleDependencies, [name]);
        }
        const script = join(directory, "independent-package-packed.mjs");
        await writeFile(script, await readFile(join(root, "tests/independent-package-packed.mjs")));
        await writeFile(join(directory, "responses-sse.txt"), responsesFixture);
        const check = spawnSync(process.execPath, [script, directory, name, installedName], {
          cwd: directory,
          encoding: "utf8",
          timeout: 30000,
        });
        assert.equal(check.status, 0, check.stdout + check.stderr);
        assert.match(check.stdout, /stock-Pi behaviour passed/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
});

test("combined packed extensions preserve session setup and compiled child tooling", {
  timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pack-consumer-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const names = [
      "pi-contracts",
      "pi-runtime",
      "pi-resource-browser",
      "pi-permissions",
      "pi-background",
      "pi-delegation",
      "pi-resources",
      "pi-goal",
      "pi-context",
      "pi-codex-search",
    ];
    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        ...names.map((name) => join(root, ".artifacts/packages", `${name}-0.1.0.tgz`)),
        "@earendil-works/pi-coding-agent@1.2.0",
        "@earendil-works/pi-ai@1.2.0",
        "@earendil-works/pi-tui@1.2.0",
        "@earendil-works/pi-mcp@1.2.0",
        `typebox@${JSON.parse(await readFile(join(root, "node_modules/typebox/package.json"), "utf8")).version}`,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr);
    for (const name of names) {
      const manifest = JSON.parse(
        await readFile(join(directory, "node_modules", name, "package.json"), "utf8"),
      );
      assert.equal(manifest.name, name);
      assert(!manifest.private);
      assert.equal(manifest.license, "MIT");
      assert.match(
        await readFile(join(directory, "node_modules", name, "LICENSE"), "utf8"),
        /MIT License/,
      );
      assert.equal(manifest.repository.directory, `packages/${name}`);
      const entry = manifest.pi?.extensions?.[0] ?? manifest.exports["."].default;
      assert.match(entry, /\.js$/);
      const check = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(resolve(directory, "node_modules", name, entry))});`,
        ],
        { cwd: directory, encoding: "utf8" },
      );
      assert.equal(check.status, 0, `${name}: ${check.stderr}`);
      if (manifest.pi?.extensions?.length) {
        const nativeCheck = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
                import assert from "node:assert/strict";
                import {mkdtemp,rm} from "node:fs/promises";
                import {tmpdir} from "node:os";
                import {join} from "node:path";
                import {DefaultResourceLoader,SettingsManager} from "@earendil-works/pi-coding-agent";
                const root=await mkdtemp(join(tmpdir(),"pi-packed-native-"));
                process.env.PI_CODING_AGENT_DIR=root;
                process.env.PI_OFFLINE="1";
                try {
                  const settings=SettingsManager.inMemory({packages:[${JSON.stringify(join(directory, "node_modules", name))}]});
                  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});
                  await loader.reload();
                  assert.deepEqual(loader.getExtensions().errors,[]);
                  assert.equal(loader.getExtensions().extensions.length,${manifest.pi.extensions.length},"only selected extension package activates");
                } finally {await rm(root,{recursive:true,force:true});}
              `,
          ],
          { cwd: directory, encoding: "utf8" },
        );
        assert.equal(nativeCheck.status, 0, `${name} native package: ${nativeCheck.stderr}`);
      }
    }
    const packRoot = join(directory, "packs", "fixture");
    await mkdir(join(packRoot, "skills", "pack-proof"), { recursive: true });
    await writeFile(
      join(packRoot, "package.json"),
      JSON.stringify({
        version: "0.1.0",
        pi: { extensions: [], skills: ["skills"] },
        name: "fixture",
        keywords: ["bm25"],
      }),
    );
    await writeFile(
      join(packRoot, "skills/pack-proof/SKILL.md"),
      "---\nname: pack-proof\ndescription: Verify installed resource data.\n---\nLAZY_BODY",
    );
    const bridgeCheck = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import {discoverResourcePackages, resourcePackageKeywords} from "pi-resources/discovery";
        import {loadSkills,SettingsManager} from "@earendil-works/pi-coding-agent";
        const found=await discoverResourcePackages(SettingsManager.inMemory({packages:[${JSON.stringify(packRoot)}]}),process.cwd(),process.cwd());
        assert.deepEqual(found.problems,[]);assert.equal(found.packs.length,1);
        assert.match(resourcePackageKeywords(found.packs[0]),/bm25/);
        const native=loadSkills({cwd:process.cwd(),agentDir:process.cwd(),includeDefaults:false,skillPaths:found.packs[0].skills});
        assert.deepEqual(native.skills.map(s=>s.name),["pack-proof"]);
      `,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(bridgeCheck.status, 0, bridgeCheck.stderr);
    const setupScript = join(directory, "session-setup-smoke.mjs");
    await writeFile(setupScript, await readFile(join(root, "tests/session-setup-packed.mjs")));
    const setupCheck = spawnSync(process.execPath, [setupScript, directory], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(setupCheck.status, 0, setupCheck.stdout + setupCheck.stderr);
    const skillScript = join(directory, "node_modules/pi-context/skills/pi-help/scripts/paths.mjs");
    const skillCheck = spawnSync(process.execPath, [skillScript], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(skillCheck.status, 0, skillCheck.stderr);
    const helpPaths = JSON.parse(skillCheck.stdout);
    assert.match(helpPaths.docs, /node_modules\/@earendil-works\/pi-coding-agent\/docs$/);
    const helpManifest = JSON.parse(
      await readFile(join(directory, "node_modules/pi-context/package.json"), "utf8"),
    );
    assert.deepEqual(helpManifest.pi.skills, ["./skills"]);
    const skill = await readFile(
      join(directory, "node_modules/pi-context/skills/pi-help/SKILL.md"),
      "utf8",
    );
    assert.match(skill, /name: pi-help/);
    const subprocessEnv = { ...process.env };
    delete subprocessEnv.NODE_TEST_CONTEXT;
    const childTools = spawnSync(
      process.execPath,
      [
        "--test",
        join(root, "packages/pi-delegation/lib/subagent/native-package-tools-stock.test.ts"),
        join(root, "packages/pi-delegation/lib/subagent/native-permissions-stock.test.ts"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30000,
        env: { ...subprocessEnv, PI_CHILD_PACKAGED_ROOT: join(directory, "node_modules") },
      },
    );
    assert.equal(childTools.status, 0, childTools.stdout + childTools.stderr);
    assert.match(childTools.stdout, /pass 4/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
