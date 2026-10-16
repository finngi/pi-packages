import test from "node:test";
import assert from "node:assert/strict";
import { resolveSettings } from "./settings.ts";
const agent = {
  name: "fixture",
  description: "fixture",
  body: "body",
  filePath: "/fixture",
};
const parent = {
  model: { provider: "fixture", id: "parent" },
  thinking: "medium",
  available: [
    { provider: "fixture", id: "sonnet-latest" },
    { provider: "fixture", id: "parent" },
  ],
  tools: ["read", "bash"],
  skills: ["selected"],
};
test("inherits and resolves explicit alias/pin with level while preserving empty lists", () => {
  assert.deepEqual(resolveSettings(agent, parent), {
    model: parent.model,
    thinking: "medium",
    tools: undefined,
    skills: ["selected"],
  });
  assert.deepEqual(
    resolveSettings(
      { ...agent, privateSkills: [{ name: "bundle-skill", path: "/bundle" }] },
      parent,
    ).skills,
    ["selected", "bundle-skill"],
  );
  assert.deepEqual(
    resolveSettings({ ...agent, model: "sonnet:high", tools: [], skills: [] }, parent),
    {
      model: { provider: "fixture", id: "sonnet-latest" },
      thinking: "high",
      tools: [],
      skills: [],
    },
  );
  assert.equal(
    resolveSettings({ ...agent, model: "fixture/sonnet-latest:high", thinking: "low" }, parent)
      .thinking,
    "low",
  );
});
test("unavailable model and inactive tool refuse; missing skill warns and is omitted", () => {
  assert.throws(() => resolveSettings({ ...agent, model: "unavailable" }, parent), /unavailable/);
  assert.throws(
    () => resolveSettings({ ...agent, model: "other/sonnet-latest" }, parent),
    /unavailable/,
  );
  const missing = resolveSettings({ ...agent, skills: ["unselected"] }, parent);
  assert.deepEqual(missing.skills, []);
  assert.match(missing.warnings?.[0] ?? "", /Skill "unselected".*omitted/);
  const terminalOnly = resolveSettings(
    { ...agent, skills: ["terminal"] },
    { ...parent, interactiveOnlySkills: ["terminal"] },
  );
  assert.deepEqual(terminalOnly.skills, []);
  assert.deepEqual(terminalOnly.warnings, [
    'Skill "terminal" is interactive-only and was left out of the child.',
  ]);
  assert.throws(() => resolveSettings({ ...agent, tools: ["write"] }, parent), /unavailable/);
});

test("per-launch models select authenticated models unless the user fixed the agent model", () => {
  assert.equal(resolveSettings(agent, parent, "sonnet").model.id, "sonnet-latest");
  assert.equal(
    resolveSettings({ ...agent, model: "inherit" }, parent, "fixture/sonnet-latest:high").thinking,
    "high",
  );
  assert.throws(
    () => resolveSettings({ ...agent, model: "sonnet" }, parent, "parent"),
    /user-configured model "fixture\/sonnet-latest".*requested "fixture\/parent" conflicts/,
  );
  assert.equal(
    resolveSettings({ ...agent, model: "sonnet" }, parent, "fixture/sonnet-latest").model.id,
    "sonnet-latest",
  );
  assert.throws(() => resolveSettings(agent, parent, "missing"), /unavailable or unauthenticated/);
  assert.throws(() => resolveSettings(agent, parent, ""), /nonempty/);
  assert.equal(
    resolveSettings({ ...agent, model: "sonnet:high" }, parent, "sonnet:low").thinking,
    "high",
  );
  assert.equal(
    resolveSettings({ ...agent, thinking: "low" }, parent, "sonnet:high").thinking,
    "low",
  );
});

test("wildcards use saved scope and bundle; explicit names can select available unselected skills", () => {
  const bundled = {
    ...agent,
    privateSkills: [{ name: "local", description: "Local", path: "/bundle/skills/local/SKILL.md" }],
  };
  const scopes = { ...parent, availableSkills: ["selected", "extra"] };
  assert.deepEqual(resolveSettings({ ...bundled, skills: ["*"] }, scopes).skills, [
    "selected",
    "local",
  ]);
  assert.deepEqual(
    resolveSettings({ ...bundled, skills: ["extra", "local", "missing"] }, scopes).skills,
    ["extra", "local"],
  );
  assert.deepEqual(resolveSettings({ ...bundled, skills: [] }, scopes).skills, []);
});
