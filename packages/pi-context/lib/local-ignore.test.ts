import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoGitIgnoreEnabled, ignoreLocalFiles } from "./local-ignore.ts";
import { localFiles } from "./local-context.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "local-ignore-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(dir: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, ...args],
    { env, encoding: "utf8" },
  ).trim();
}
function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "AGENTS.local.md"), "personal");
  return dir;
}
const file = (dir: string) => join(dir, "AGENTS.local.md");
const exclude = (dir: string) => join(dir, ".git/info/exclude");

test("automatic ignore is opt-in in user settings only", () => {
  for (const value of [
    undefined,
    "bad",
    "null",
    "[]",
    '"true"',
    '{"localContext":true}',
    '{"localContext":{"autoGitIgnore":"true"}}',
    '{"localContext":{"autoGitIgnore":false}}',
  ]) {
    assert.equal(
      autoGitIgnoreEnabled(root, () => {
        if (value === undefined) throw new Error("missing");
        return value;
      }),
      false,
    );
  }
  assert.equal(
    autoGitIgnoreEnabled(root, () => '{"localContext":{"autoGitIgnore":true}}'),
    true,
  );
});

test("adds a personal exclude idempotently preserving comments and final newline", () => {
  const dir = repo("append");
  writeFileSync(exclude(dir), "# mine\r\nother");
  assert.equal(ignoreLocalFiles([file(dir)], env)[0].status, "added");
  assert.equal(readFileSync(exclude(dir), "utf8"), "# mine\r\nother\nAGENTS.local.md\n");
  assert.equal(ignoreLocalFiles([file(dir)], env)[0].status, "already-ignored");
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("ignored and tracked files are preserved; existing negated rule is not repeatedly appended", () => {
  const ignored = repo("ignored");
  writeFileSync(join(ignored, ".gitignore"), "AGENTS.local.md\n");
  const before = readFileSync(exclude(ignored), "utf8");
  assert.equal(ignoreLocalFiles([file(ignored)], env)[0].status, "already-ignored");
  assert.equal(readFileSync(exclude(ignored), "utf8"), before);
  const tracked = repo("tracked");
  git(tracked, "add", "AGENTS.local.md");
  const index = git(tracked, "ls-files", "-s");
  assert.equal(ignoreLocalFiles([file(tracked)], env)[0].status, "tracked");
  assert.equal(git(tracked, "ls-files", "-s"), index);
  const negative = repo("negative");
  writeFileSync(join(negative, ".gitignore"), "!AGENTS.local.md\n");
  writeFileSync(exclude(negative), "AGENTS.local.md\n");
  assert.equal(ignoreLocalFiles([file(negative)], env)[0].status, "already-present");
  assert.equal(readFileSync(exclude(negative), "utf8"), "AGENTS.local.md\n");
});

test("linked worktree uses common personal exclude and respects shadowed checkout", () => {
  const main = repo("main");
  writeFileSync(join(main, "AGENTS.md"), "team");
  git(main, "-c", "user.name=test", "-c", "user.email=test@example.test", "add", "AGENTS.md");
  git(
    main,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "initial",
  );
  const wt = join(main, "wt");
  git(main, "worktree", "add", "--detach", wt, "HEAD");
  writeFileSync(file(wt), "worktree personal");
  const locals = localFiles(wt).map((f) => f.path);
  assert.deepEqual(locals, [file(wt)]);
  assert.equal(ignoreLocalFiles(locals, env)[0].status, "added");
  assert.equal(readFileSync(exclude(main), "utf8").split("AGENTS.local.md").length - 1, 1);
  assert.equal(git(wt, "check-ignore", "AGENTS.local.md"), "AGENTS.local.md");
});

test("outside Git and unavailable Git produce no writes", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  writeFileSync(file(plain), "personal");
  assert.equal(ignoreLocalFiles([file(plain)], env)[0].status, "outside-git");
  const dir = repo("missing-git");
  const before = readFileSync(exclude(dir), "utf8");
  assert.equal(ignoreLocalFiles([file(dir)], { ...env, PATH: "" })[0].status, "unknown");
  assert.equal(readFileSync(exclude(dir), "utf8"), before);
});

test("symlink and hardlink excludes cannot redirect a write", () => {
  for (const kind of ["symlink", "hardlink", "directory"]) {
    const dir = repo(kind);
    rmSync(exclude(dir));
    const victim = join(root, kind + "-victim");
    writeFileSync(victim, "untouched");
    if (kind === "symlink") symlinkSync(victim, exclude(dir));
    if (kind === "hardlink") linkSync(victim, exclude(dir));
    if (kind === "directory") mkdirSync(exclude(dir));
    assert.equal(ignoreLocalFiles([file(dir)], env)[0].status, "refused");
    assert.equal(readFileSync(victim, "utf8"), "untouched");
  }
  const dir = repo("info-symlink"),
    victim = join(root, "info-victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "exclude"), "untouched");
  rmSync(join(dir, ".git/info"), { recursive: true });
  symlinkSync(victim, join(dir, ".git/info"));
  assert.equal(ignoreLocalFiles([file(dir)], env)[0].status, "refused");
  assert.equal(readFileSync(join(victim, "exclude"), "utf8"), "untouched");
});

test("FIFO exclude refuses without blocking", () => {
  const dir = repo("fifo");
  rmSync(exclude(dir));
  execFileSync("mkfifo", [exclude(dir)]);
  const lib = new URL("./local-ignore.ts", import.meta.url).href;
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {ignoreLocalFiles} from ${JSON.stringify(lib)};console.log(ignoreLocalFiles([process.argv[1]]));`,
      file(dir),
    ],
    { timeout: 4000, encoding: "utf8", env },
  );
  assert.match(out, /refused/);
});

test("repository hooks, fsmonitor, core.excludesFile and inherited Git routing cannot redirect or execute", () => {
  const dir = repo("hostile"),
    other = repo("other");
  const victim = join(root, "global-victim"),
    marker = join(root, "hook-ran"),
    hook = join(root, "hook");
  writeFileSync(victim, "untouched");
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(hook, 0o755);
  git(dir, "config", "core.fsmonitor", hook);
  git(dir, "config", "core.hooksPath", root);
  git(dir, "config", "core.excludesFile", victim);
  const before = readFileSync(exclude(other), "utf8");
  assert.equal(
    ignoreLocalFiles([file(dir)], {
      ...env,
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: hook,
    })[0].status,
    "added",
  );
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.equal(readFileSync(exclude(other), "utf8"), before);
  assert.equal(existsSync(marker), false);
});

test("a forged .git pointer cannot write to another repository's personal exclude", () => {
  const other = repo("redirect-target"),
    project = join(root, "redirect-source");
  mkdirSync(project);
  writeFileSync(join(project, ".git"), `gitdir: ${join(other, ".git")}\n`);
  writeFileSync(file(project), "personal");
  const before = readFileSync(exclude(other), "utf8");
  assert.equal(
    ignoreLocalFiles([file(project)], env, (repository) => repository === project)[0].status,
    "refused",
  );
  assert.equal(readFileSync(exclude(other), "utf8"), before);
});

test("a symlinked project .git cannot borrow another linked worktree's registration", () => {
  const main = repo("linked-redirect-main");
  writeFileSync(join(main, "README.md"), "team");
  git(main, "add", "README.md");
  git(main, "-c", "user.name=test", "-c", "user.email=t@example.test", "commit", "-qm", "initial");
  const worktree = join(root, "linked-redirect-wt");
  git(main, "worktree", "add", "--detach", worktree, "HEAD");
  const project = join(root, "linked-redirect-project");
  mkdirSync(project);
  symlinkSync(join(worktree, ".git"), join(project, ".git"));
  writeFileSync(file(project), "personal");
  const before = readFileSync(exclude(main), "utf8");
  assert.equal(ignoreLocalFiles([file(project)], env)[0].status, "refused");
  assert.equal(readFileSync(exclude(main), "utf8"), before);
});

test("a registered relative-path worktree can use its common exclude", () => {
  const main = repo("relative-main");
  writeFileSync(join(main, "README.md"), "team");
  git(main, "add", "README.md");
  git(main, "-c", "user.name=test", "-c", "user.email=t@example.test", "commit", "-qm", "initial");
  const worktree = join(root, "relative-worktree");
  git(main, "worktree", "add", "--relative-paths", "--detach", worktree, "HEAD");
  writeFileSync(file(worktree), "local");
  assert.equal(ignoreLocalFiles([file(worktree)], env)[0].status, "added");
});
