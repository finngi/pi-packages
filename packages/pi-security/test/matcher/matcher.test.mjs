import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBash, decideBash, validateMatch } from "../../src/matcher.ts";
const loaded = {
  project: "/tmp/project",
  filesystem: {
    readDeny: ["/tmp/private"],
    writeAllow: ["/tmp/project"],
    writeDeny: ["/tmp/project/.pi"],
  },
  policy: {
    env: { assignAllow: ["CI"] },
    deny: [
      { id: "rm", tool: "bash", match: { program: "rm" } },
      { id: "git-push", tool: "bash", match: { program: "git", subcommand: "push" } },
      { id: "cat-secret", tool: "bash", match: { program: "cat", "args-contain": "secret" } },
    ],
    allow: [
      {
        id: "echo",
        tool: "bash",
        permissions: { write: false, network: [] },
        match: { program: "echo" },
      },
      {
        id: "cat",
        tool: "bash",
        permissions: { write: false, network: [] },
        match: { program: "cat" },
      },
      {
        id: "git",
        tool: "bash",
        permissions: { write: false, network: [] },
        match: { program: "git", subcommand: "status" },
      },
      {
        id: "npm",
        tool: "bash",
        permissions: { write: true, network: [] },
        match: { program: "npm", subcommand: "test" },
      },
      {
        id: "shell",
        tool: "bash",
        permissions: { write: false, network: [] },
        match: { program: ["sh", "bash"], subcommand: "-c" },
      },
    ],
  },
};
for (const [command, verdict, cls] of [
  ["git status && npm test", "allow", true],
  ['echo "a b"', "allow", false],
  ["echo '$(rm x)'", "allow", false],
  ['echo "café"', "allow", false],
  ["echo café", "ask"],
  ["echo {rm,-rf,x}", "ask"],
  ["{rm,-rf,x}", "ask"],
  ["echo *.js", "ask"],
  ["echo $HOME", "ask"],
  ["echo $(rm x)", "deny"],
  ['echo "$(/bin/sudo true)"', "deny"],
  ["echo `rm x`", "deny"],
  ["cat <(rm x)", "deny"],
  ["cat <(echo a)", "ask"],
  ["/bin/rm -rf x", "deny"],
  ["/bin/echo a", "ask"],
  ["sudo echo a", "deny"],
  ["s\\udo echo a", "deny"],
  ["CI=1 git status", "allow", false],
  ["BASH_ENV=x npm test", "ask"],
  ["env CI=1 git status", "allow", false],
  ['env -S "rm x"', "deny"],
  ["env sudo true", "deny"],
  ["env bash -lc 'rm x'", "deny"],
  ["env -u X bash -lc 'rm x'", "deny"],
  ["env -u HOME git status", "ask"],
  ["nice -n 3 timeout 2s nohup stdbuf -oL command git status", "allow", false],
  ["bash -c 'git push --force'", "deny"],
  ["bash -c 'echo ok'", "allow", false],
  ['bash -c "$X"', "ask"],
  ["echo hi > output", "allow", false],
  ["echo hi > /dev/null", "allow", false],
  ["echo hi 2>&1", "allow", false],
  ["echo hi &", "ask"],
  ["(echo hi)", "ask"],
  ["for x in a; do rm x; done", "deny"],
  ["echo hi; function bad(){ rm x; }", "deny"],
  ["cat <<EOF\nx\nEOF", "ask"],
  ['echo "unclosed', "ask"],
  ["echo ok | cat", "allow", false],
  ["echo ok |& cat", "ask"],
  ["echo a\ncat b", "allow", false],
  ["cat secret", "deny"],
])
  test(`${verdict}: ${command}`, () => {
    const d = decideBash(command, loaded);
    assert.equal(d.verdict, verdict, JSON.stringify(d));
    if (cls !== undefined) assert.equal(d.permissions.write, cls);
  });
test("literal decoding and nested deny view", () => {
  const p = parseBash('env CI=1 echo "a b" && cat $(rm x)', { assignAllow: ["CI"] });
  assert.equal(p.opaque, true);
  assert.ok(p.stages.some((s) => s.program === "rm"));
  assert.deepEqual(p.stages.find((s) => s.program === "echo").argv, ["echo", "a b"]);
});
test("shell depth 3 and oversize opaque", () => {
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  let s = "echo ok";
  for (let i = 0; i < 3; i++) s = "bash -c " + quote(s);
  assert.equal(decideBash(s, loaded).verdict, "allow");
  s = "bash -c " + quote(s);
  assert.equal(decideBash(s, loaded).verdict, "ask");
  assert.equal(parseBash("echo " + "a".repeat(8192)).opaque, true);
});
test("closed matcher vocabulary", () => {
  validateMatch({
    program: ["git", "npm"],
    subcommand: "status",
    "args-contain": ["a", "b"],
    paths: "read",
    wrappers: ["env"],
  });
  for (const m of [
    { raw_regex: ".*" },
    { program: [] },
    { program: 3 },
    { paths: "url" },
    { wrappers: "env" },
    { "args-contain": [""] },
    { subcommand: {} },
  ])
    assert.throws(() => validateMatch(m));
});
test("array alternatives/all arguments and paths are enforced", () => {
  const fixture = structuredClone(loaded);
  fixture.policy.allow = [
    {
      id: "constrained",
      tool: "bash",
      permissions: { write: false, network: [] },
      match: { program: ["cat", "echo"], "args-contain": ["a", "b"], paths: "read" },
    },
  ];
  assert.equal(decideBash("echo a b", fixture).verdict, "allow");
  assert.equal(decideBash("echo a", fixture).verdict, "ask");
  assert.equal(decideBash("echo a b /tmp/private/x", fixture).verdict, "ask");
  fixture.policy.allow = [
    {
      id: "write",
      tool: "bash",
      permissions: { write: true, network: [] },
      match: { program: "echo", paths: "write", wrappers: ["env"] },
    },
  ];
  assert.equal(decideBash("env echo x", fixture).verdict, "allow");
  assert.equal(decideBash("echo x", fixture).verdict, "ask");
  assert.equal(decideBash("env echo /outside/x", fixture).verdict, "ask");
});

test("blanket deny also covers opaque oversize commands", () => {
  const fixture = structuredClone(loaded);
  fixture.policy.deny = [{ id: "all", tool: "bash" }];
  assert.equal(decideBash("a".repeat(9000), fixture).verdict, "deny");
});

test("hard-denied programs remain blocked; nested Pi uses the chosen executor", () => {
  const loaded = {
    policy: {
      env: { assignAllow: [] },
      deny: [],
      allow: [{ tool: "bash" }],
      resources: { network: [] },
    },
  };
  assert.notEqual(decideBash("mkdir research; pi --resume", loaded).verdict, "deny");
  assert.equal(decideBash("pi --help", loaded).verdict, "allow");
  assert.equal(decideBash("pi --version", loaded).verdict, "allow");
  assert.equal(decideBash("pi --help --resume", loaded).verdict, "allow");
  assert.equal(decideBash("sudo --help", loaded).verdict, "deny");
});
