import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadPolicy, validatePolicy } from "../../src/policy.ts";
import { decide } from "../../src/gate.ts";
import { narrow } from "../../src/child-policy.ts";
import { compileProfile } from "../../src/profiles.ts";
import { runKernelTrial } from "../kernel-helper.mjs";

const template = JSON.parse(
  await readFile(new URL("../../src/host-policy.json", import.meta.url), "utf8"),
);
test("host policy supports confined toolchains, controls, fixed-host search and custom agent directory", async () => {
  const saved = { ...process.env },
    root = await mkdtemp(path.join(os.tmpdir(), "host-policy-"));
  try {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "selected-agent");
    const project = root,
      tmp = path.join(root, "tmp"),
      launchDir = path.join(root, "launch"),
      childTmp = path.join(tmp, "child");
    await Promise.all(
      [tmp, launchDir, childTmp, process.env.PI_CODING_AGENT_DIR].map((p) =>
        mkdir(p, { recursive: true }),
      ),
    );
    const file = path.join(root, "policy.json");
    await writeFile(file, JSON.stringify(template));
    const loaded = await loadPolicy(file, { project, tmp });
    assert.equal(loaded.policy.mode, "manual");
    for (const command of [
      "node --test test/example.mjs",
      "python3 check.py",
      "npm run build",
      "go test ./...",
      "make test",
    ])
      assert.equal(decide("bash", { command }, loaded).permissions.write, true, command);
    for (const command of ["rm -rf output", "npm install", "git push origin main"])
      assert.equal(decide("bash", { command }, loaded).verdict, "ask", command);
    for (const tool of [
      "create_goal",
      "get_goal",
      "wait_for_goal_event",
      "subagent",
      "subagent_message",
      "subagent_check",
      "subagent_cancel",
      "subagent_close",
      "background_process",
    ])
      assert.equal(decide(tool, {}, loaded).verdict, "allow", tool);
    assert.equal(decide("codemode", {}, loaded).verdict, "allow");
    assert.equal(decide("powershell", { command: "Write-Output fixture" }, loaded).verdict, "deny");
    assert.equal(decide("codex_search", {}, loaded).verdict, "deny");
    assert.deepEqual(loaded.policy.resources.network, []);
    assert.deepEqual(loaded.policy.resources.network, []);
    const agentAuth = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
    assert.equal(decide("read", { path: agentAuth }, loaded).verdict, "deny");
    for (const denied of loaded.filesystem.writeDeny)
      assert.equal(
        decide("write", { path: path.join(denied, "canary") }, loaded).verdict,
        "deny",
        denied,
      );
    const child = narrow(loaded, { task: "fixture" }, { tmp: childTmp, tempBase: tmp, launchDir });
    assert.deepEqual(child.filesystem.readDeny, loaded.filesystem.readDeny);
    assert.deepEqual(child.filesystem.writeDeny, loaded.filesystem.writeDeny);
    assert.deepEqual(child.filesystem.writeAllow, [await realpath(childTmp)]);
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test("host policy kernel denies protected credential reads and runtime writes inside project scope", async () => {
  validatePolicy(structuredClone(template));
  const result = await runKernelTrial({
    setup: async (p) => {
      await writeFile(path.join(p.project, "credential"), "fixture-only");
      await writeFile(path.join(p.project, "runtime"), "original");
      await mkdir(path.join(p.project, "nested", ".pi"), { recursive: true });
      await writeFile(path.join(p.project, "nested", ".pi", "mcp.json"), "nested-token-fixture");
    },
    profile: (p) =>
      compileProfile(
        {
          filesystem: {
            writeAllow: [p.project, p.tmp],
            writeDeny: [path.join(p.project, "runtime")],
            readDeny: [path.join(p.project, "credential")],
          },
        },
        { write: true, network: [] },
      ),
    argv: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "cat credential; cat nested/.pi/mcp.json; printf bad > runtime",
    ],
  });
  assert.equal(result.setupFailure, null);
  assert.notEqual(result.process.exitCode, 0);
  assert.doesNotMatch(result.process.stdout, /fixture-only|nested-token-fixture/);
  assert.equal(
    result.effects.changed.some((e) => e.path === "project/runtime"),
    false,
  );
});
