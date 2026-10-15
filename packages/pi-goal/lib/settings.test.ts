import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { evaluatorOptions } from "./settings.ts";

test("native evaluator settings honour project trust and explicit flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-evaluator-settings-"));
  const agent = join(root, "agent"),
    project = join(root, "project");
  try {
    await mkdir(agent);
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ goal: { evaluator: { model: "personal/evaluator", timeoutSec: 12 } } }),
    );
    await writeFile(
      join(project, ".pi/settings.json"),
      JSON.stringify({ goal: { evaluator: { model: "project/evaluator" } } }),
    );
    const trusted = SettingsManager.create(project, agent, { projectTrusted: true }).getSettings();
    const untrusted = SettingsManager.create(project, agent, {
      projectTrusted: false,
    }).getSettings();
    assert.deepEqual(evaluatorOptions(trusted), { model: "project/evaluator", timeoutSec: 12 });
    assert.deepEqual(evaluatorOptions(untrusted), { model: "personal/evaluator", timeoutSec: 12 });
    assert.deepEqual(evaluatorOptions(trusted, { model: "cli/evaluator", timeoutSec: "5" }), {
      model: "cli/evaluator",
      timeoutSec: 5,
    });
    assert.deepEqual(evaluatorOptions({}), { model: undefined, timeoutSec: 30 });
    // Invalid configured values reach the extension validator rather than silently selecting a fallback.
    assert.equal(evaluatorOptions({ goal: { evaluator: { timeoutSec: 0 } } }).timeoutSec, 0);
    assert.ok(Number.isNaN(evaluatorOptions({}, { timeoutSec: "invalid" }).timeoutSec));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
