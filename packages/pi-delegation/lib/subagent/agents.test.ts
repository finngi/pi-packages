import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discover, discoverAgents, parseAgent, projectLevels } from "./agents.ts";
import type { ParseFrontmatter } from "./agents.ts";

// Stand-in for pi's parseFrontmatter: `key: value` lines between --- fences; "!!bad" simulates invalid YAML.
const parse: ParseFrontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  if (m[1].includes("!!bad")) throw new Error("bad yaml");
  const frontmatter: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { frontmatter, body: m[2] };
};

const agentFile = (name: string, description = "Does things.", body = "Body.\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

test("parseAgent trims fields and keeps the body as the prompt", () => {
  const agent = parseAgent(
    agentFile("scout", "Finds things.", "\n  Look around.\n\n"),
    "/a/scout.md",
    parse,
  );
  assert.deepEqual(agent, {
    name: "scout",
    description: "Finds things.",
    body: "Look around.",
    filePath: "/a/scout.md",
    model: undefined,
    thinking: undefined,
    tools: undefined,
    skills: undefined,
    context: undefined,
    targets: undefined,
  });
});

const withFields = (fields: Record<string, unknown>) => {
  const parseFields: ParseFrontmatter = () => ({
    frontmatter: { name: "x", description: "d", ...fields },
    body: "b",
  });
  return parseAgent("ignored", "/a/x.md", parseFields);
};

test("model, thinking, tools and skills are read from the file", () => {
  const a = withFields({
    model: " sonnet ",
    thinking: "high",
    tools: "read, grep,read",
    skills: ["adr", "writing-instructions"],
  });
  assert.deepEqual(
    [a.model, a.thinking, a.tools, a.skills],
    ["sonnet", "high", ["read", "grep"], ["adr", "writing-instructions"]],
  );
});

test("context is read as none, all or a number of turns", () => {
  assert.deepEqual(
    [
      withFields({ conversation: "none" }).context,
      withFields({ conversation: "all" }).context,
      withFields({ conversation: 3 }).context,
    ],
    ["none", "all", 3],
  );
  assert.throws(() => withFields({ conversation: "soon" }), /conversation must be/);
});

test("an empty tools or skills list is kept, an absent one is not", () => {
  assert.deepEqual(withFields({ tools: [], skills: "" }).tools, []);
  assert.deepEqual(withFields({ skills: "" }).skills, []);
  assert.equal(withFields({ tools: null }).tools, undefined);
  assert.deepEqual(withFields({ skills: "*" }).skills, ["*"]);
  assert.deepEqual(withFields({ skills: ["*"] }).skills, ["*"]);
  assert.throws(() => withFields({ skills: ["*", "named"] }), /use "\*" alone/);
});

test("bad field values make the agent unusable with a reason", () => {
  assert.throws(() => withFields({ model: 5 }), /model must be a non-empty string/);
  assert.throws(() => withFields({ thinking: "extreme" }), /thinking must be one of/);
  assert.throws(
    () => withFields({ permissionMode: ["auto"] }),
    /permissionMode is no longer an agent setting/,
  );
  assert.throws(() => withFields({ tools: { a: 1 } }), /tools must be a list of names/);
  assert.throws(() => withFields({ tools: ["read", 3] }), /tools must be a list of names/);
  assert.throws(() => withFields({ skills: ["a b"] }), /skills: "a b" is not a valid name/);
});

test("parseAgent explains what is missing", () => {
  assert.throws(() => parseAgent("---\ndescription: d\n---\nb", "/a/x.md", parse), /missing name/);
  assert.throws(() => parseAgent("---\nname: x\n---\nb", "/a/x.md", parse), /missing description/);
  assert.throws(() => parseAgent("no frontmatter", "/a/x.md", parse), /missing name/);
});

test("discoverAgents reads .md files and symlinks, sorted, and ignores the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-disc-"));
  const dir = join(root, "agents");
  const elsewhere = join(root, "source");
  mkdirSync(dir, { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(join(dir, "b.md"), agentFile("b"));
  writeFileSync(join(elsewhere, "a.md"), agentFile("a"));
  symlinkSync(join(elsewhere, "a.md"), join(dir, "a.md"));
  writeFileSync(join(dir, "notes.txt"), agentFile("notes"));
  mkdirSync(join(dir, "folder.md"));
  const { agents, problems } = discoverAgents(dir, parse);
  assert.deepEqual(
    agents.map((a) => a.name),
    ["a", "b"],
  );
  assert.deepEqual(problems, []);
});

test("directory bundles require the exact entrypoint, canonicalize symlinks, and keep nested docs private", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-"));
  const dir = join(root, "agents");
  const source = join(root, "authored", "reviewer");
  mkdirSync(join(source, "skills", "review-check"), { recursive: true });
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(join(source, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  writeFileSync(
    join(source, "skills", "review-check", "SKILL.md"),
    "---\nname: review-check\ndescription: Check diffs.\n---\nUse the helper.\n",
  );
  writeFileSync(join(source, "references", "review.md"), "not an agent");
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(root, "authored", "reviewer"), join(dir, "reviewer"));
  mkdirSync(join(dir, "no-entrypoint"));
  writeFileSync(join(dir, "no-entrypoint", "nested.md"), agentFile("nested"));

  const result = discoverAgents(dir, parse);
  assert.equal(result.problems.length, 0);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].filePath, join(realpathSync(source), "reviewer.md"));
  assert.equal(result.agents[0].bundleRoot, realpathSync(source));
  assert.deepEqual(
    result.agents[0].privateSkills?.map(({ name }) => name),
    ["review-check"],
  );
  assert.equal(
    result.agents.some(({ name }) => name === "nested"),
    false,
  );
});

test("private skill parse failures report no parser excerpt or skill contents", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-warning-"));
  const dir = join(root, "agents");
  const bundle = join(dir, "reviewer");
  const skill = join(bundle, "skills", "review-check", "SKILL.md");
  mkdirSync(join(bundle, "skills", "review-check"), { recursive: true });
  writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  writeFileSync(
    skill,
    "---\nname: [broken\ndescription: PRIVATE_SKILL_CANARY_DESCRIPTION\n---\nPRIVATE_SKILL_CANARY_BODY\n",
  );

  const result = discoverAgents(dir, parse);
  assert.equal(result.agents.length, 1, "one broken skill does not hide the agent");
  assert.equal(result.agents[0].privateSkills?.length, 0);
  assert.deepEqual(result.problems, []);
  assert.match(result.warnings.join("\n"), /reviewer\.md: one or more private skills/);
  assert.doesNotMatch(result.warnings.join("\n"), /PRIVATE_SKILL_CANARY/);
});

test("private skill symlinks escaping the bundle are rejected before parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-symlink-"));
  const dir = join(root, "agents");
  const bundle = join(dir, "reviewer");
  const external = join(root, "outside", "SKILL.md");
  mkdirSync(join(bundle, "skills", "review-check"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  writeFileSync(
    external,
    "---\nname: [broken\ndescription: ESCAPING_SKILL_CANARY\n---\nPrivate content.\n",
  );
  symlinkSync(external, join(bundle, "skills", "review-check", "SKILL.md"));

  const result = discoverAgents(dir, parse);
  assert.equal(result.agents.length, 1);
  assert.deepEqual(result.agents[0].privateSkills, []);
  assert.match(result.warnings.join("\n"), /skills directory is unsafe/);
  assert.doesNotMatch(result.warnings.join("\n"), /ESCAPING_SKILL_CANARY|outside/);
});

test("private skill root cannot alias the bundle or be a dangling symlink", () => {
  for (const target of [".", "missing-skills-directory"]) {
    const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-root-link-"));
    const dir = join(root, "agents");
    const bundle = join(dir, "reviewer");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
    symlinkSync(target, join(bundle, "skills"), "dir");

    const result = discoverAgents(dir, parse);
    assert.equal(result.agents.length, 1);
    assert.deepEqual(result.agents[0].privateSkills, []);
    assert.match(result.warnings.join("\n"), /skills directory is unsafe/);
  }
});

test("private skill directory cycles and links outside the skills tree are rejected", () => {
  for (const link of ["cycle", "entrypoint"]) {
    const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-cycle-"));
    const dir = join(root, "agents");
    const bundle = join(dir, "reviewer");
    const skills = join(bundle, "skills");
    const skillDir = join(skills, "review-check");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: review-check\ndescription: Check diffs.\n---\nPrivate skill.\n",
    );
    if (link === "cycle") symlinkSync(".", join(skillDir, "cycle"), "dir");
    else symlinkSync(join(bundle, "reviewer.md"), join(skillDir, "entrypoint.md"));

    const result = discoverAgents(dir, parse);
    assert.equal(result.agents.length, 1);
    assert.deepEqual(result.agents[0].privateSkills, []);
    assert.match(result.warnings.join("\n"), /skills directory is unsafe/);
  }
});

test("safe private-skill directory aliases load each canonical skill once", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-alias-"));
  const dir = join(root, "agents");
  const bundle = join(dir, "reviewer");
  const skill = join(bundle, "skills", "review-check");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  writeFileSync(join(skill, "SKILL.md"), "---\ndescription: Check diffs.\n---\nUse the helper.\n");
  symlinkSync("review-check", join(bundle, "skills", "alias"), "dir");

  const result = discoverAgents(dir, parse);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.agents[0].privateSkills?.map(({ name }) => name),
    ["review-check"],
  );
});

test("validation warnings do not hide a skill or mark its agent unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-bundle-skill-validation-warning-"));
  const dir = join(root, "agents");
  const bundle = join(dir, "reviewer");
  mkdirSync(join(bundle, "skills", "review-check"), { recursive: true });
  writeFileSync(join(bundle, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  writeFileSync(
    join(bundle, "skills", "review-check", "SKILL.md"),
    "---\nname: invalid skill name\ndescription: Check diffs.\n---\nUse the helper.\n",
  );

  const result = discoverAgents(dir, parse);
  assert.deepEqual(result.problems, []);
  assert.equal(result.agents.length, 1);
  assert.deepEqual(
    result.agents[0].privateSkills?.map(({ name }) => name),
    ["invalid skill name"],
  );
  assert.match(result.warnings.join("\n"), /private skills have loading warnings/);
});

test("Go CLI managed bundle links resolve identity from the canonical directory name", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-managed-bundle-"));
  const source = join(root, "config", "agents", "reviewer");
  const selected = join(root, "project", ".agents", "agents");
  mkdirSync(source, { recursive: true });
  mkdirSync(selected, { recursive: true });
  writeFileSync(join(source, "reviewer.md"), agentFile("reviewer", "Reviews changes."));
  // agents use agent:reviewer creates this exact project alias.
  symlinkSync(source, join(selected, "reviewer.local"));

  const result = discoverAgents(selected, parse);
  assert.equal(result.problems.length, 0);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "reviewer");
  assert.equal(result.agents[0].filePath, join(realpathSync(source), "reviewer.md"));
  assert.equal(result.agents[0].bundleRoot, realpathSync(source));
});

test("Go CLI managed flat links parse the canonical target name", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-managed-flat-"));
  const source = join(root, "config", "agents", "reviewer.md");
  const selected = join(root, "project", ".agents", "agents");
  mkdirSync(join(root, "config", "agents"), { recursive: true });
  mkdirSync(selected, { recursive: true });
  writeFileSync(source, agentFile("reviewer", "Reviews changes."));
  // agents use agent:reviewer creates this exact flat-agent alias.
  symlinkSync(source, join(selected, "reviewer.local.md"));

  const result = discoverAgents(selected, parse);
  assert.equal(result.problems.length, 0);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, "reviewer");
  assert.equal(result.agents[0].filePath, realpathSync(source));
  assert.equal(result.agents[0].bundleRoot, undefined);
});

test("a flat entrypoint wins a same-named bundle deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-collision-"));
  writeFileSync(join(dir, "reviewer.md"), agentFile("reviewer", "Flat."));
  mkdirSync(join(dir, "reviewer"));
  writeFileSync(join(dir, "reviewer", "reviewer.md"), agentFile("reviewer", "Bundle."));
  const result = discoverAgents(dir, parse);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].description, "Flat.");
  assert.match(result.problems.join("\n"), /duplicate agent name "reviewer"/);
});

test("one bad file is reported and the others still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-bad-"));
  writeFileSync(join(dir, "bad.md"), "---\nname: bad\n!!bad\n---\nb");
  writeFileSync(join(dir, "nameless.md"), "---\ndescription: d\n---\nb");
  writeFileSync(join(dir, "good.md"), agentFile("good"));
  const { agents, problems } = discoverAgents(dir, parse);
  assert.deepEqual(
    agents.map((a) => a.name),
    ["good"],
  );
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /bad\.md: bad yaml/);
  assert.match(problems.join("\n"), /nameless\.md: missing name/);
});

test("filename/name disagreement is diagnosed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-dup-"));
  writeFileSync(join(dir, "a.md"), agentFile("same", "first"));
  writeFileSync(join(dir, "b.md"), agentFile("same", "second"));
  const { agents, problems } = discoverAgents(dir, parse);
  assert.deepEqual(agents, []);
  assert.match(problems[0], /a\.md: name "same" must match filename "a"/);
});

test("a missing directory is simply empty", () => {
  assert.deepEqual(discoverAgents(join(tmpdir(), "does-not-exist-agents"), parse), {
    agents: [],
    problems: [],
    warnings: [],
  });
});

test("an unreadable directory is a problem, not silence", () => {
  const file = join(mkdtempSync(join(tmpdir(), "agents-notdir-")), "file");
  writeFileSync(file, "");
  const { agents, problems } = discoverAgents(file, parse);
  assert.deepEqual(agents, []);
  assert.match(problems[0], /ENOTDIR/);
});

// --- project levels and trust ---

const tree = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-tree-")));
  const home = join(root, "home");
  mkdirSync(home);
  const put = (dir: string, name: string, description = "d") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), agentFile(name, description));
  };
  return { root, home, put };
};

test("projectLevels lists every level up the tree that holds agents, nearest first, .pi before .agents", () => {
  const { home, put } = tree();
  const cwd = join(home, "work", "repo", "pkg");
  mkdirSync(cwd, { recursive: true });
  put(join(home, "work/repo/.pi/agents"), "a");
  put(join(home, "work/repo/.agents/agents"), "b");
  put(join(home, "work/.agents/agents"), "c");
  put(join(cwd, ".agents/agents"), "d");
  const levels = projectLevels(cwd, home);
  assert.deepEqual(
    levels.map((l) => l.root),
    [cwd, join(home, "work/repo"), join(home, "work")],
  );
  assert.deepEqual(levels[1].dirs, [
    join(home, "work/repo/.pi/agents"),
    join(home, "work/repo/.agents/agents"),
  ]);
});

test("the walk reaches above the home directory, and skips the user's own agent source", () => {
  const { root, home, put } = tree();
  put(join(home, ".agents/agents"), "mine");
  put(join(home, ".pi/agents"), "at-home");
  put(join(root, ".agents/agents"), "above");
  const levels = projectLevels(join(home, "repo"), home);
  assert.deepEqual(
    levels.flatMap((l) => l.dirs),
    [join(home, ".pi/agents"), join(root, ".agents/agents")],
  );
});

test("a level without a trust decision is ignored and named", () => {
  const { home, put } = tree();
  const cwd = join(home, "repo");
  put(join(cwd, ".agents/agents"), "proj");
  const userDir = join(home, "user-agents");
  put(userDir, "mine");
  const found = discover(userDir, projectLevels(cwd, home), () => false, parse);
  assert.deepEqual(
    found.agents.map((a) => [a.name, a.source]),
    [["mine", "user"]],
  );
  assert.match(found.ignored[0], /repo\/\.agents\/agents: .*repo has no explicit trust decision/);
});

test("trust is decided per level", () => {
  const { home, put } = tree();
  const outer = join(home, "work");
  const cwd = join(outer, "repo");
  put(join(outer, ".agents/agents"), "outer");
  put(join(cwd, ".agents/agents"), "inner");
  const found = discover(
    join(home, "none"),
    projectLevels(cwd, home),
    (root) => root === outer,
    parse,
  );
  assert.deepEqual(
    found.agents.map((a) => a.name),
    ["outer"],
  );
  assert.equal(found.ignored.length, 1);
});

test("nearer levels win, and .pi wins over .agents in the same directory", () => {
  const { home, put } = tree();
  const cwd = join(home, "repo", "pkg");
  put(join(cwd, ".agents/agents"), "same", "nearest");
  put(join(home, "repo/.pi/agents"), "same", "pi");
  put(join(home, "repo/.agents/agents"), "same", "agents");
  const found = discover(join(home, "none"), projectLevels(cwd, home), () => true, parse);
  assert.deepEqual(
    found.agents.map((a) => a.description),
    ["nearest"],
  );
  assert.equal(found.problems.length, 2);
  assert.match(found.problems[0], /same" is already defined by .*pkg\/\.agents\/agents\/same\.md/);
});

test("a trusted project agent replaces a user agent of the same name, and says so", () => {
  const { home, put } = tree();
  const cwd = join(home, "repo");
  const userDir = join(home, "user-agents");
  put(userDir, "documentation-agent", "the user's");
  put(userDir, "only-mine", "kept");
  put(join(cwd, ".pi/agents"), "documentation-agent", "the project's");
  const found = discover(userDir, projectLevels(cwd, home), () => true, parse);
  assert.deepEqual(
    found.agents.map((a) => [a.name, a.description, a.source]),
    [
      ["documentation-agent", "the project's", "project"],
      ["only-mine", "kept", "user"],
    ],
  );
  assert.deepEqual(found.problems, []);
  assert.match(
    found.overrides[0],
    /repo\/\.pi\/agents\/documentation-agent\.md replaces the user agent "documentation-agent" \(.*user-agents\/documentation-agent\.md\)/,
  );
});

test("an untrusted project agent never replaces a user agent", () => {
  const { home, put } = tree();
  const cwd = join(home, "repo");
  const userDir = join(home, "user-agents");
  put(userDir, "documentation-agent", "the user's");
  put(join(cwd, ".pi/agents"), "documentation-agent", "the project's");
  const found = discover(userDir, projectLevels(cwd, home), () => false, parse);
  assert.deepEqual(
    found.agents.map((a) => [a.description, a.source]),
    [["the user's", "user"]],
  );
  assert.deepEqual(found.overrides, []);
  assert.equal(found.ignored.length, 1);
});

test("a bad file in a trusted level is a problem and the level's other agents still load", () => {
  const { home, put } = tree();
  const cwd = join(home, "repo");
  put(join(cwd, ".pi/agents"), "good");
  writeFileSync(join(cwd, ".pi/agents/bad.md"), "---\nname: bad\n!!bad\n---\nb");
  const found = discover(join(home, "none"), projectLevels(cwd, home), () => true, parse);
  assert.deepEqual(
    found.agents.map((a) => a.name),
    ["good"],
  );
  assert.match(found.problems[0], /bad\.md: bad yaml/);
});

test("metadata targets filter deployment copies and invalid authored tools/modes refuse", () => {
  assert.deepEqual(withFields({ targets: ["pi"] }).targets, ["pi"]);
  assert.throws(() => withFields({ targets: ["codex"] }), /targets/);
  assert.deepEqual(withFields({ tools: ["Read"] }).tools, ["Read"]);
  assert.deepEqual(withFields({ tools: ["subagent"] }).tools, ["subagent"]);
  assert.throws(
    () => withFields({ permissionMode: "typo" }),
    /permissionMode is no longer an agent setting/,
  );
  const dir = mkdtempSync(join(tmpdir(), "agents-targets-"));
  writeFileSync(join(dir, "x.md"), "ignored");
  assert.deepEqual(
    discoverAgents(dir, () => ({
      frontmatter: { name: "x", description: "d", targets: ["claude"] },
      body: "BODY",
    })).agents,
    [],
  );
});

test(
  "pack agent discovery bounds definition reads while preserving valid native bundle parsing",
  { timeout: 3000 },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { linkSync, rmSync } = await import("node:fs");
    const { parseFrontmatter } = await import("@earendil-works/pi-coding-agent");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pack-agent-boundary-"))),
      namespace = join(root, "namespace"),
      dir = join(namespace, "agents");
    try {
      mkdirSync(join(dir, "worker"), { recursive: true });
      writeFileSync(join(dir, "worker/worker.md"), agentFile("worker"));
      const outside = join(root, "outside.md");
      writeFileSync(outside, agentFile("outside", "SECRET_DESCRIPTION"));
      symlinkSync(outside, join(dir, "outside.md"));
      execFileSync("mkfifo", [join(dir, "pipe.md")]);
      symlinkSync("pipe.md", join(dir, "fifo.md"));
      writeFileSync(join(dir, "linked.md"), agentFile("linked"));
      linkSync(join(dir, "linked.md"), join(root, "another-name"));
      const found = discoverAgents(dir, parseFrontmatter, namespace);
      assert.deepEqual(
        found.agents.map((a) => a.name),
        ["worker"],
      );
      assert.match(found.warnings.join(), /escapes resource pack/);
      assert.match(found.problems.join(), /bounded regular/);
      assert.doesNotMatch(JSON.stringify(found), /SECRET_DESCRIPTION/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "pack private-skill preflight refuses unsafe native read inputs in a bounded subprocess",
  { timeout: 10000 },
  async () => {
    const { spawnSync, execFileSync } = await import("node:child_process");
    const { linkSync, rmSync } = await import("node:fs");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pack-ignore-boundary-"))),
      namespace = join(root, "namespace"),
      dir = join(namespace, "agents"),
      skills = join(dir, "worker/skills");
    try {
      mkdirSync(join(skills, "private-check"), { recursive: true });
      writeFileSync(join(dir, "worker/worker.md"), agentFile("worker"));
      const file = join(skills, "private-check/SKILL.md");
      writeFileSync(
        file,
        "---\nname: private-check\ndescription: Check privately.\n---\nLAZY_BODY",
      );
      const code = `
      import assert from "node:assert/strict";
      import {parseFrontmatter} from "@earendil-works/pi-coding-agent";
      import {discoverAgents} from ${JSON.stringify(new URL("./agents.ts", import.meta.url).href)};
      const found=discoverAgents(${JSON.stringify(dir)},parseFrontmatter,${JSON.stringify(namespace)});
      assert.equal(found.agents.length,1);
      const unsafe=process.argv[1]==="unsafe";
      assert.equal(found.agents[0].privateSkills.length,unsafe?0:1);
      assert.equal(found.warnings.length,unsafe?1:0);
    `;
      const run = (unsafe: boolean) => {
        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", code, unsafe ? "unsafe" : "safe"],
          { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
        );
        assert.equal(result.error, undefined, `discovery must terminate: ${result.error}`);
        assert.equal(result.status, 0, result.stderr);
      };
      run(false);
      for (const name of [".ignore", ".gitignore", ".fdignore"]) {
        const ignore = join(skills, name);
        execFileSync("mkfifo", [ignore]);
        run(true);
        rmSync(ignore);
      }
      writeFileSync(file, "x".repeat(1024 * 1024 + 1));
      run(true);
      writeFileSync(file, "---\nname: private-check\ndescription: Check privately.\n---\nBODY");
      linkSync(file, join(root, "another-skill-name"));
      run(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("agent tools may name selected native extension tools; availability is checked at launch", () => {
  const definition = parseAgent(agentFile("worker"), "/fixture/worker.md", () => ({
    frontmatter: {
      name: "worker",
      description: "Task worker",
      tools: ["codex_search", "background_process"],
    },
    body: "Complete the task.",
  }));
  assert.deepEqual(definition.tools, ["codex_search", "background_process"]);
});
