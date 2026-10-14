import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileProfile } from "../src/profiles.ts";
import { protectedWriteNames } from "../src/protected-paths.ts";

async function fixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-profile-traversal-")));
  const policy = {
    project: root,
    filesystem: { writeAllow: [root], writeDeny: [], readDeny: [] },
  };
  try {
    await run(root, policy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const permissions = { write: true, network: [] };
const frozen = (profile, directory) =>
  profile.includes(
    `(deny file-write-unlink (require-all (literal "${directory}") (vnode-type DIRECTORY)))`,
  );

test("all protected names freeze their ancestors at arbitrary depth and casing", async () => {
  await fixture(async (root, policy) => {
    for (const [index, name] of protectedWriteNames.entries()) {
      const directory = path.join(root, `ordinary-${index}`, "deep", "child");
      const protectedFile = path.join(directory, name.toUpperCase());
      await mkdir(path.dirname(protectedFile), { recursive: true });
      await writeFile(protectedFile, "protected");
    }
    const profile = compileProfile(policy, permissions);
    for (const [index, name] of protectedWriteNames.entries()) {
      for (const suffix of [
        `ordinary-${index}`,
        `ordinary-${index}/deep`,
        `ordinary-${index}/deep/child`,
      ])
        assert.ok(frozen(profile, path.join(root, suffix)), name);
      if (name.includes("/"))
        assert.ok(
          frozen(
            profile,
            path.join(root, `ordinary-${index}/deep/child`, path.dirname(name).toUpperCase()),
          ),
        );
    }
  });
});

test("root boundary is excluded from protected-name matching and ordinary builds remain movable", async () => {
  await fixture(async (root, policy) => {
    const writeRoot = path.join(root, ".git");
    await mkdir(path.join(writeRoot, "build/cache"), { recursive: true });
    await writeFile(path.join(writeRoot, "build/cache/config"), "ordinary");
    await writeFile(path.join(writeRoot, "config"), "outside vocabulary relative to this root");
    policy.filesystem.writeAllow = [writeRoot];
    const profile = compileProfile(policy, permissions);
    assert.ok(frozen(profile, writeRoot));
    assert.equal(frozen(profile, path.join(writeRoot, "build")), false);
    assert.equal(frozen(profile, path.join(writeRoot, "build/cache")), false);
  });
});

test("each compilation discovers newly created protected descendants without a stale cache", async () => {
  await fixture(async (root, policy) => {
    const build = path.join(root, "build/nested");
    await mkdir(build, { recursive: true });
    assert.equal(frozen(compileProfile(policy, permissions), build), false);
    await writeFile(path.join(build, "AGENTS.md"), "protected");
    assert.ok(frozen(compileProfile(policy, permissions), build));
  });
});

test("redirected or non-directory roots fail closed", async () => {
  await fixture(async (root, policy) => {
    const directory = path.join(root, "directory");
    const alias = path.join(root, "alias");
    const file = path.join(root, "file");
    await mkdir(directory);
    await symlink(directory, alias);
    await writeFile(file, "ordinary");
    for (const writeRoot of [alias, file]) {
      policy.filesystem.writeAllow = [writeRoot];
      assert.throws(() => compileProfile(policy, permissions), /directory changed/);
    }
  });
});

test("prefix lookalikes remain ordinary paths", async () => {
  await fixture(async (root, policy) => {
    for (const relative of [
      "repo/.gitish/config",
      "repo/.git/config-backup",
      "repo/.github/workflows-old",
      "build/AGENTS.md.old",
      "build/.pi-cache/output",
    ]) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "ordinary");
    }
    const profile = compileProfile(policy, permissions);
    for (const relative of [
      "repo",
      "repo/.gitish",
      "repo/.git",
      "repo/.github",
      "build",
      "build/.pi-cache",
    ])
      assert.equal(frozen(profile, path.join(root, relative)), false, relative);
  });
});

test(
  "unreadable directories still reject profile compilation",
  { skip: process.getuid?.() === 0 },
  async () => {
    await fixture(async (root, policy) => {
      const unreadable = path.join(root, "unreadable");
      await mkdir(unreadable);
      await chmod(unreadable, 0);
      try {
        assert.throws(() => compileProfile(policy, permissions), { code: "EACCES" });
      } finally {
        await chmod(unreadable, 0o700);
      }
    });
  },
);
