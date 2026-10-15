import test from "node:test";
import assert from "node:assert/strict";
import {
  agentCatalogue,
  cataloguePrompt,
  publicAgentPreview,
  scopeCatalogue,
} from "./catalogue.ts";

test("model catalogue exposes names and descriptions without eager instructions or execution metadata", () => {
  const agent = {
    name: "reviewer",
    description: "Review correctness",
    source: "user" as const,
    body: "private child instructions",
    filePath: "/private/agent.md",
    model: "private/model",
    thinking: "high",
    permissions: "manual",
    skills: ["private-skill"],
    tools: ["read"],
  };
  assert.match(
    agentCatalogue([agent]),
    /<available_agents>[\s\S]*<name>reviewer<\/name>[\s\S]*<description>Review correctness<\/description>/,
  );
  const prompt = cataloguePrompt("existing system instructions", [agent]);
  assert.ok(prompt.startsWith("existing system instructions\n\n"));
  for (const privateValue of [agent.body, agent.filePath, agent.model, "private-skill"])
    assert.ok(!prompt.includes(privateValue));
  assert.match(cataloguePrompt("base", []), /<available_agents>\n<\/available_agents>/);
});

test("scope XML lists native launcher fields in order and escapes text", () => {
  const result = scopeCatalogue({
    execution: "host permissions",
    approval: "native tool-call hooks",
    read: "host permissions <trusted>",
    network: "host permissions",
    workspaceModes: ["scratch", "project"],
    unavailable: [],
  });
  assert.equal(
    result,
    [
      "    <scope>",
      "      <workspace>scratch, project</workspace>",
      "      <execution>host permissions</execution>",
      "      <approval>native tool-call hooks</approval>",
      "      <read>host permissions &lt;trusted&gt;</read>",
      "      <network>host permissions</network>",
      "      <unavailable>none</unavailable>",
      "    </scope>",
    ].join("\n"),
  );
  assert.match(scopeCatalogue({}), /<workspace>scratch<\/workspace>/);
});

test("public preview keeps tools and known scope fields only", () => {
  const preview = publicAgentPreview({
    tools: ["read", "write"],
    skills: ["private-review"],
    scope: {
      execution: "host permissions",
      approval: "native tool-call hooks",
      workspaceModes: ["scratch", "project"],
      unavailable: ["MCP connections are not transferred"],
      network: 3,
      internalNote: "must not be model-visible",
    },
  });
  assert.deepEqual(preview, {
    tools: ["read", "write"],
    scope: {
      execution: "host permissions",
      approval: "native tool-call hooks",
      workspaceModes: ["scratch", "project"],
      unavailable: ["MCP connections are not transferred"],
    },
  });
  assert.throws(
    () => publicAgentPreview({ tools: ["/private/agent/skills/SKILL.md"], scope: {} }),
    /Child capability preview is invalid/,
    "tool names must be identifiers, not resource paths",
  );
  assert.throws(() => publicAgentPreview(null), /Child capability preview is invalid/);
});

test("validated catalogue describes model choice and lists authenticated model IDs", () => {
  const agents = [
    {
      name: "worker",
      description: "Do work",
      body: "private",
      filePath: "/worker",
      source: "user" as const,
    },
  ];
  const selections = new Map([["worker", { model: "fixture/parent", locked: false }]]);
  const result = cataloguePrompt("", agents, undefined, selections, [
    { provider: "fixture", id: "alternate" },
  ]);
  assert.match(result, /<model selection="selectable">fixture\/parent<\/model>/);
  assert.match(result, /<available_subagent_models>[\s\S]*fixture\/alternate/);
  selections.set("worker", { model: "fixture/alternate", locked: true });
  assert.match(
    cataloguePrompt("", agents, undefined, selections),
    /<model selection="fixed">fixture\/alternate<\/model>/,
  );
  assert.ok(!result.includes("/worker"));
  assert.ok(!result.includes("private"));
});

test("model catalogue order is stable across provider availability ordering", () => {
  const models = [
    { provider: "b", id: "two" },
    { provider: "a", id: "one" },
  ];
  assert.equal(
    cataloguePrompt("", [], undefined, undefined, models),
    cataloguePrompt("", [], undefined, undefined, [...models].reverse()),
  );
});
