import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/context.ts";
import { catalogueInstructionId } from "./instruction-selection.ts";
import {
  chain,
  chosenInstructions,
  contextFilesDisabled,
  selectedLocalInstructions,
  unreadableLocalFiles,
  withLocalFiles,
} from "./local-context.ts";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const root = realpathSync(mkdtempSync(join(tmpdir(), "lc-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(root, { recursive: true, force: true });
});
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, content: text };
};
const initGit = (repo: string) => {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q"], { env: gitEnv, stdio: "ignore" });
};
const names = (files: { path: string }[]) => files.map((f) => f.path.slice(root.length + 1));

test("a local file follows its own directory's team file, at every level of the walk", () => {
  const repo = join(root, "a");
  const files = [put(join(repo, "AGENTS.md"), "team"), put(join(repo, "svc/AGENTS.md"), "svc")];
  put(join(repo, "AGENTS.local.md"), "mine");
  put(join(repo, "svc/AGENTS.local.md"), "svc mine");
  assert.deepEqual(names(withLocalFiles(files, join(repo, "svc"))), [
    "a/AGENTS.md",
    "a/AGENTS.local.md",
    "a/svc/AGENTS.md",
    "a/svc/AGENTS.local.md",
  ]);
  assert.equal(
    withLocalFiles(files, join(repo, "svc")).find((f) => f.path.endsWith("svc/AGENTS.local.md"))
      ?.content,
    "svc mine",
  );
});

test("a directory with only a local file still gets it, in walk order", () => {
  const repo = join(root, "b");
  const files = [put(join(repo, "AGENTS.md"), "team")];
  put(join(repo, "svc/AGENTS.local.md"), "only mine");
  assert.deepEqual(names(withLocalFiles(files, join(repo, "svc"))), [
    "b/AGENTS.md",
    "b/svc/AGENTS.local.md",
  ]);
});

test("files from outside the walk, such as the agent directory, stay first", () => {
  const repo = join(root, "c");
  const global = {
    path: join(realpathSync(mkdtempSync(join(tmpdir(), "lc-agent-"))), "AGENTS.md"),
    content: "global",
  };
  const files = [global, put(join(repo, "CLAUDE.md"), "team")];
  put(join(repo, "AGENTS.local.md"), "mine");
  const out = withLocalFiles(files, repo);
  assert.equal(out[0], global);
  assert.deepEqual(names(out.slice(1)), ["c/CLAUDE.md", "c/AGENTS.local.md"]);
});

test("it follows an override file and never duplicates a local file pi already loaded", () => {
  const repo = join(root, "d");
  const files = [put(join(repo, "AGENTS.override.md"), "replacement")];
  put(join(repo, "AGENTS.local.md"), "mine");
  const once = withLocalFiles(files, repo);
  assert.deepEqual(names(once), ["d/AGENTS.override.md", "d/AGENTS.local.md"]);
  assert.deepEqual(names(withLocalFiles(once, repo)), names(once));
});

test("nothing changes without local files", () => {
  const repo = join(root, "e");
  const files = [put(join(repo, "AGENTS.md"), "team")];
  assert.deepEqual(withLocalFiles(files, repo), files);
});

test("the walk runs from the filesystem root to cwd", () => {
  assert.deepEqual(chain("/a/b"), ["/", "/a", "/a/b"]);
});

test("a local file that is a directory, a pipe or unreadable is skipped and the others still load", () => {
  const repo = join(root, "h");
  const files = [
    put(join(repo, "AGENTS.md"), "team"),
    put(join(repo, "a/AGENTS.md"), "a"),
    put(join(repo, "a/b/AGENTS.md"), "b"),
  ];
  put(join(repo, "a/b/c/x"), "");
  mkdirSync(join(repo, "AGENTS.local.md"));
  put(join(repo, "a/b/AGENTS.local.md"), "kept");
  const deep = join(repo, "a/b/c");
  put(join(deep, "AGENTS.local.md"), "unreadable");
  const canRead = process.getuid?.() === 0;
  chmodSync(join(deep, "AGENTS.local.md"), 0o000);
  const out = withLocalFiles(files, deep);
  assert.deepEqual(
    names(out).filter((n) => n.endsWith("AGENTS.local.md")),
    ["h/a/b/AGENTS.local.md", ...(canRead ? ["h/a/b/c/AGENTS.local.md"] : [])],
  );
  const problems = unreadableLocalFiles(deep).map((f) => f.slice(root.length + 1));
  assert.ok(problems.includes("h/AGENTS.local.md"));
  chmodSync(join(deep, "AGENTS.local.md"), 0o644);
});

test("-nc and --no-context-files are recognised", () => {
  assert.equal(contextFilesDisabled(["node", "pi", "-nc"]), true);
  assert.equal(contextFilesDisabled(["node", "pi", "--no-context-files", "-p"]), true);
  assert.equal(contextFilesDisabled(["node", "pi", "-p", "hello"]), false);
});

test("a named pipe as the local file is skipped without blocking", () => {
  const repo = join(root, "j");
  mkdirSync(repo, { recursive: true });
  try {
    execFileSync("mkfifo", [join(repo, "AGENTS.local.md")]);
  } catch {
    return;
  }
  const lib = new URL("./local-context.ts", import.meta.url).href;
  const script = `import { withLocalFiles, unreadableLocalFiles } from ${JSON.stringify(lib)}; console.log(withLocalFiles([], process.argv[1]).length, unreadableLocalFiles(process.argv[1]).length);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, repo], {
    timeout: 5000,
    encoding: "utf8",
  });
  assert.equal(out.trim(), "0 1");
});

test("a nested linked worktree skips the main checkout's local file, as pi skips its AGENTS.md", () => {
  const git = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      env: gitEnv,
      stdio: "ignore",
    });
  const main = join(mkdtempSync(join(tmpdir(), "lc-wt-")), "main");
  mkdirSync(main);
  git(main, "init", "-q");
  put(join(main, "AGENTS.md"), "team");
  git(main, "add", "AGENTS.md");
  git(main, "commit", "-q", "-m", "team");
  const wt = join(main, ".claude/worktrees/w");
  git(main, "worktree", "add", "-q", "--detach", wt);
  put(join(main, "AGENTS.local.md"), "main mine");
  const paths = (files: { path: string }[]) => files.map((f) => f.path);
  const shadowing = [{ path: join(wt, "AGENTS.md"), content: "team" }];
  assert.deepEqual(paths(withLocalFiles(shadowing, wt)), [join(wt, "AGENTS.md")]);
  put(join(wt, "AGENTS.local.md"), "worktree mine");
  assert.deepEqual(paths(withLocalFiles(shadowing, wt)), [
    join(wt, "AGENTS.md"),
    join(wt, "AGENTS.local.md"),
  ]);
  rmSync(join(wt, "AGENTS.md"));
  const inherited = [{ path: join(main, "AGENTS.md"), content: "team" }];
  assert.deepEqual(paths(withLocalFiles(inherited, wt)), [
    join(main, "AGENTS.md"),
    join(main, "AGENTS.local.md"),
    join(wt, "AGENTS.local.md"),
  ]);
});

test("a local file reached twice through an internal repository symlink loads once", () => {
  const repo = join(root, "o");
  initGit(repo);
  put(join(repo, "AGENTS.local.md"), "mine");
  mkdirSync(join(repo, "svc"));
  symlinkSync("../AGENTS.local.md", join(repo, "svc/AGENTS.local.md"));
  assert.deepEqual(names(withLocalFiles([], join(repo, "svc"))), ["o/AGENTS.local.md"]);
});

test("external symlinks are skipped while internal Git-root symlinks remain readable", () => {
  const repo = join(root, "symlink-boundary");
  const outside = put(join(root, "outside-context.md"), "outside secret");
  initGit(repo);
  put(join(repo, "AGENTS.local.md"), "inside context");
  mkdirSync(join(repo, "nested"), { recursive: true });
  symlinkSync(outside.path, join(repo, "nested/AGENTS.local.md"));
  put(join(repo, ".agents/instructions/internal.md"), "inside instruction");
  symlinkSync(outside.path, join(repo, ".agents/instructions/external.md"));

  const files = withLocalFiles([], join(repo, "nested"));
  assert.deepEqual(
    files.map((file) => file.content),
    ["inside context"],
  );
  assert.deepEqual(
    selectedLocalInstructions(join(repo, "nested"), undefined).map((file) => file.content),
    ["inside instruction"],
  );
  assert.deepEqual(unreadableLocalFiles(join(repo, "nested")), [
    join(repo, "nested/AGENTS.local.md"),
  ]);

  const redirected = join(root, "redirected-instructions");
  const externalFolder = join(root, "external-instructions");
  initGit(redirected);
  put(join(externalFolder, "rule.md"), "outside instruction");
  mkdirSync(join(redirected, ".agents"), { recursive: true });
  symlinkSync(externalFolder, join(redirected, ".agents/instructions"), "dir");
  assert.deepEqual(chosenInstructions(redirected), []);
});

test("non-Git ancestor context loads independently of current-directory instructions", () => {
  const parent = join(root, "non-git-ancestor");
  const cwd = join(parent, "nested/project");
  const outside = put(join(root, "non-git-outside.md"), "outside instruction");
  put(join(parent, "AGENTS.local.md"), "ancestor context");
  put(join(parent, ".agents/instructions/ancestor.md"), "ancestor instruction");
  put(join(parent, "nested/AGENTS.local.md"), "nested context");
  mkdirSync(join(cwd, ".agents/instructions"), { recursive: true });
  symlinkSync(outside.path, join(cwd, ".agents/instructions/outside.md"));

  assert.deepEqual(
    withLocalFiles([], cwd).map((file) => file.content),
    ["ancestor context", "nested context"],
  );
  assert.deepEqual(
    selectedLocalInstructions(cwd, undefined).map((file) => file.content),
    [],
  );
});

test("multiply-linked eager context files are rejected", () => {
  const repo = join(root, "hardlink-boundary");
  const shared = put(join(root, "shared-hardlink.md"), "shared secret");
  initGit(repo);
  linkSync(shared.path, join(repo, "AGENTS.local.md"));
  mkdirSync(join(repo, ".agents/instructions"), { recursive: true });
  linkSync(shared.path, join(repo, ".agents/instructions/shared.md"));

  assert.deepEqual(withLocalFiles([], repo), []);
  assert.deepEqual(unreadableLocalFiles(repo), [join(repo, "AGENTS.local.md")]);
  assert.deepEqual(chosenInstructions(repo), []);
});

test("home-level resources may link within home but not outside it", () => {
  const home = join(root, "test-home");
  const outside = put(join(root, "outside-home.md"), "outside secret");
  const originalHome = process.env.HOME;
  mkdirSync(join(home, ".agents/instructions"), { recursive: true });
  put(join(home, "shared.md"), "home resource");
  symlinkSync("shared.md", join(home, "AGENTS.local.md"));
  symlinkSync("../../shared.md", join(home, ".agents/instructions/home.md"));
  symlinkSync(outside.path, join(home, ".agents/instructions/outside.md"));
  process.env.HOME = home;
  try {
    assert.deepEqual(
      withLocalFiles([], home).map((file) => file.content),
      ["home resource"],
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("a dangling or looping symlink as the local file is reported as unreadable", () => {
  const repo = join(root, "p");
  mkdirSync(join(repo, "loop"), { recursive: true });
  symlinkSync("missing.md", join(repo, "AGENTS.local.md"));
  symlinkSync("AGENTS.local.md", join(repo, "loop/AGENTS.local.md"));
  assert.deepEqual(withLocalFiles([], join(repo, "loop")), []);
  assert.deepEqual(names(unreadableLocalFiles(join(repo, "loop")).map((path) => ({ path }))), [
    "p/AGENTS.local.md",
    "p/loop/AGENTS.local.md",
  ]);
});

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
const register = () => {
  const handlers: Record<string, Handler> = {};
  extension({
    on: (name: string, handler: Handler) => {
      const previous = handlers[name];
      handlers[name] = async (event, ctx) => {
        await previous?.(event, ctx);
        await handler(event, ctx);
      };
    },
    registerCommand: () => {},
    registerTool: () => {},
    getCommands: () => [],
    events: { on() {}, emit() {} },
  } as never);
  return handlers;
};

test("a session without a UI snapshots defaults without interactive notices", async () => {
  let cwdReads = 0,
    notices = 0;
  const ctx = {
    hasUI: false,
    isProjectTrusted: () => true,
    get cwd() {
      cwdReads++;
      return root;
    },
    ui: { notify: () => notices++ },
  };
  await register().session_start({ type: "session_start", reason: "startup" }, ctx);
  assert(cwdReads > 0, "startup still captures the global default selection");
  assert.equal(notices, 0);
});

test("relative paths keep the team context before its local overlay", () => {
  const repo = join(root, "relative-context");
  put(join(repo, "AGENTS.local.md"), "personal");
  const team = { path: "AGENTS.md", content: "team" };
  assert.deepEqual(
    withLocalFiles([team], repo).map((file) => file.content),
    ["team", "personal"],
  );
});

test("existing context entries are preserved even when they alias the same file", () => {
  const repo = join(root, "existing-alias-context");
  const team = put(join(repo, "AGENTS.md"), "team");
  const alias = { ...team, content: "other extension's content" };
  assert.deepEqual(withLocalFiles([team, alias], repo), [team, alias]);
});

test("a relative cwd completes the context walk", () => {
  assert.deepEqual(chain("."), chain(process.cwd()));
});

test("a symlink spelling of the team directory retains overlay order", () => {
  const repo = join(root, "team-directory-alias");
  const team = put(join(repo, "AGENTS.md"), "team");
  put(join(repo, "AGENTS.local.md"), "personal");
  const alias = join(root, "team-directory-link");
  symlinkSync(repo, alias);
  assert.deepEqual(
    withLocalFiles([team], alias).map((file) => file.content),
    ["team", "personal"],
  );
});

test("FIFO worktree metadata cannot block context loading", () => {
  const repo = join(root, "fifo-worktree-metadata");
  const metadata = join(root, "fifo-worktree-gitdir");
  put(join(metadata, "HEAD"), "ref: refs/heads/main");
  put(join(repo, ".git"), `gitdir: ${metadata}\n`);
  execFileSync("mkfifo", [join(metadata, "commondir")]);
  const lib = new URL("./local-context.ts", import.meta.url).href;
  const script = `import { withLocalFiles } from ${JSON.stringify(lib)}; console.log(withLocalFiles([], process.argv[1]).length);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, repo], {
    timeout: 5000,
    encoding: "utf8",
  });
  assert.equal(out.trim(), "0");
});

test("selected behavioral instructions follow walk and filename order separately from project context", () => {
  const repo = join(root, "selected");
  initGit(repo);
  const files = [
    put(join(repo, "AGENTS.md"), "team"),
    put(join(repo, "svc/AGENTS.md"), "child team"),
  ];
  put(join(repo, "AGENTS.local.md"), "personal");
  put(join(repo, ".agents/instructions/z.local.md"), "rule z");
  put(join(repo, ".agents/instructions/a.local.md"), "rule a");
  put(join(repo, ".agents/instructions/notes.txt"), "ignored");
  put(join(repo, "svc/.agents/instructions/child.md"), "child rule");
  const out = withLocalFiles(files, join(repo, "svc"));
  assert.deepEqual(
    out.map((file) => file.content),
    ["team", "personal", "child team"],
  );
  assert.deepEqual(withLocalFiles(out, join(repo, "svc")), out);
  assert.deepEqual(
    selectedLocalInstructions(join(repo, "svc"), undefined).map((file) => file.content),
    ["rule a", "rule z", "child rule"],
  );
  assert.deepEqual(chosenInstructions(join(repo, "missing")), []);
});

test("an explicit instruction selection filters snippets but keeps team and local context", () => {
  const repo = join(root, "selected-only");
  initGit(repo);
  const team = put(join(repo, "AGENTS.md"), "TEAM");
  put(join(repo, "AGENTS.local.md"), "LOCAL");
  const keep = put(join(repo, ".agents/instructions/keep.md"), "KEEP");
  put(join(repo, ".agents/instructions/drop.md"), "DROP");
  const result = withLocalFiles([team], repo);
  assert.deepEqual(selectedLocalInstructions(repo, [`local:${relative(repo, keep.path)}`]), [keep]);
  assert.deepEqual(
    result.map((file) => file.content),
    ["TEAM", "LOCAL"],
  );
});

test("selected symlinks deduplicate against native, local and other selected files", () => {
  const repo = join(root, "selected-aliases");
  initGit(repo);
  const team = put(join(repo, "AGENTS.md"), "team");
  put(join(repo, "AGENTS.local.md"), "personal");
  const chosen = put(join(repo, ".agents/instructions/a.md"), "selected");
  symlinkSync("../../AGENTS.md", join(repo, ".agents/instructions/b.md"));
  symlinkSync("../../AGENTS.local.md", join(repo, ".agents/instructions/c.md"));
  symlinkSync("a.md", join(repo, ".agents/instructions/d.md"));
  put(join(repo, "svc/placeholder"), "");
  mkdirSync(join(repo, "svc/.agents/instructions"), { recursive: true });
  symlinkSync(chosen.path, join(repo, "svc/.agents/instructions/a.md"));
  assert.deepEqual(
    withLocalFiles([team], join(repo, "svc")).map((file) => file.content),
    ["team", "personal"],
  );
  const context = withLocalFiles([team], join(repo, "svc"));
  assert.deepEqual(
    selectedLocalInstructions(
      join(repo, "svc"),
      undefined,
      context.map((file) => file.path),
    ).map((file) => file.content),
    ["selected"],
  );
});

test("a directory reached through a recursive symlink keeps existing context entries exactly once", () => {
  const repo = join(root, "selected-directory-alias");
  const team = put(join(repo, "AGENTS.md"), "team");
  put(join(repo, "AGENTS.local.md"), "personal");
  put(join(repo, ".agents/instructions/rule.md"), "selected");
  symlinkSync(".", join(repo, "self"));
  const out = withLocalFiles(
    [team, { ...team, content: "other native entry" }],
    join(repo, "self"),
  );
  assert.deepEqual(
    out.map((file) => file.content),
    ["team", "other native entry", "personal"],
  );
});

test("selected directories, dangling links and pipes are skipped without blocking", () => {
  const repo = join(root, "selected-unreadable");
  const selected = join(repo, ".agents/instructions");
  mkdirSync(join(selected, "directory.md"), { recursive: true });
  symlinkSync("missing", join(selected, "dangling.md"));
  execFileSync("mkfifo", [join(selected, "pipe.md")]);
  put(join(selected, "readable.md"), "rule");
  assert.deepEqual(
    chosenInstructions(repo).map((file) => file.content),
    ["rule"],
  );
});

test("nested worktree selected instructions follow native context shadowing", () => {
  const main = join(root, "selected-worktree");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        main,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        ...args,
      ],
      { env: gitEnv, stdio: "ignore" },
    );
  put(join(main, "AGENTS.md"), "team");
  git("init", "-q");
  git("add", "AGENTS.md");
  git("commit", "-qm", "team");
  put(join(main, ".agents/instructions/main.md"), "main rule");
  const wt = join(main, "wt");
  git("worktree", "add", "-q", "--detach", wt);
  put(join(wt, ".agents/instructions/worktree.md"), "worktree rule");
  assert.deepEqual(
    withLocalFiles([{ path: join(wt, "AGENTS.md"), content: "team" }], wt).map(
      (file) => file.content,
    ),
    ["team"],
  );
  assert.deepEqual(
    selectedLocalInstructions(wt, undefined).map((file) => file.content),
    ["worktree rule"],
  );
  rmSync(join(wt, "AGENTS.md"));
  assert.deepEqual(
    withLocalFiles([{ path: join(main, "AGENTS.md"), content: "team" }], wt).map(
      (file) => file.content,
    ),
    ["team"],
  );
  assert.deepEqual(
    selectedLocalInstructions(wt, undefined).map((file) => file.content),
    ["worktree rule"],
  );
});

test("the hook strips native and selected eager context without mutating input entries", async () => {
  const repo = join(root, "strip-all");
  const global = {
    path: join(root, "other-agent/AGENTS.md"),
    content: "---\nnotes: global secret\n---\nGLOBAL\n<!-- global comment -->",
  };
  const team = put(join(repo, "AGENTS.md"), "---\nnotes: team secret\n---\nTEAM");
  put(
    join(repo, ".agents/instructions/rule.md"),
    "---\nnotes: rule secret\n---\nRULE\n<!-- rule comment -->",
  );
  put(join(root, "agent/settings.json"), JSON.stringify({ localContext: { instructions: {} } }));
  put(
    join(repo, ".pi/settings.json"),
    JSON.stringify({
      localContext: { instructions: { "local:.agents/instructions/rule.md": true } },
    }),
  );
  const options = {
    cwd: repo,
    contextFiles: [global, team],
    sections: {} as Record<string, string>,
  };
  const handlers = register();
  const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true };
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  await handlers.before_agent_start({ systemPromptOptions: options }, ctx);
  assert.deepEqual(
    options.contextFiles.map((file) => file.content),
    ["GLOBAL\n<!-- global comment -->", "TEAM"],
  );
  assert.match(options.sections.instructions, /RULE\n<!-- rule comment -->/);
  assert.doesNotMatch(options.sections.instructions, /rule secret|GLOBAL|TEAM/);
  assert.equal(global.content.includes("global secret"), true);
  assert.equal(team.content.includes("team secret"), true);
});

test("untrusted projects load neither project overrides nor project-local instruction files", async () => {
  const repo = join(root, "untrusted-instruction-selection");
  initGit(repo);
  put(join(repo, ".agents/instructions/rule.md"), "---\nnotes: hidden\n---\nRULE");
  put(join(repo, ".pi/settings.json"), JSON.stringify({ localContext: { instructions: {} } }));
  const options = { cwd: repo, contextFiles: [] as { path: string; content: string }[] };
  await register().before_agent_start(
    { systemPromptOptions: options },
    { isProjectTrusted: () => false },
  );
  assert.deepEqual(
    options.contextFiles.map((file) => file.content),
    [],
  );
});

test("the prompt hook keeps native, local and snippet sources before catalogue aliases", async () => {
  const repo = join(root, "combined-catalogues");
  initGit(repo);
  const agentDir = join(root, "combined-catalogue-agent");
  const team = put(join(repo, "AGENTS.md"), "TEAM ON DISK");
  const personal = put(join(repo, "AGENTS.local.md"), "PERSONAL");
  const snippet = put(join(repo, ".agents/instructions/a.md"), "SAME BODY");
  const first = join(repo, "catalogue-one");
  const second = join(repo, "catalogue-two");
  const aliasRoot = join(repo, "catalogue-alias");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, aliasRoot);
  symlinkSync(team.path, join(first, "a-team.md"));
  symlinkSync(personal.path, join(first, "b-personal.md"));
  symlinkSync(snippet.path, join(first, "c-snippet.md"));
  const catalogueFile = put(join(first, "d-first.md"), "FIRST CATALOGUE");
  const distinct = put(join(first, "e-distinct.md"), "SAME BODY");
  symlinkSync(catalogueFile.path, join(second, "a-repeat.md"));
  symlinkSync(catalogueFile.path, join(second, "b-repeat.md"));
  put(
    join(repo, "package.json"),
    JSON.stringify({
      name: "combined-guidance",
      pi: { instructions: ["./catalogue-one", "./catalogue-two", "./catalogue-alias"] },
    }),
  );
  const selected = [
    "local:.agents/instructions/a.md",
    ...["a-team.md", "b-personal.md", "c-snippet.md", "d-first.md", "e-distinct.md"].map((name) =>
      catalogueInstructionId(first, name),
    ),
    ...["a-repeat.md", "b-repeat.md"].map((name) => catalogueInstructionId(second, name)),
  ];
  put(join(agentDir, "settings.json"), JSON.stringify({ packages: [repo] }));
  put(
    join(repo, ".pi/settings.json"),
    JSON.stringify({
      localContext: { instructions: Object.fromEntries(selected.map((id) => [id, true])) },
    }),
  );
  const loader = new DefaultResourceLoader({
    cwd: repo,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  const native = loader.getAgentsFiles().agentsFiles.find((file) => file.path === team.path)!;
  assert.equal(native.content, "TEAM ON DISK");
  // A host can supply a relative source path and different content; additions must not replace it.
  const hostEntry = { path: "AGENTS.md", content: "TEAM FROM HOST" };
  const options = { cwd: repo, contextFiles: [hostEntry], sections: {} as Record<string, string> };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = register();
    const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true };
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ systemPromptOptions: options }, ctx);
    assert.deepEqual(options.contextFiles, [hostEntry, personal]);
    assert.equal(
      options.sections.instructions,
      [snippet, catalogueFile, distinct]
        .map(({ path, content }) => `<instruction path="${path}">\n${content}\n</instruction>`)
        .join("\n\n"),
    );
    assert.equal(hostEntry.content, "TEAM FROM HOST");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("catalogue merging preserves existing host entries that intentionally share a source", async () => {
  const repo = join(root, "host-context-aliases");
  initGit(repo);
  const agentDir = join(root, "host-context-agent");
  const team = put(join(repo, "AGENTS.md"), "TEAM ON DISK");
  const catalogue = join(repo, "catalogue");
  mkdirSync(catalogue);
  symlinkSync(team.path, join(catalogue, "team.md"));
  put(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [repo],
      localContext: { instructions: { [catalogueInstructionId(catalogue, "team.md")]: true } },
    }),
  );
  put(
    join(repo, "package.json"),
    JSON.stringify({ name: "host-guidance", pi: { instructions: ["./catalogue"] } }),
  );
  const hostEntries = [team, { path: team.path, content: "OTHER HOST CONTEXT" }];
  const options = { cwd: repo, contextFiles: hostEntries };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = register();
    const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true };
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ systemPromptOptions: options }, ctx);
    assert.deepEqual(options.contextFiles, hostEntries);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("registered pack instructions are opt-in, preserve caller guidance, reread bodies and obey project trust", async () => {
  const ns = "resources";
  const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(
    new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  );
  const repo = join(root, "pack-instructions"),
    packs = join(root, "registered-packs"),
    pack = join(packs, "sample");
  initGit(repo);
  const source = put(
    join(pack, ns, "instructions/rule.md"),
    "---\nnotes: HUMAN_ONLY\n---\n# Guidance\nPACK_RULE_ONE\n",
  );
  put(
    join(pack, "package.json"),
    JSON.stringify({
      name: "sample",
      pi: { extensions: [], skills: [], instructions: [`./${ns}/instructions`] },
    }),
  );
  const id = catalogueInstructionId(dirname(source.path), "rule.md");
  put(join(root, "agent/settings.json"), JSON.stringify({ packages: [pack] }));
  const handlers = register(),
    ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true };
  await handlers.session_start({}, ctx);
  const turn = async (trusted = true) => {
    const options = normalizeBuildSystemPromptOptions({
      cwd: repo,
      contextFiles: [{ path: join(repo, "AGENTS.md"), content: "PROJECT_CONTEXT" }],
      sections: { instructions: "CALLER_GUIDANCE" },
    });
    await handlers.before_agent_start(
      { systemPromptOptions: options },
      { ...ctx, isProjectTrusted: () => trusted },
    );
    return { options, prompt: buildSystemPrompt(options) };
  };
  const before = await turn();
  assert.doesNotMatch(before.prompt, /PACK_RULE_ONE/);
  assert.match(before.prompt, /CALLER_GUIDANCE/);
  put(
    join(repo, ".pi/settings.json"),
    JSON.stringify({ localContext: { instructions: { [id]: true } } }),
  );
  const selected = await turn();
  assert.match(selected.prompt, /<instructions>[\s\S]*CALLER_GUIDANCE[\s\S]*PACK_RULE_ONE/);
  assert.doesNotMatch(selected.prompt, /HUMAN_ONLY/);
  assert.equal((selected.prompt.match(/PACK_RULE_ONE/g) ?? []).length, 1);
  assert.match(selected.prompt, /<project_context>[\s\S]*PROJECT_CONTEXT/);
  assert.equal(
    (await turn()).prompt,
    selected.prompt,
    "unchanged resources retain identical prompt content",
  );
  put(source.path, "---\nnotes: HUMAN_ONLY\n---\n# Guidance\nPACK_RULE_TWO\n");
  const edited = await turn();
  assert.match(edited.prompt, /PACK_RULE_TWO/);
  assert.doesNotMatch(edited.prompt, /PACK_RULE_ONE/);
  assert.doesNotMatch(
    (await turn(false)).prompt,
    /PACK_RULE_TWO/,
    "untrusted project selection is ignored",
  );
  put(join(repo, ".pi/settings.json"), JSON.stringify({ localContext: { instructions: {} } }));
  const disabled = await turn();
  assert.doesNotMatch(disabled.prompt, /PACK_RULE_TWO/);
  assert.match(disabled.prompt, /CALLER_GUIDANCE/);
});

test("the prompt hook resolves sparse instruction maps against implicit local defaults", async () => {
  const repo = join(root, "sparse-instruction-hook");
  initGit(repo);
  put(join(repo, ".agents/instructions/a.md"), "LOCAL_A");
  put(join(repo, ".agents/instructions/b.md"), "LOCAL_B");
  const dormantRoot = join(repo, "unregistered-instructions");
  put(join(dormantRoot, "rule.md"), "DORMANT_RULE");
  const dormantId = catalogueInstructionId(dormantRoot, "rule.md");
  put(
    join(repo, ".pi/settings.json"),
    JSON.stringify({
      localContext: {
        instructions: { "local:.agents/instructions/a.md": false, [dormantId]: true },
      },
    }),
  );
  put(join(root, "agent/settings.json"), JSON.stringify({ localContext: { instructions: {} } }));
  const handlers = register();
  const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true };
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const options = { cwd: repo, contextFiles: [], sections: {} as Record<string, string> };
  await handlers.before_agent_start({ systemPromptOptions: options }, ctx);
  assert.match(options.sections.instructions, /LOCAL_B/);
  assert.doesNotMatch(options.sections.instructions, /LOCAL_A|DORMANT_RULE/);
});

test("project instruction discovery excludes home and ancestor snippets outside its Git root", () => {
  const home = join(root, "instruction-home");
  const project = join(home, "projects/repo");
  const cwd = join(project, "src");
  const previousHome = process.env.HOME;
  initGit(project);
  put(join(home, ".agents/instructions/home.md"), "HOME_GUIDANCE");
  put(join(home, "projects/.agents/instructions/ancestor.md"), "ANCESTOR_GUIDANCE");
  put(join(project, ".agents/instructions/project.md"), "PROJECT_GUIDANCE");
  put(join(cwd, ".agents/instructions/child.md"), "CHILD_GUIDANCE");
  process.env.HOME = home;
  try {
    assert.deepEqual(
      selectedLocalInstructions(cwd, undefined).map((file) => file.content),
      ["PROJECT_GUIDANCE", "CHILD_GUIDANCE"],
    );
    assert.deepEqual(selectedLocalInstructions(home, undefined), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("without Git, instruction discovery is limited to the current directory", () => {
  const project = join(root, "standalone-instructions");
  const cwd = join(project, "nested");
  put(join(project, ".agents/instructions/ancestor.md"), "ANCESTOR_GUIDANCE");
  put(join(cwd, ".agents/instructions/current.md"), "CURRENT_GUIDANCE");
  assert.deepEqual(
    selectedLocalInstructions(cwd, undefined).map((file) => file.content),
    ["CURRENT_GUIDANCE"],
  );
});
