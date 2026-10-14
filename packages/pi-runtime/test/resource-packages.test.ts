import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SettingsManager, loadSkills } from "@earendil-works/pi-coding-agent";
import {
  discoverResourcePackages,
  readResourcePackage,
  resourcePackageKeywords,
} from "../src/resource-packages.ts";
const put = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-native-package-")));
  const pack = join(root, "packages", "sample");
  const manifest = {
    name: "sample",
    version: "0.1.0",
    description: "Searchable corpus workflows",
    keywords: ["bm25", "rpc"],
    pi: { extensions: [], skills: ["skills"], agents: ["agents"], instructions: ["instructions"] },
  };
  put(join(pack, "package.json"), JSON.stringify(manifest));
  const skill = put(
    join(pack, "skills/public-check/SKILL.md"),
    "---\nname: public-check\ndescription: Check public evidence.\n---\nPUBLIC_BODY_SENTINEL",
  );
  put(
    join(pack, "agents/worker/worker.md"),
    "---\nname: worker\ndescription: Check independently.\n---\nAGENT_BODY",
  );
  put(
    join(pack, "agents/worker/skills/private-check/SKILL.md"),
    "---\nname: private-check\ndescription: PRIVATE_DESCRIPTION_SENTINEL\n---\nPRIVATE_BODY_SENTINEL",
  );
  put(
    join(pack, "instructions/rule.md"),
    "---\nnotes: HUMAN_ONLY\n---\n# Evidence\nINSTRUCTION_BODY",
  );
  put(
    join(pack, "extensions/must-not-run.ts"),
    "throw Error('Discovery executed extension code');",
  );
  return { root, pack, manifest, skill };
}
const discover = (f: ReturnType<typeof fixture>, packages: any[] = [f.pack]) =>
  discoverResourcePackages(SettingsManager.inMemory({ packages }), f.root, join(f.root, "agent"));

test("native package manifests supply grouping without private skill leakage or executing extensions", async () => {
  const f = fixture();
  try {
    symlinkSync(f.pack, join(f.root, "alias"));
    const found = await discover(f, [f.pack, join(f.root, "alias")]);
    assert.deepEqual(found.problems, []);
    assert.equal(found.packs.length, 1);
    const p = found.packs[0];
    assert.deepEqual(p.skills, [f.skill]);
    assert.deepEqual(p.agents, [join(f.pack, "agents")]);
    assert.match(p.instructions[0].content, /INSTRUCTION_BODY/);
    assert.match(resourcePackageKeywords(p), /sample Searchable corpus workflows bm25 rpc/);
    const native = loadSkills({
      cwd: f.root,
      agentDir: f.root,
      skillPaths: p.skills,
      includeDefaults: false,
    });
    assert.deepEqual(
      native.skills.map((s) => s.name),
      ["public-check"],
    );
    assert.doesNotMatch(JSON.stringify(native.skills), /PRIVATE_/);
    assert.deepEqual((await discover(f, [])).packs, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native skill filters are authoritative, including empty filters and project precedence", async () => {
  const f = fixture();
  try {
    const blocked = await discover(f, [{ source: f.pack, skills: [] }]);
    assert.deepEqual(blocked.packs[0].skills, []);
    put(
      join(f.root, "agent/settings.json"),
      JSON.stringify({ packages: [{ source: f.pack, skills: [] }] }),
    );
    put(join(f.root, ".pi/settings.json"), JSON.stringify({ packages: [f.pack] }));
    const trusted = SettingsManager.create(f.root, join(f.root, "agent"), { projectTrusted: true });
    assert.deepEqual(
      (await discoverResourcePackages(trusted, f.root, join(f.root, "agent"))).packs[0].skills,
      [f.skill],
    );
    const untrusted = SettingsManager.create(f.root, join(f.root, "agent"), {
      projectTrusted: false,
    });
    assert.deepEqual(
      (await discoverResourcePackages(untrusted, f.root, join(f.root, "agent"))).packs[0].skills,
      [],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("agent-only native packages work and missing configured remote packages are skipped without installing", async () => {
  const f = fixture();
  try {
    f.manifest.pi.skills = [];
    put(join(f.pack, "package.json"), JSON.stringify(f.manifest));
    const found = await discover(f, [f.pack, "npm:@fixture/does-not-exist@0.0.0"]);
    assert.deepEqual(
      found.packs.map((p) => p.name),
      ["sample"],
    );
    assert.deepEqual(found.packs[0].skills, []);
    assert.equal(found.packs[0].agents.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("custom-only npm and Git packages use Pi's installed roots without native-resource placeholders", async () => {
  const f = fixture();
  try {
    f.manifest.pi.skills = [];
    put(join(f.pack, "package.json"), JSON.stringify(f.manifest));
    const agentDir = join(f.root, "agent"),
      npm = join(agentDir, "npm/node_modules/sample"),
      git = join(agentDir, "git/github.com/fixture/sample");
    for (const destination of [npm, git]) {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(f.pack, destination, { recursive: true });
    }
    for (const source of ["npm:sample@0.1.0", "git:github.com/fixture/sample"]) {
      const found = await discoverResourcePackages(
        SettingsManager.inMemory({ packages: [source] }),
        f.root,
        agentDir,
      );
      assert.deepEqual(found.problems, []);
      assert.equal(found.packs.length, 1);
      assert.equal(found.packs[0].agents.length, 1);
      assert.equal(found.packs[0].instructions.length, 1);
      assert.deepEqual(found.packs[0].skills, []);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("custom resource directories and instruction links cannot escape a native package", async () => {
  const f = fixture();
  try {
    const outside = put(join(f.root, "outside/rule.md"), "SECRET");
    symlinkSync(outside, join(f.pack, "instructions/escape.md"));
    assert.throws(() => readResourcePackage(f.pack), /escapes pack root/);
    const found = await discover(f);
    assert.deepEqual(found.packs, []);
    assert.doesNotMatch(found.problems.join(), /SECRET/);
    rmSync(join(f.pack, "instructions/escape.md"));
    f.manifest.pi.instructions = ["../../outside"];
    put(join(f.pack, "package.json"), JSON.stringify(f.manifest));
    assert.throws(() => readResourcePackage(f.pack), /escapes package root/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test(
  "bounded custom metadata reads reject hard links, pipes and oversized files",
  { timeout: 3000 },
  () => {
    const f = fixture();
    try {
      const rule = join(f.pack, "instructions/rule.md");
      linkSync(rule, join(f.root, "linked-rule"));
      assert.throws(() => readResourcePackage(f.pack), /bounded regular/);
      rmSync(join(f.root, "linked-rule"));
      rmSync(rule);
      execFileSync("mkfifo", [rule]);
      assert.throws(() => readResourcePackage(f.pack), /bounded regular/);
      rmSync(rule);
      put(rule, "x".repeat(1024 * 1024 + 1));
      assert.throws(() => readResourcePackage(f.pack), /bounded regular/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test("the read cap holds when a regular file grows after its descriptor was inspected", async () => {
  const { spawnSync } = await import("node:child_process");
  const f = fixture();
  try {
    const file = join(f.pack, "growth.txt");
    writeFileSync(file, "small");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import {syncBuiltinESMExports} from "node:module";
      import {readResourceFile} from ${JSON.stringify(new URL("../src/resource-packages.ts", import.meta.url).href)};
      const initial=fs.fstatSync;
      fs.fstatSync=(fd)=>{const info=initial(fd);fs.appendFileSync(${JSON.stringify(file)},Buffer.alloc(1024*1024+1));return info;};
      syncBuiltinESMExports();
      assert.throws(()=>readResourceFile(${JSON.stringify(f.pack)},${JSON.stringify(file)}),/discovery byte limit/);
    `,
      ],
      { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("package candidates respect actual native --no-skills loading; temporary -e skills remain native resources", async () => {
  const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
  const f = fixture();
  try {
    const settings = SettingsManager.inMemory({ packages: [f.pack] });
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.root, "agent"),
      settingsManager: settings,
      noSkills: true,
      noExtensions: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills, []);
    const blocked = await discoverResourcePackages(settings, f.root, join(f.root, "agent"), []);
    assert.deepEqual(blocked.packs[0].skills, []);
    const temporarySettings = SettingsManager.inMemory();
    const explicit = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.root, "agent"),
      settingsManager: temporarySettings,
      noSkills: true,
      noExtensions: true,
      additionalExtensionPaths: [f.pack],
    });
    await explicit.reload();
    const loaded = explicit.getSkills().skills;
    assert.deepEqual(
      loaded.map((skill) => skill.name),
      ["public-check"],
    );
    assert.equal(loaded[0].sourceInfo.scope, "temporary");
    const allowed = await discoverResourcePackages(
      temporarySettings,
      f.root,
      join(f.root, "agent"),
      loaded.map((skill) => skill.sourceInfo),
    );
    assert.deepEqual(allowed.packs, []);
    assert.equal(loaded[0].sourceInfo.origin, "top-level");
    assert.equal(loaded[0].sourceInfo.baseDir, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native rejection of a stale npm version cannot reintroduce its custom resources", async () => {
  const f = fixture();
  try {
    const agentDir = join(f.root, "agent");
    const stale = join(agentDir, "npm/node_modules/fixture-stale");
    put(
      join(stale, "package.json"),
      JSON.stringify({
        name: "fixture-stale",
        version: "1.0.0",
        pi: { agents: ["agents"], instructions: ["instructions"] },
      }),
    );
    put(join(stale, "agents/stale/stale.md"), "STALE_AGENT");
    put(join(stale, "instructions/stale.md"), "STALE_INSTRUCTION");
    const settings = SettingsManager.inMemory({ packages: ["npm:fixture-stale@2.0.0"] });
    const found = await discoverResourcePackages(settings, f.root, agentDir);
    assert.deepEqual(found.packs, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native project package identity supersedes a different user version without reviving its agents", async () => {
  const f = fixture();
  try {
    const agentDir = join(f.root, "agent"),
      name = "fixture-shared";
    const add = (directory: string, version: string, label: string) => {
      put(
        join(directory, "package.json"),
        JSON.stringify({ name, version, pi: { skills: ["skills"], agents: ["agents"] } }),
      );
      put(
        join(directory, `skills/${label}/SKILL.md`),
        `---\nname: ${label}\ndescription: Native ${label}\n---\nBODY`,
      );
      put(
        join(directory, `agents/${label}/${label}.md`),
        `---\nname: ${label}\ndescription: Native ${label}\n---\nBODY`,
      );
    };
    add(join(agentDir, "npm/node_modules", name), "1.0.0", "old");
    add(join(f.root, ".pi/npm/node_modules", name), "2.0.0", "current");
    put(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${name}@1.0.0`] }));
    put(join(f.root, ".pi/settings.json"), JSON.stringify({ packages: [`npm:${name}@2.0.0`] }));
    const settings = SettingsManager.create(f.root, agentDir, { projectTrusted: true });
    const found = await discoverResourcePackages(settings, f.root, agentDir);
    assert.equal(found.packs.length, 1);
    assert.match(found.packs[0].agents[0], /\.pi\/npm/);
    assert.equal(
      found.packs[0].skills.some((file) => file.includes("/old/")),
      false,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
