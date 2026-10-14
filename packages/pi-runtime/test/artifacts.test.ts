import assert from "node:assert/strict";
import fs from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PreparedChild } from "pi-contracts";
import { collectArtifacts } from "../src/artifacts.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-artifacts-"));
  const workspace = join(root, "workspace"),
    results = join(root, "results"),
    secret = join(root, "outside-secret.md");
  await mkdir(workspace);
  await mkdir(results);
  await writeFile(secret, "must not be copied");
  const info = await lstat(workspace);
  const child = {
    cwd: workspace,
    env: {},
    workspaceKind: "scratch",
    workspaceIdentity: { path: await realpath(workspace), dev: info.dev, ino: info.ino },
  } as PreparedChild;
  return { root, workspace, results, secret, child };
}

test("artifact collection copies ordinary files with their modes and omits stable symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "report.md"), "reviewed result", { mode: 0o640 });
    await symlink(f.secret, join(f.workspace, "external.md"));

    const artifacts = await collectArtifacts(f.child, f.results);

    assert.deepEqual(artifacts.files, ["report.md"]);
    assert.deepEqual(artifacts.omitted, ["external.md"]);
    assert.equal(await readFile(join(artifacts.directory, "report.md"), "utf8"), "reviewed result");
    assert.equal((await stat(join(artifacts.directory, "report.md"))).mode & 0o777, 0o640);
    assert.equal(await readFile(f.secret, "utf8"), "must not be copied");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection stops at file, byte and entry budgets without deleting the workspace", async () => {
  for (const limits of [{ maxFiles: 1 }, { maxBytes: 7 }, { maxEntries: 1 }]) {
    const f = await fixture();
    try {
      await writeFile(join(f.workspace, "one.txt"), "1234");
      await writeFile(join(f.workspace, "two.txt"), "5678");

      await assert.rejects(collectArtifacts(f.child, f.results, limits), (error: Error) => {
        assert.match(error.message, /Artifact collection budget exceeded/);
        assert.ok(error.message.includes(f.workspace));
        return true;
      });

      assert.deepEqual(await readdir(f.results), [], "partial artifact copies are removed");
      assert.equal(await readFile(join(f.workspace, "one.txt"), "utf8"), "1234");
      assert.equal(await readFile(join(f.workspace, "two.txt"), "utf8"), "5678");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("artifact collection refuses a file replaced by a symlink after enumeration", async () => {
  const f = await fixture();
  const victim = join(f.workspace, "result.md");
  const canonicalVictim = await realpath(f.workspace).then((root) => join(root, "result.md"));
  let replaced = false;
  const originalOpen = fs.promises.open;
  try {
    await writeFile(victim, "ordinary workspace file");
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const [path] = args;
      if (!replaced && String(path) === canonicalVictim) {
        replaced = true;
        await unlink(victim);
        await symlink(f.secret, victim);
      }
      return originalOpen(...args);
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();

    const artifacts = await collectArtifacts(f.child, f.results);

    assert.equal(replaced, true);
    assert.deepEqual(artifacts.files, []);
    assert.deepEqual(artifacts.omitted, ["result.md"]);
    assert.equal(await readFile(f.secret, "utf8"), "must not be copied");
    await assert.rejects(readFile(join(artifacts.directory, "result.md")), { code: "ENOENT" });
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection refuses a directory replaced by an outside symlink before recursion", async () => {
  const f = await fixture();
  const nested = join(f.workspace, "nested"),
    outsideDirectory = join(f.root, "outside-directory"),
    canonicalNested = await realpath(f.workspace).then((root) => join(root, "nested"));
  let replaced = false;
  const originalOpendir = fs.promises.opendir;
  try {
    await mkdir(nested);
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "secret.md"), "must not be copied");
    fs.promises.opendir = (async (...args: Parameters<typeof fs.promises.opendir>) => {
      const [path] = args;
      if (!replaced && String(path) === canonicalNested) {
        replaced = true;
        await rm(nested, { recursive: true });
        await symlink(outsideDirectory, nested);
      }
      return originalOpendir(...args);
    }) as typeof fs.promises.opendir;
    syncBuiltinESMExports();

    const artifacts = await collectArtifacts(f.child, f.results);

    assert.equal(replaced, true);
    assert.deepEqual(artifacts.files, []);
    assert.deepEqual(artifacts.omitted, ["nested"]);
    assert.equal(await readFile(join(outsideDirectory, "secret.md"), "utf8"), "must not be copied");
    await assert.rejects(readFile(join(artifacts.directory, "nested", "secret.md")), {
      code: "ENOENT",
    });
  } finally {
    fs.promises.opendir = originalOpendir;
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection rejects an outside workspace substituted through a parent symlink", async () => {
  const f = await fixture();
  const scratchParent = join(f.root, "scratch"),
    savedParent = join(f.root, "scratch-saved"),
    outsideParent = join(f.root, "outside-parent"),
    originalWorkspace = join(scratchParent, "workspace"),
    outsideWorkspace = join(outsideParent, "workspace");
  try {
    await mkdir(originalWorkspace, { recursive: true });
    await mkdir(outsideWorkspace, { recursive: true });
    await writeFile(join(outsideWorkspace, "secret.md"), "outside data");
    const info = await lstat(originalWorkspace);
    const child = {
      ...f.child,
      cwd: originalWorkspace,
      workspaceIdentity: {
        path: await realpath(originalWorkspace),
        dev: info.dev,
        ino: info.ino,
      },
    } as PreparedChild;
    await rename(scratchParent, savedParent);
    await symlink(outsideParent, scratchParent);

    await assert.rejects(collectArtifacts(child, f.results), /Workspace root changed/);

    assert.equal(await readFile(join(outsideWorkspace, "secret.md"), "utf8"), "outside data");
    assert.deepEqual(await readdir(f.results), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection omits files with external hard links", async () => {
  const f = await fixture();
  try {
    await link(f.secret, join(f.workspace, "linked.md"));

    const artifacts = await collectArtifacts(f.child, f.results);

    assert.deepEqual(artifacts.files, []);
    assert.deepEqual(artifacts.omitted, ["linked.md"]);
    assert.equal(await readFile(f.secret, "utf8"), "must not be copied");
    await assert.rejects(readFile(join(artifacts.directory, "linked.md")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection refuses a symlink as the requested destination parent", async () => {
  const f = await fixture();
  const outsideDirectory = join(f.root, "outside-directory"),
    report = join(f.workspace, "report.md");
  try {
    await mkdir(outsideDirectory);
    await writeFile(report, "workspace result");
    await rm(f.results, { recursive: true });
    await symlink(outsideDirectory, f.results);

    await assert.rejects(collectArtifacts(f.child, f.results), /Artifact destination parent/);

    assert.equal(await readFile(report, "utf8"), "workspace result");
    assert.deepEqual(await readdir(outsideDirectory), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection canonicalizes symlinked ancestors while creating a missing parent", async () => {
  const f = await fixture();
  const realParent = join(f.root, "real-parent"),
    parentAlias = join(f.root, "parent-alias"),
    requestedParent = join(parentAlias, "new-results");
  try {
    await mkdir(realParent);
    await symlink(realParent, parentAlias);
    await writeFile(join(f.workspace, "report.md"), "workspace result");

    const artifacts = await collectArtifacts(f.child, requestedParent);

    assert.equal(
      await realpath(artifacts.directory),
      join(await realpath(realParent), "new-results", artifacts.id),
    );
    assert.equal(
      await readFile(join(artifacts.directory, "report.md"), "utf8"),
      "workspace result",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection does not recurse into its destination through a symlinked parent", async () => {
  const f = await fixture();
  const workspaceAlias = join(f.root, "workspace-alias"),
    requestedParent = join(workspaceAlias, "collected");
  try {
    await writeFile(join(f.workspace, "report.md"), "workspace result");
    await symlink(f.workspace, workspaceAlias);

    const artifacts = await collectArtifacts(f.child, requestedParent);

    assert.deepEqual(artifacts.files, ["report.md"]);
    assert.equal(
      await realpath(artifacts.directory),
      join(await realpath(f.workspace), "collected", artifacts.id),
    );
    assert.equal(
      await readFile(join(artifacts.directory, "report.md"), "utf8"),
      "workspace result",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection skips its generated destination when the store is the workspace root", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "report.md"), "workspace result");

    const artifacts = await collectArtifacts(f.child, f.workspace);

    assert.deepEqual(artifacts.files, ["report.md"]);
    assert.deepEqual(artifacts.omitted, []);
    assert.equal(
      await readFile(join(artifacts.directory, "report.md"), "utf8"),
      "workspace result",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection fails closed when its generated destination collides with a symlink", async () => {
  const f = await fixture();
  const outsideDirectory = join(f.root, "outside-directory"),
    resultsRoot = await realpath(f.results);
  let collisionPath: string | undefined;
  const originalMkdir = fs.promises.mkdir;
  try {
    await mkdir(outsideDirectory);
    await writeFile(join(f.workspace, "report.md"), "workspace result");
    fs.promises.mkdir = (async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const [path] = args;
      if (!collisionPath && String(path).startsWith(`${resultsRoot}/`)) {
        collisionPath = String(path);
        await symlink(outsideDirectory, collisionPath);
      }
      return originalMkdir(...args);
    }) as typeof fs.promises.mkdir;
    syncBuiltinESMExports();

    await assert.rejects(collectArtifacts(f.child, f.results), { code: "EEXIST" });

    assert.ok(collisionPath);
    assert.equal(await readFile(join(f.workspace, "report.md"), "utf8"), "workspace result");
    assert.deepEqual(await readdir(outsideDirectory), []);
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("artifact collection opens result files exclusively without following destination symlinks", async () => {
  const f = await fixture();
  const resultsRoot = await realpath(f.results);
  let injectedPath: string | undefined;
  const originalOpen = fs.promises.open;
  try {
    await writeFile(join(f.workspace, "report.md"), "workspace result");
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const [path] = args;
      if (
        !injectedPath &&
        String(path).startsWith(`${resultsRoot}/`) &&
        String(path).endsWith("/report.md")
      ) {
        injectedPath = String(path);
        await symlink(f.secret, injectedPath);
      }
      return originalOpen(...args);
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();

    await assert.rejects(collectArtifacts(f.child, f.results), { code: "EEXIST" });

    assert.ok(injectedPath);
    assert.equal(await readFile(join(f.workspace, "report.md"), "utf8"), "workspace result");
    assert.equal(await readFile(f.secret, "utf8"), "must not be copied");
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("receipts distinguish scratch collection from project reference without tracking external effects", async () => {
  const f = await fixture();
  try {
    await writeFile(f.secret, "external effect");
    const scratch = await collectArtifacts(f.child, f.results);
    assert.equal(scratch.scope, "scratch-collection");
    assert.equal(scratch.externalEffects, "untracked");
    assert.equal(scratch.owned, true);
    assert.deepEqual(scratch.files, []);
    const project = await collectArtifacts({ ...f.child, workspaceKind: "project" }, f.results);
    assert.equal(project.scope, "project-reference");
    assert.equal(project.externalEffects, "untracked");
    assert.equal(project.owned, false);
    assert.equal(project.directory, f.workspace);
    assert.deepEqual(project.files, []);
    assert.equal(await readFile(f.secret, "utf8"), "external effect");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
