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
    permissionMode: undefined,
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
      permissionMode: undefined,
    },
  );
  assert.equal(
    resolveSettings({ ...agent, model: "fixture/sonnet-latest:high", thinking: "low" }, parent)
      .thinking,
    "low",
  );
});
test("unavailable model, unselected skill and inactive tool refuse rather than silently inherit", () => {
  assert.throws(() => resolveSettings({ ...agent, model: "unavailable" }, parent), /unavailable/);
  assert.throws(
    () => resolveSettings({ ...agent, model: "other/sonnet-latest" }, parent),
    /unavailable/,
  );
  assert.throws(
    () => resolveSettings({ ...agent, skills: ["unselected"] }, parent),
    /is unavailable/,
  );
  assert.throws(() => resolveSettings({ ...agent, tools: ["write"] }, parent), /unavailable/);
  assert.throws(
    () => resolveSettings({ ...agent, permissions: "full-access" }, parent),
    /unavailable/,
  );
});

test("per-launch models select authenticated models unless the user fixed the agent model", () => {
  assert.equal(resolveSettings(agent, parent, true, "sonnet").model.id, "sonnet-latest");
  assert.equal(
    resolveSettings({ ...agent, model: "inherit" }, parent, false, "fixture/sonnet-latest:high")
      .thinking,
    "high",
  );
  assert.throws(
    () => resolveSettings({ ...agent, model: "sonnet" }, parent, true, "parent"),
    /user-configured model "fixture\/sonnet-latest".*requested "fixture\/parent" conflicts/,
  );
  assert.equal(
    resolveSettings({ ...agent, model: "sonnet" }, parent, true, "fixture/sonnet-latest").model.id,
    "sonnet-latest",
  );
  assert.throws(
    () => resolveSettings(agent, parent, true, "missing"),
    /unavailable or unauthenticated/,
  );
  assert.throws(() => resolveSettings(agent, parent, true, ""), /nonempty/);
  assert.equal(
    resolveSettings({ ...agent, model: "sonnet:high" }, parent, true, "sonnet:low").thinking,
    "high",
  );
  assert.equal(
    resolveSettings({ ...agent, thinking: "low" }, parent, false, "sonnet:high").thinking,
    "low",
  );
});
