import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  childToolAuthority,
  installChildResources,
  readBundleFile,
  resolveChildResources,
} from "./child-resources.ts";

const parent = (skills: Array<{ name: string; path: string }> = []) => ({
  tools: ["read", "write", "edit", "bash"],
  skills,
  thinking: "off" as const,
});

async function installContext(content: string) {
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-malformed-context-"));
  try {
    const resources = await resolveChildResources(
      {
        staticContext: {
          originalCwd: "/parent/project",
          files: [{ path: "/parent/project/AGENTS.md", content }],
        },
      },
      parent(),
    );
    const installed = await installChildResources(resources, launch);
    return await readFile(installed.instructions, "utf8");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(launch, { recursive: true, force: true });
  }
}

async function bundleFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-bundle-"));
  const bundle = path.join(root, "reviewer");
  await mkdir(path.join(bundle, "skills", "review-check"), { recursive: true });
  await mkdir(path.join(bundle, "references"), { recursive: true });
  await mkdir(path.join(bundle, "scripts"), { recursive: true });
  await mkdir(path.join(bundle, "credentials"), { recursive: true });
  await mkdir(path.join(bundle, ".config"), { recursive: true });
  await writeFile(path.join(bundle, "reviewer.md"), "review prompt");
  await writeFile(
    path.join(bundle, "skills", "review-check", "SKILL.md"),
    "---\nname: review-check\ndescription: Review a change.\n---\nSee ../../references/checklist.md and run ../../scripts/check.mjs.\n",
  );
  await writeFile(path.join(bundle, "references", "checklist.md"), "Private checklist");
  await symlink("checklist.md", path.join(bundle, "references", "shared.md"));
  await writeFile(path.join(bundle, "scripts", "check.mjs"), "export const checked = true;");
  const executable = path.join(bundle, "scripts", "check.sh");
  await writeFile(executable, "#!/bin/sh\nprintf 'EXECUTABLE_BUNDLE_SENTINEL\\n'\n");
  await chmod(executable, 0o755);
  await writeFile(path.join(bundle, "credentials", "fixture-token"), "bundle-owned fixture data");
  await writeFile(path.join(bundle, ".env.example"), "PUBLIC_EXAMPLE=value\n");
  await writeFile(path.join(bundle, ".config", "reference.md"), "Bundle config reference");
  const outside = path.join(root, "outside-secret");
  await writeFile(outside, "external secret");
  return { root, bundle, outside };
}

test("bundle skills are private, inherited by default, and explicit empty skills select none", async () => {
  const { bundle } = await bundleFixture();
  const bundleReal = await realpath(bundle);
  const privateSkill = path.join(bundleReal, "skills", "review-check", "SKILL.md");
  const publicSkill = path.join(bundleReal, "public", "SKILL.md");
  const authority = parent([{ name: "shared", path: publicSkill }]);
  const spec = {
    agentBundle: {
      root: bundleReal,
      privateSkills: [{ name: "review-check", path: privateSkill }],
    },
  };

  const inherited = await resolveChildResources(spec, authority);
  assert.deepEqual(
    inherited.skills.map(({ name }) => name),
    ["shared", "review-check"],
  );
  assert.deepEqual((await resolveChildResources({ ...spec, skills: [] }, authority)).skills, []);
  assert.deepEqual(
    (await resolveChildResources({ ...spec, skills: ["review-check"] }, authority)).skills.map(
      ({ name }) => name,
    ),
    ["review-check"],
  );
  assert.throws(
    () => resolveChildResources({ ...spec, skills: ["other"] }, authority),
    /child skill unavailable/,
  );
});

test("private bundle resources stage read-only with relative paths and preserve ordinary assets", async () => {
  const { bundle, outside } = await bundleFixture();
  const privateSkill = path.join(await realpath(bundle), "skills", "review-check", "SKILL.md");
  const resources = await resolveChildResources(
    {
      agentBundle: {
        root: await realpath(bundle),
        privateSkills: [{ name: "review-check", path: privateSkill }],
      },
    },
    parent(),
  );
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-launch-"));
  try {
    const installed = await installChildResources(resources, launch);
    const stagedSkill = installed.skillPaths[0];
    const stagedBundle = installed.bundlePath!;
    assert.equal(
      await readFile(path.join(path.dirname(stagedSkill), "../../references/checklist.md"), "utf8"),
      "Private checklist",
    );
    assert.equal(
      await readFile(path.join(path.dirname(stagedSkill), "../../scripts/check.mjs"), "utf8"),
      "export const checked = true;",
    );
    assert.equal(
      await readFile(path.join(stagedBundle, "references/shared.md"), "utf8"),
      "Private checklist",
    );
    assert.equal(
      await readFile(path.join(stagedBundle, ".env.example"), "utf8"),
      "PUBLIC_EXAMPLE=value\n",
    );
    assert.equal(
      await readFile(path.join(stagedBundle, ".config/reference.md"), "utf8"),
      "Bundle config reference",
    );
    assert.equal(
      await readFile(path.join(stagedBundle, "credentials/fixture-token"), "utf8"),
      "bundle-owned fixture data",
    );
    const stagedExecutable = path.join(stagedBundle, "scripts", "check.sh");
    const executableMode = (await lstat(stagedExecutable)).mode;
    assert.notEqual(executableMode & 0o111, 0);
    assert.equal(executableMode & 0o222, 0);
    const execution = spawnSync(stagedExecutable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "EXECUTABLE_BUNDLE_SENTINEL\n");
    assert.equal(await readFile(outside, "utf8"), "external secret");
    assert.equal((await lstat(stagedSkill)).mode & 0o222, 0);
  } finally {
    await chmod(launch, 0o700);
    const { rm } = await import("node:fs/promises");
    await rm(launch, { recursive: true, force: true });
  }
});

test("agent instructions locate supporting bundle scripts without selecting any skills", async () => {
  const { bundle, root } = await bundleFixture();
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-script-launch-"));
  const workspace = path.join(launch, "workspace");
  await mkdir(workspace);
  try {
    const resources = resolveChildResources(
      {
        instructions: "Run scripts/check.sh.",
        skills: [],
        agentBundle: { root: await realpath(bundle), privateSkills: [] },
      },
      parent(),
    );
    const installed = await installChildResources(resources, launch);
    const prompt = await readFile(installed.instructions, "utf8");
    assert.deepEqual(installed.skillPaths, []);
    assert.match(prompt, /Resolve relative supporting paths in your agent instructions/);
    const advertised = prompt.match(/<agent_bundle path="([^"]+)" \/>/)?.[1];
    assert.equal(advertised, installed.bundlePath);
    const execution = spawnSync(path.join(advertised!, "scripts/check.sh"), [], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "EXECUTABLE_BUNDLE_SENTINEL\n");
    assert.doesNotMatch(prompt, /Private checklist|See \.\.\/\.\.\/references/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(launch, { recursive: true, force: true });
  }
});

test("escaping bundle symlinks are refused instead of silently omitted or copied", async () => {
  const { bundle, outside } = await bundleFixture();
  await symlink(outside, path.join(bundle, "outside-reference"));
  const privateSkill = path.join(await realpath(bundle), "skills", "review-check", "SKILL.md");
  const resources = await resolveChildResources(
    {
      agentBundle: {
        root: await realpath(bundle),
        privateSkills: [{ name: "review-check", path: privateSkill }],
      },
    },
    parent(),
  );
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-escape-link-"));
  try {
    await assert.rejects(installChildResources(resources, launch), /symlink escapes bundle root/);
    assert.equal(await readFile(outside, "utf8"), "external secret");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(launch, { recursive: true, force: true });
  }
});

test("bundle staging omits git metadata reached through internal symlink aliases", async () => {
  const { bundle } = await bundleFixture();
  const git = path.join(bundle, ".git");
  await mkdir(path.join(git, "hooks"), { recursive: true });
  await writeFile(path.join(git, "config"), "private git config");
  await writeFile(path.join(git, "hooks", "pre-commit"), "private git hook");
  await symlink(".git/config", path.join(bundle, "git-config-copy"));
  await symlink(".git/hooks", path.join(bundle, "git-hooks-copy"));
  const privateSkill = path.join(await realpath(bundle), "skills", "review-check", "SKILL.md");
  const resources = await resolveChildResources(
    {
      agentBundle: {
        root: await realpath(bundle),
        privateSkills: [{ name: "review-check", path: privateSkill }],
      },
    },
    parent(),
  );
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-git-aliases-"));
  try {
    const installed = await installChildResources(resources, launch);
    const staged = installed.bundlePath!;
    await assert.rejects(readFile(path.join(staged, ".git", "config")));
    await assert.rejects(readFile(path.join(staged, "git-config-copy")));
    await assert.rejects(lstat(path.join(staged, "git-hooks-copy")));
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(launch, { recursive: true, force: true });
  }
});

test("bundle reads reject symlink opens and files swapped after inspection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-bundle-read-"));
  const original = path.join(root, "original.txt");
  const replacement = path.join(root, "replacement.txt");
  const link = path.join(root, "link.txt");
  try {
    await writeFile(original, "reviewed bundle content");
    await writeFile(replacement, "replacement content");
    const reviewed = await stat(original);
    const replaced = await stat(replacement);
    assert.notEqual(reviewed.ino, replaced.ino);
    assert.equal(
      (await readBundleFile(original, 100, reviewed)).toString(),
      "reviewed bundle content",
    );
    await assert.rejects(readBundleFile(replacement, 100, reviewed), /changed during staging/);
    await symlink(replacement, link);
    await assert.rejects(readBundleFile(link, 100, replaced), /changed during staging/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent bundle staging enforces total byte and entry limits", async (t) => {
  await t.test(
    "rejects cumulative file content above the byte limit before copying it",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "pi-agent-large-bundle-"));
      const bundle = path.join(root, "agent");
      const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-large-launch-"));
      await mkdir(bundle);
      const firstFile = path.join(bundle, "first.bin");
      const secondFile = path.join(bundle, "second.bin");
      await writeFile(firstFile, "");
      await writeFile(secondFile, "");
      await truncate(firstFile, 8 * 1024 * 1024);
      await truncate(secondFile, 8 * 1024 * 1024 + 1);
      try {
        const resources = await resolveChildResources(
          { agentBundle: { root: await realpath(bundle), privateSkills: [] } },
          parent(),
        );
        await assert.rejects(installChildResources(resources, launch), /exceeds 16 MiB byte limit/);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(launch, { recursive: true, force: true });
      }
    },
  );

  await t.test("rejects a bundle with too many filesystem entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-agent-many-bundle-"));
    const bundle = path.join(root, "agent");
    const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-many-launch-"));
    await mkdir(bundle);
    for (let index = 0; index < 2049; index += 1)
      await writeFile(path.join(bundle, `entry-${index}`), "");
    try {
      const resources = await resolveChildResources(
        { agentBundle: { root: await realpath(bundle), privateSkills: [] } },
        parent(),
      );
      await assert.rejects(installChildResources(resources, launch), /exceeds 2048 entry limit/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(launch, { recursive: true, force: true });
    }
  });
});

test("static parent context loses eager frontmatter and names original project separately from workspace", async () => {
  const resources = await resolveChildResources(
    {
      instructions: "Stable child instructions.",
      staticContext: {
        originalCwd: "/parent/project",
        files: [
          {
            path: "/parent/project/AGENTS.md",
            content: "---\nprivate: true\n---\n# Project rule\nKeep the source origin.\n",
          },
        ],
      },
    },
    parent(),
  );
  const launch = await mkdtemp(path.join(tmpdir(), "pi-agent-context-"));
  try {
    const installed = await installChildResources(resources, launch);
    const prompt = await readFile(installed.instructions, "utf8");
    assert.match(prompt, /original_project="\/parent\/project"/);
    assert.match(prompt, /Source: \/parent\/project\/AGENTS\.md/);
    assert.match(prompt, /# Project rule\nKeep the source origin\./);
    assert.doesNotMatch(prompt, /private: true/);
    assert.match(prompt, /writable workspace is set separately/);
    assert.equal((await lstat(path.join(launch, "context", "001.md"))).mode & 0o222, 0);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(launch, { recursive: true, force: true });
  }
  const malformedClosed = await installContext("---\nnot: [valid\n---\nClosed header body");
  assert.match(malformedClosed, /Closed header body/);
  assert.doesNotMatch(malformedClosed, /not: \[valid/);
  const unclosed = await installContext("---\nprivate: true\nUnclosed body");
  assert.match(unclosed, /---\nprivate: true\nUnclosed body/);
  for (const body of [
    "---bad\nMARKDOWN_BODY_SENTINEL\n---tail\nAFTER_SENTINEL",
    "--- heading\n---\nBody",
    "---\nBody\n--- heading\nMore body",
  ]) {
    const preserved = await installContext(body);
    assert.ok(preserved.includes(body), preserved);
  }
  const prefixedClosing = await installContext(
    "---\nnotes: first\n---bad\nnotes: HIDDEN_METADATA\n---\nKEPT_BODY",
  );
  assert.match(prefixedClosing, /KEPT_BODY/);
  assert.doesNotMatch(prefixedClosing, /HIDDEN_METADATA/);
});

test("selected instructions render once outside project context, including without project files", async () => {
  const behavior =
    '<instruction path="/rules/careful.md">\n# Be careful\nCheck assumptions.\n</instruction>';
  for (const files of [[], [{ path: "/parent/AGENTS.md", content: "PROJECT_CONTEXT" }]]) {
    const launch = await mkdtemp(path.join(tmpdir(), "pi-inherited-instructions-"));
    try {
      const resources = resolveChildResources(
        {
          instructions: "AGENT_BODY",
          staticContext: { originalCwd: "/parent", files, instructions: behavior },
        },
        parent(),
      );
      const installed = await installChildResources(resources, launch);
      const prompt = await readFile(installed.instructions, "utf8");
      assert.ok(prompt.includes(`<instructions>\n${behavior}\n</instructions>`), prompt);
      assert.equal(prompt.match(/<instructions>/g)?.length, 1);
      const projectContext = prompt.match(
        /<inherited_static_context[^>]*>([\s\S]*?)<\/inherited_static_context>/,
      )?.[1];
      if (files.length) assert.match(projectContext!, /PROJECT_CONTEXT/);
      else assert.equal(projectContext, undefined);
      assert.ok(!projectContext?.includes(behavior));
      assert.match(prompt, /AGENT_BODY/);
      assert.ok(prompt.indexOf(behavior) < prompt.indexOf("AGENT_BODY"));
    } finally {
      await rm(launch, { recursive: true, force: true });
    }
  }
});

test("inherited instructions validate string content and share the static snapshot byte limit", () => {
  for (const instructions of [null, 1, {}, [], "bad\0body", "x".repeat(512 * 1024)]) {
    assert.throws(
      () =>
        resolveChildResources(
          { staticContext: { originalCwd: "/parent", files: [], instructions } } as any,
          parent(),
        ),
      /invalid inherited static context/,
    );
  }
  assert.throws(
    () =>
      resolveChildResources(
        {
          staticContext: {
            originalCwd: "/parent",
            files: [{ path: "/parent/AGENTS.md", content: "x".repeat(300 * 1024) }],
            instructions: "y".repeat(220 * 1024),
          },
        },
        parent(),
      ),
    /invalid inherited static context/,
  );
  assert.equal(
    resolveChildResources(
      { staticContext: { originalCwd: "/parent", files: [], instructions: "" } },
      parent(),
    ).staticContext?.instructions,
    "",
  );
});

test("bundle metadata cannot widen tools or use a skill outside its canonical bundle", async () => {
  const { bundle } = await bundleFixture();
  const outsideSkill = path.join(path.dirname(bundle), "outside", "SKILL.md");
  const bundleRoot = await realpath(bundle);
  await mkdir(path.dirname(outsideSkill), { recursive: true });
  await writeFile(outsideSkill, "---\nname: escape\ndescription: no\n---\n");
  assert.throws(
    () =>
      resolveChildResources(
        { tools: ["subagent"], agentBundle: { root: bundleRoot, privateSkills: [] } },
        parent(),
      ),
    /unavailable or widened/,
  );
  const resolved = await resolveChildResources(
    { agentBundle: { root: bundleRoot, privateSkills: [{ name: "escape", path: outsideSkill }] } },
    parent(),
  );
  assert.deepEqual(resolved.skills, []);
});

test("selected native package tools inherit, and explicit lists cannot widen the parent's tools", () => {
  const selected = {
    ...parent(),
    tools: ["read", "bash", "codex_search", "background_process"],
    toolSources: {
      codex_search: "/packages/search.js",
      background_process: "/packages/background.js",
    },
  };
  assert.deepEqual(resolveChildResources({}, selected).tools, selected.tools);
  assert.deepEqual(resolveChildResources({ tools: ["read", "codex_search"] }, selected).tools, [
    "read",
    "codex_search",
  ]);
  assert.deepEqual(resolveChildResources({ tools: [] }, selected).tools, []);
  assert.throws(
    () => resolveChildResources({ tools: ["codex_search"] }, { ...parent(), tools: ["read"] }),
    /unavailable|widened/,
  );
  assert.deepEqual(selected.tools, ["read", "bash", "codex_search", "background_process"]);
  assert.throws(
    () => resolveChildResources({}, { ...parent(), tools: ["codex_search"] }),
    /native tool source unavailable/,
  );
});

test("child tool entrypoints follow native active registrations, not unused package tools", () => {
  const native = (name: string, source: string) => ({ name, sourceInfo: { path: source } });
  const pi = {
    getActiveTools: () => [
      "read",
      "codex_search",
      "background_process",
      "session_setup",
      "subagent",
      "agent_message",
      "mcp__fixture__read",
    ],
    getAllTools: () => [
      native("read", "builtin:read"),
      native("mcp__fixture__read", "builtin:mcp"),
      native("codex_search", "/packages/search/extension.js"),
      native("background_process", "/packages/jobs/extension.js"),
      native("unused", "/packages/unused/extension.js"),
      native("subagent", "/packages/delegation/extension.js"),
      native("agent_message", "/packages/delegation/extension.js"),
    ],
  };
  const authority = {
    ...childToolAuthority(pi as any, "/packages/delegation/extension.js"),
    skills: [],
    thinking: "off" as const,
  };
  assert.deepEqual(authority.tools, ["read", "codex_search", "background_process"]);
  assert.deepEqual(resolveChildResources({ tools: ["codex_search"] }, authority).extensions, [
    "/packages/search/extension.js",
  ]);
  assert.deepEqual(resolveChildResources({ tools: [] }, authority).extensions, undefined);
  assert.throws(
    () => resolveChildResources({ tools: ["unused"] }, authority),
    /unavailable|widened/,
  );
});
