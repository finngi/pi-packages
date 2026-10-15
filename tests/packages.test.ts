import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
test(
  "packed packages load independently and compiled helpers run from node_modules",
  { timeout: 180000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pack-consumer-"));
    try {
      const build = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stdout + build.stderr);
      const pack = spawnSync(process.execPath, [join(root, "scripts/pack.mjs")], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(pack.status, 0, pack.stderr);
      const reviewedLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
      const overrides = Object.fromEntries(
        Object.entries(reviewedLock.packages)
          .filter(
            ([name, value]) =>
              name.startsWith("node_modules/@earendil-works/") &&
              !name.slice("node_modules/".length).includes("/node_modules/") &&
              (value as { version?: string }).version,
          )
          .map(([name, value]) => [
            name.slice("node_modules/".length),
            (value as { version: string }).version,
          ]),
      );
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ private: true, type: "module", overrides }),
      );
      const names = [
        "pi-contracts",
        "pi-runtime",
        "pi-resource-browser",
        "pi-security",
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
        import {discoverResourcePackages, resourcePackageKeywords} from "pi-runtime";
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
      const skillScript = join(
        directory,
        "node_modules/pi-context/skills/pi-help/scripts/paths.mjs",
      );
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
      const helper = join(directory, "node_modules/pi-security/dist/src/file-helper.js");
      const run = spawnSync(process.execPath, [helper, "rg", "fd"], {
        cwd: directory,
        input: "",
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /"ready"/);
      const codemode = spawnSync(
        process.execPath,
        ["--test", join(root, "packages/pi-security/test/mcp/codemode-stock.test.mjs")],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            PI_SECURITY_CODEMODE_EXTENSION: join(
              directory,
              "node_modules/pi-security/dist/src/extension.js",
            ),
            PI_SECURITY_CODEMODE_CLI: join(
              directory,
              "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            ),
          },
        },
      );
      assert.equal(codemode.status, 0, codemode.stdout + codemode.stderr);

      // Writable kernel integration is supported by the macOS backend only.
      if (process.platform === "darwin") {
        const packedE2e = spawnSync(
          process.execPath,
          [join(root, "packages/pi-security/test/extensions-e2e.mjs")],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: 90_000,
            env: { ...process.env, PI_PACKAGED_ROOT: join(directory, "node_modules") },
          },
        );
        assert.equal(packedE2e.status, 0, packedE2e.stdout + packedE2e.stderr);
        assert.match(packedE2e.stdout, /"background":\{"insideWrite":true/);
        assert.match(
          packedE2e.stdout,
          /"packagedEntrypoints":\{"security":"[^"\n]+node_modules\/pi-security\/dist\/src\/extension\.js","background":"[^"\n]+node_modules\/pi-background\/dist\/extensions\/background-process\.js"\}/,
        );
        assert.match(
          packedE2e.stdout,
          /"packagedHostEntrypoints":\{"codingAgent":"[^"\n]+node_modules\/@earendil-works\/pi-coding-agent\/dist\/index\.js","aiCompat":"[^"\n]+node_modules\/@earendil-works\/pi-ai\/dist\/compat\.js"\}/,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
