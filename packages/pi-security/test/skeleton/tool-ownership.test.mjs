import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { effectToolOwnershipError, ownsEffectTools } from "../../src/tool-ownership.ts";

test("canonical source ownership accepts the verified cache alias and refuses replacements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "security-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "entry.mjs"),
    alias = join(root, "cache.mjs"),
    wrong = join(root, "wrong.mjs");
  await writeFile(entry, "fixture");
  await writeFile(wrong, "fixture");
  await symlink(entry, alias);
  const tool = (source) => ({ name: "bash", sourceInfo: { path: source } });
  assert.equal(await ownsEffectTools([tool(alias)], ["bash"], entry), true);
  assert.equal(await effectToolOwnershipError([tool(alias)], ["bash"], entry), undefined);
  assert.equal(await ownsEffectTools([tool(wrong)], ["bash"], entry), false);
  assert.equal(await ownsEffectTools([tool(join(root, "missing"))], ["bash"], entry), false);
  assert.equal(await ownsEffectTools([], ["bash"], entry), false);
  assert.equal(await ownsEffectTools([tool(alias)], ["bash", "read"], entry), false);
  assert.match(
    await effectToolOwnershipError([], ["bash"], entry),
    /bash \(registration source missing\)/,
  );
  assert.match(
    await effectToolOwnershipError([tool(join(root, "missing"))], ["bash"], entry),
    /bash \(registration path unavailable\)/,
  );
  assert.match(
    await effectToolOwnershipError([tool(alias)], ["bash"], join(root, "missing-entry")),
    /extension file is unavailable/,
  );
  await rm(alias);
  await symlink(wrong, alias);
  assert.equal(await ownsEffectTools([tool(alias)], ["bash"], entry), false);
  const message = await effectToolOwnershipError([tool(alias)], ["bash"], entry);
  assert.match(message, /bash \(different extension path\)/);
  assert.match(message, /exit Pi and restart with pi --resume/);
  assert.doesNotMatch(message, /policy.*missing/);
});
