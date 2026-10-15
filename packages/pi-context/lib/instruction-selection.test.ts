import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  catalogueInstructionId,
  effectiveInstructions,
  instructionCataloguePaths,
  normalizeInstructionCataloguePath,
  writeGlobalDefaults,
  writeProjectInstructions,
} from "./instruction-selection.ts";

test("project instructions inherit global defaults, while an empty override selects none", () => {
  const global = { localContext: { instructions: ["core/a.md"] } };
  assert.deepEqual(effectiveInstructions(global, {}, ["core/a.md"]), ["core/a.md"]);
  assert.deepEqual(
    effectiveInstructions(global, { localContext: { instructions: [] } }, ["core/a.md"]),
    [],
  );
  assert.throws(
    () =>
      effectiveInstructions(global, { localContext: { instructions: ["missing.md"] } }, [
        "core/a.md",
      ]),
    /unknown resource names/,
  );
});

test("same-named catalogue roots produce distinct stable resource IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-instruction-catalogues-"));
  try {
    const first = join(root, "one", "instructions");
    const second = join(root, "two", "instructions");
    assert.notEqual(
      catalogueInstructionId(first, "review.md"),
      catalogueInstructionId(second, "review.md"),
    );
    assert.equal(
      catalogueInstructionId(first, "review.md"),
      catalogueInstructionId(first, "review.md"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instruction catalogue settings expand home paths and reject malformed shapes", () => {
  assert.equal(normalizeInstructionCataloguePath("~/notes", "/agent"), join(homedir(), "notes"));
  assert.deepEqual(
    instructionCataloguePaths(
      { resources: { instructionCatalogues: ["~/notes", "catalogue"] } },
      "/agent",
    ),
    [join(homedir(), "notes"), join("/agent", "catalogue")],
  );
  assert.throws(
    () =>
      instructionCataloguePaths(
        { resources: { instructionCatalogues: ["ok", 3] } as never },
        "/agent",
      ),
    /list of paths/,
  );
});

test("project and global default persistence preserve unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-instruction-settings-"));
  try {
    const agent = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([
      writeGlobalDefaults(agent, "instructions", ["core/a.md"]),
      writeGlobalDefaults(agent, "agents", ["reviewer"]),
    ]);
    await writeProjectInstructions(project, []);
    assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), {
      localContext: { instructions: ["core/a.md"] },
      subagents: { agents: ["reviewer"] },
    });
    assert.deepEqual(JSON.parse(await readFile(join(project, ".pi/settings.json"), "utf8")), {
      localContext: { instructions: [] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
