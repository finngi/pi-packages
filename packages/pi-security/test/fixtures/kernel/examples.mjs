import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runKernelTrial } from "../../kernel-helper.mjs";

const base = await readFile(fileURLToPath(new URL("./base.sb", import.meta.url)), "utf8");
const quote = (value) => JSON.stringify(value);
const buildProfile = (paths) =>
  `${base}\n(allow file-write* (literal "/dev/null") (subpath ${quote(paths.project)}) (subpath ${quote(paths.tmp)}))\n`;
const readOnlyProfile = `${base}\n(allow file-write* (literal "/dev/null"))\n`;

export async function scopedBuildWrite() {
  const result = await runKernelTrial({
    profile: buildProfile,
    argv: ["/bin/sh", "-c", "printf scoped-ok > marker.txt"],
  });
  assert.equal(result.setupFailure, null);
  assert.equal(result.process.exitCode, 0, result.process.stderr);
  assert.equal(result.refusal, null);
  assert.deepEqual(
    result.effects.created.find((file) => file.path === "project/marker.txt")?.content,
    "scoped-ok",
  );
  return result;
}

export async function siblingWriteRefused() {
  const result = await runKernelTrial({
    profile: buildProfile,
    argv: ["/bin/sh", "-c", "printf escaped > ../outside/marker.txt"],
  });
  assert.equal(result.setupFailure, null);
  assert.notEqual(result.process.exitCode, 0);
  assert.match(result.refusal ?? "", /operation not permitted|permission denied|sandbox.*den/i);
  assert.equal(
    result.effects.created.some((file) => file.path === "outside/marker.txt"),
    false,
  );
  return result;
}

export async function readOnlyWriteRefused() {
  const result = await runKernelTrial({
    profile: readOnlyProfile,
    argv: ["/bin/sh", "-c", "printf blocked > marker.txt"],
  });
  assert.equal(result.setupFailure, null);
  assert.notEqual(result.process.exitCode, 0);
  assert.match(result.refusal ?? "", /operation not permitted|permission denied|sandbox.*den/i);
  assert.equal(
    result.effects.created.some((file) => file.path === "project/marker.txt"),
    false,
  );
  return result;
}
