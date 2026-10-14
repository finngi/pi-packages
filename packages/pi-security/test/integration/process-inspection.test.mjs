import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileProfile } from "../../src/profiles.ts";
import { runKernelTrial } from "../kernel-helper.mjs";

const profile = (p) =>
  compileProfile(
    {
      project: p.project,
      tmp: p.tmp,
      filesystem: {
        writeAllow: [p.project],
        writeDeny: [],
        readDeny: [path.join(p.project, "private")],
      },
    },
    { write: false, network: [] },
  );

test("confined pgrep reads an independently launched process without granting signals", async () => {
  const marker = `pi-process-inspection-${randomUUID()}`;
  const child = spawn("/bin/sleep", ["45"], { argv0: marker, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    const inspect = await runKernelTrial({ profile, argv: ["/usr/bin/pgrep", "-fl", marker] });
    assert.equal(inspect.setupFailure, null);
    assert.equal(inspect.process.exitCode, 0, inspect.process.stderr);
    assert.ok(
      inspect.process.stdout
        .split("\n")
        .some((line) => line.trim().split(/\s+/)[0] === String(child.pid)),
      inspect.process.stdout,
    );
    const signal = await runKernelTrial({
      profile,
      argv: ["/bin/kill", "-TERM", String(child.pid)],
    });
    assert.notEqual(signal.process.exitCode, 0);
    assert.match(signal.process.stderr, /not permitted|denied/i);
  } finally {
    child.kill();
  }
});

test("process metadata access preserves file read and write restrictions", async () => {
  const result = await runKernelTrial({
    profile,
    setup: (p) => writeFile(path.join(p.project, "private"), "fixture-secret"),
    argv: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "cat private; printf changed > output; exit 0",
    ],
  });
  assert.equal(result.setupFailure, null);
  assert.match(result.process.stderr, /not permitted|denied/i);
  assert.ok(!result.process.stdout.includes("fixture-secret"));
  assert.deepEqual(result.effects.created, []);
  assert.deepEqual(result.effects.changed, []);
});
