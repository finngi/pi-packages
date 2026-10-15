import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  writeGlobalResourceDefaults,
  writeProjectResourceSelection,
} from "../src/resource-selection.ts";

test("saving one resource kind leaves absent providers' global and project defaults intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const before = {
    packages: ["native-source"],
    subagents: { agents: ["reviewer"], skills: ["old"] },
    localContext: { instructions: ["catalogue:saved"] },
  };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(before));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify(before));
  await writeGlobalResourceDefaults(agentDir, { skills: [] });
  await writeProjectResourceSelection(cwd, { skills: [] }, []);
  for (const file of [join(agentDir, "settings.json"), join(cwd, ".pi/settings.json")]) {
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(after.subagents.agents, ["reviewer"]);
    assert.deepEqual(after.localContext, before.localContext);
    assert.deepEqual(after.packages, before.packages);
    assert.deepEqual(after.subagents.skills, []);
  }
});
