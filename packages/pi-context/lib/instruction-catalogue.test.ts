import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { instructionCatalogue } from "./instruction-catalogue.ts";
import { catalogueInstructionId } from "./instruction-selection.ts";
import { discoverResourcePackages } from "pi-runtime";
const ns = "resources";
const put = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

test("setup instruction discovery returns trusted metadata, pack membership and saved defaults without bodies or project context", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instruction-catalogue-"))),
    project = join(root, "project"),
    agentDir = join(root, "agent"),
    pack = join(root, "packs/sample"),
    catalogue = join(root, "global-package/instructions");
  try {
    put(join(project, "AGENTS.md"), "TEAM_CONTEXT_BODY");
    put(join(project, "AGENTS.local.md"), "LOCAL_CONTEXT_BODY");
    put(
      join(project, ".agents/instructions/local.md"),
      "---\ntitle: Local behavior\ndescription: Local scope.\nnotes: HUMAN_ONLY\n---\nLOCAL_RULE_BODY",
    );
    put(
      join(catalogue, "global.md"),
      "---\ntitle: Global behavior\ndescription: Global scope.\n---\nGLOBAL_RULE_BODY",
    );
    put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "sample",
        description: "Swarm metadata",
        keywords: ["rpc"],
        pi: { extensions: [], skills: [], instructions: [`./${ns}/instructions`] },
      }),
    );
    const packCatalogue = join(pack, ns, "instructions");
    put(
      join(packCatalogue, "pack.md"),
      "---\ntitle: Pack behavior\ndescription: Pack scope.\nnotes: PRIVATE_NOTES\n---\nPACK_RULE_BODY",
    );
    put(join(packCatalogue, "bad.md"), "---\ntitle: [\n---\nMALFORMED_METADATA_BODY");
    put(
      join(dirname(catalogue), "package.json"),
      JSON.stringify({ name: "global-guidance", pi: { instructions: ["./instructions"] } }),
    );
    const packId = catalogueInstructionId(packCatalogue, "pack.md"),
      globalId = catalogueInstructionId(catalogue, "global.md");
    const global = {
      packages: [pack, dirname(catalogue)],
      localContext: { instructions: { [globalId]: true } },
    };
    const packs = (
      await discoverResourcePackages(SettingsManager.inMemory(global), project, agentDir)
    ).packs;
    const saved = {
      localContext: {
        instructions: {
          [globalId]: false,
          [packId]: true,
          "local:.agents/instructions/local.md": false,
        },
      },
    };
    const result = instructionCatalogue(global, saved, project, true, true, packs);
    assert.equal(
      result.candidates.length,
      4,
      "native packages and local snippets contribute unique IDs",
    );
    assert.deepEqual(result.selected, [packId]);
    const item = result.candidates.find((item) => item.id === packId)!;
    assert.equal(item.packName, "sample");
    assert.equal(item.name, "Pack behavior");
    assert.equal(item.nativeDefault, false);
    assert.equal(
      result.candidates.find((item) => item.id.startsWith("local:"))?.nativeDefault,
      true,
    );
    assert.match(item.keywords, /Swarm metadata rpc/);
    assert.doesNotMatch(
      JSON.stringify(result.candidates),
      /BODY|HUMAN_ONLY|PRIVATE_NOTES|AGENTS\.md|AGENTS\.local/,
    );
    assert.ok(
      result.problems.length > 0,
      "malformed metadata retains choices with a content-free diagnostic",
    );
    assert.doesNotMatch(JSON.stringify(result.problems), /MALFORMED_METADATA_BODY/);
    const sparse = instructionCatalogue(
      { ...global, localContext: { instructions: { [globalId]: true } } },
      { localContext: { instructions: { [packId]: true } } },
      project,
      true,
      true,
      packs,
    );
    assert.deepEqual(
      new Set(sparse.selected),
      new Set([globalId, packId, "local:.agents/instructions/local.md"]),
    );
    const untrusted = instructionCatalogue(global, saved, project, false, true, packs);
    assert.deepEqual(untrusted.selected, [globalId]);
    assert.ok(!untrusted.candidates.some((item) => item.id.startsWith("local:")));
    assert.deepEqual(
      instructionCatalogue(global, saved, project, true, false, packs).candidates,
      [],
    );
    assert.deepEqual(instructionCatalogue(global, saved, project, true, false, packs).selected, []);
    assert.deepEqual(instructionCatalogue({}, {}, project, true, true, packs).selected, [
      "local:.agents/instructions/local.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
