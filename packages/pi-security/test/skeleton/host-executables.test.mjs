import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostExecutable } from "../../src/host-executables.ts";
test("helper executable resolution uses only host-selected directories and Debian fd spelling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-executables-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trusted = join(root, "trusted"),
    untrusted = join(root, "project");
  await mkdir(trusted);
  await mkdir(untrusted);
  for (const path of [join(trusted, "fdfind"), join(untrusted, "fd")]) {
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  assert.equal(
    await resolveHostExecutable(["fd", "fdfind"], [trusted]),
    await realpath(join(trusted, "fdfind")),
  );
  await assert.rejects(resolveHostExecutable(["rg"], [trusted]), /policy.env.path/);
  await assert.rejects(resolveHostExecutable(["fd"], ["relative"]), /absolute/);
  await assert.rejects(resolveHostExecutable(["fd"], [], "relative"), /absolute/);
});
