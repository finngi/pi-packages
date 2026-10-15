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

test("capability XML shows effective permissions without serializing policy deny arrays", () => {
  const scope = {
    mode: "auto",

    capabilities: ["gpu"],
    write: "own workspace only; parent integrates returned artifacts",
    read: "policy-permitted files",
    readDeny: ["/private/credentials", "/private/credentials"],
    writeDeny: ["/private/trusted-code"],
    network: ["docs.example", "research.example"],
  };
  const before = structuredClone(scope);
  const result = scopeCatalogue(scope);
  assert.match(result, /<workspace>scratch<\/workspace>/);
  assert.match(result, /<approval>auto<\/approval>/);

  assert.match(result, /<capabilities>gpu<\/capabilities>/);
  assert.match(
    scopeCatalogue({ ...scope, capabilities: [] }),
    /<capabilities>none<\/capabilities>/,
  );
  assert.match(result, /<network>docs.example, research.example<\/network>/);
  assert.ok(!result.includes("/private/"));
  assert.ok(!result.includes("&quot;"));
  assert.deepEqual(scope, before, "presentation does not modify enforcement data");
});

test("unrestricted scope includes project workspace and escapes policy text", () => {
  const result = scopeCatalogue({
    mode: "off",
    workspaceModes: ["scratch", "project"],
    read: "host permissions <trusted>",
    network: "host permissions",
  });
  assert.match(result, /<workspace>scratch, project<\/workspace>/);
  assert.match(result, /host permissions &lt;trusted&gt;/);
  assert.match(result, /<network>host permissions<\/network>/);
});

test("public preview strips private resources and full policy paths", () => {
  const preview = publicAgentPreview({
    tools: ["read", "write"],
    skills: ["private-review"],
    privateSkills: [{ name: "private-review", path: "/agent/skills/private-review/SKILL.md" }],
    scope: {
      mode: "auto",

      read: "policy-permitted files",
      write: "own workspace",
      network: ["docs.example"],
      workspaceModes: ["scratch"],
      readDeny: ["/Users/example/.ssh"],
      writeDeny: ["/Users/example/dev/pi-security"],
      capabilities: ["gpu"],
      profilePath: "/private/profile.sb",
      internalNote: "must not be model-visible",
    },
  });
  assert.deepEqual(preview, {
    tools: ["read", "write"],
    scope: {
      mode: "auto",

      read: "policy-permitted files",
      write: "own workspace",
      network: ["docs.example"],
      workspaceModes: ["scratch"],
      capabilities: ["gpu"],
    },
  });
  const output = JSON.stringify(preview);
  for (const hidden of [
    "private-review",
    "/agent/skills",
    ".ssh",
    "pi-security",
    "profilePath",
    "must not be model-visible",
  ])
    assert.ok(!output.includes(hidden), `public preview leaked ${hidden}`);

  assert.deepEqual(
    publicAgentPreview({ tools: ["read"], scope: { read: "/Users/example/.ssh" } }),
    { tools: ["read"], scope: {} },
    "path-like scope text is omitted rather than forwarded",
  );
  for (const encodedPath of [
    "%2fUsers%2fexample%2f.ssh",
    "%252fUsers%252fexample%252f.ssh",
    "&#x2f;Users&#x2f;example&#x2f;.ssh",
    "&#47;Users&#47;example&#47;.ssh",
    "&sol;Users&sol;example&sol;.ssh",
    "／Users／example／.ssh",
    "∕Users∕example∕.ssh",
    "⁄Users⁄example⁄.ssh",
  ])
    assert.deepEqual(
      publicAgentPreview({ tools: ["read"], scope: { read: encodedPath } }),
      { tools: ["read"], scope: {} },
      "encoded path-like scope text is omitted rather than forwarded",
    );
  assert.throws(
    () => publicAgentPreview({ tools: ["/private/agent/skills/SKILL.md"], scope: {} }),
    /Child capability preview is invalid/,
    "tool names must be identifiers, not resource paths",
  );
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
