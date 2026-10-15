import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalogueInstructionId, effectiveInstructions } from "./instruction-selection.ts";
import { writeResourceDefault, writeResourceDefaults } from "pi-resources/selection";

test("project instruction maps override global defaults by ID", () => {
  const global = { localContext: { instructions: { "core/a.md": true } } };
  assert.deepEqual(effectiveInstructions(global, {}, ["core/a.md"]), ["core/a.md"]);
  assert.deepEqual(
    effectiveInstructions(global, { localContext: { instructions: { "core/a.md": false } } }, [
      "core/a.md",
    ]),
    [],
  );
  assert.deepEqual(
    effectiveInstructions(global, { localContext: { instructions: { "missing.md": true } } }, [
      "core/a.md",
    ]),
    ["core/a.md"],
  );
  assert.throws(
    () => effectiveInstructions({ localContext: { instructions: [] } } as never, {}),
    /ID-to-boolean map/,
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

test("project and global default persistence preserve unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-instruction-settings-"));
  try {
    const agent = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([
      writeResourceDefaults({
        scope: "global",
        agentDir: agent,
        selections: { instructions: { knownIds: ["core/a.md"], values: { "core/a.md": true } } },
      }),
      writeResourceDefaults({
        scope: "global",
        agentDir: agent,
        selections: { agents: { knownIds: ["reviewer"], values: { reviewer: true } } },
      }),
    ]);
    await writeResourceDefaults({
      scope: "project",
      cwd: project,
      selections: { instructions: { knownIds: ["core/a.md"], values: { "core/a.md": false } } },
    });
    assert.deepEqual(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")), {
      localContext: { instructions: { "core/a.md": true } },
      subagents: { agents: { reviewer: true } },
    });
    assert.deepEqual(JSON.parse(await readFile(join(project, ".pi/settings.json"), "utf8")), {
      localContext: { instructions: { "core/a.md": false } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sparse instruction defaults inherit local baselines and opt in public snippets", () => {
  const known = ["local:a", "local:b", "library:public"];
  const native = ["local:a", "local:b"];
  assert.deepEqual(effectiveInstructions({}, {}, known, native), native);
  assert.deepEqual(
    effectiveInstructions(
      { localContext: { instructions: { "library:public": true, "local:b": false } } },
      { localContext: { instructions: { "local:a": false } } },
      known,
      native,
    ),
    ["library:public"],
  );
  assert.deepEqual(
    effectiveInstructions(
      {
        localContext: {
          instructions: { "library:public": true, "local:a": false, "local:b": false },
        },
      },
      { localContext: { instructions: { "local:a": true } } },
      known,
      native,
    ),
    ["local:a", "library:public"],
  );
  assert.deepEqual(
    effectiveInstructions({}, { localContext: { instructions: { missing: true } } }, known, native),
    native,
  );
  assert.deepEqual(
    effectiveInstructions({ localContext: { instructions: { missing: true } } }, {}, known, native),
    native,
  );
  assert.deepEqual(
    effectiveInstructions(
      {},
      { localContext: { instructions: { missing: false } } },
      known,
      native,
    ),
    native,
  );
  assert.throws(
    () =>
      effectiveInstructions(
        {},
        { localContext: { instructions: { "local:a": "yes" } } } as never,
        known,
        native,
      ),
    /boolean/,
  );
});

test("saving one instruction preserves inherited siblings, dormant provider choices and unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-instruction-sparse-"));
  const projectPath = join(root, ".pi/settings.json");
  const known = ["local:a", "local:b", "library:public"];
  const native = ["local:a", "local:b"];
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      projectPath,
      JSON.stringify({
        theme: "dark",
        localContext: { other: true, instructions: { "absent-provider": false } },
      }),
    );
    await writeResourceDefault({
      scope: "project",
      cwd: root,
      kind: "instructions",
      id: "local:a",
      state: "off",
      knownIds: known,
    });
    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    assert.deepEqual(saved, {
      theme: "dark",
      localContext: { other: true, instructions: { "absent-provider": false, "local:a": false } },
    });
    assert.deepEqual(effectiveInstructions({}, saved, known, native), ["local:b"]);
    const global = { localContext: { instructions: { "library:public": true } } };
    assert.deepEqual(effectiveInstructions(global, saved, known, native), [
      "local:b",
      "library:public",
    ]);
    await writeResourceDefault({
      scope: "project",
      cwd: root,
      kind: "instructions",
      id: "local:a",
      state: "inherit",
      knownIds: known,
    });
    assert.deepEqual(
      effectiveInstructions(global, JSON.parse(await readFile(projectPath, "utf8")), known, native),
      known,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk instruction snapshots remove stale saved IDs in both scopes and preserve known ineligible rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-instruction-snapshot-"));
  const known = ["local:a", "library:public"];
  try {
    await mkdir(join(root, ".pi"));
    for (const scope of ["project", "global"] as const) {
      const path =
        scope === "project" ? join(root, ".pi/settings.json") : join(root, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          theme: "dark",
          localContext: { instructions: { "missing-instruction": true, "local:a": false } },
        }),
      );
      await writeResourceDefault({
        scope,
        cwd: root,
        agentDir: root,
        kind: "instructions",
        id: "library:public",
        state: "on",
        knownIds: known,
      });
      assert.equal(
        JSON.parse(await readFile(path, "utf8")).localContext.instructions["missing-instruction"],
        true,
        "single-row edits retain unavailable selections",
      );
      await writeResourceDefaults({
        scope,
        cwd: root,
        agentDir: root,
        selections: {
          instructions: { knownIds: known, values: { "library:public": true }, snapshot: true },
        },
      });
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.deepEqual(saved, {
        theme: "dark",
        localContext: { instructions: { "local:a": false, "library:public": true } },
      });
      assert.deepEqual(
        effectiveInstructions(
          scope === "global" ? saved : {},
          scope === "project" ? saved : {},
          known,
          ["local:a"],
        ),
        ["library:public"],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instruction selection rejects malformed parent containers before inheriting defaults", () => {
  for (const localContext of [[], "bad", null, false, 1]) {
    const malformed = { localContext } as never;
    assert.throws(
      () => effectiveInstructions(malformed, {}, ["local:a"], ["local:a"]),
      /localContext must be an object/,
    );
    assert.throws(
      () => effectiveInstructions({}, malformed, ["local:a"], ["local:a"]),
      /localContext must be an object/,
    );
  }
});
