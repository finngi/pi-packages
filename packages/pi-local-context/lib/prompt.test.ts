import test from "node:test";
import assert from "node:assert/strict";
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
import { compactPiDocumentation, renderInstructions } from "./prompt.ts";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

test("Pi help is a lazy skill entry and the docs section is one line", () => {
  const found = loadSkillsFromDir({
    dir: fileURLToPath(new URL("../skills", import.meta.url)),
    source: "package",
  });
  assert.deepEqual(found.diagnostics, []);
  assert.equal(found.skills.length, 1);
  const skill = found.skills[0];
  const options = normalizeBuildSystemPromptOptions({ cwd: "/project", skills: [skill] });
  compactPiDocumentation(options);
  const prompt = buildSystemPrompt(options);
  assert.match(prompt, /<docs>\nFor Pi harness questions, consult the pi-help skill\.\n<\/docs>/);
  assert.match(prompt, /<name>pi-help<\/name>/);
  assert.ok(prompt.includes(skill.filePath));
  assert.ok(!prompt.includes("Always read pi .md files completely"));
  assert.ok(!prompt.includes("Run `node scripts/paths.mjs`"), "skill body is not eagerly loaded");
});

test("custom prompt and caller docs override retain their chosen content", () => {
  for (const input of [
    { customPrompt: "Lexical search only." },
    { forceSystemPrompt: "Opaque search system." },
    { sections: { docs: "Read the team's Pi integration guide." } },
  ]) {
    const options = normalizeBuildSystemPromptOptions({ cwd: "/project", ...input });
    const before = structuredClone(options);
    compactPiDocumentation(options);
    assert.deepEqual(options, before);
  }
});

test("excluding pi-help retains a concise installed SDK documentation pointer", () => {
  const options = normalizeBuildSystemPromptOptions({ cwd: "/project" });
  compactPiDocumentation(options);
  assert.match(options.sections.docs!, /^Pi harness documentation: /);
  assert.ok(!options.sections.docs!.includes("pi-help"));
  assert.equal(options.sections.docs!.split("\n").length, 1);
});

test("stock instruction section preserves body markup and escapes source attributes", () => {
  const body = "<!-- body comment -->\nUse <literal> wording.\n";
  const instructions = renderInstructions([{ path: '/catalogue/a"<&>.md', content: body }]);
  const options = normalizeBuildSystemPromptOptions({
    cwd: "/project",
    contextFiles: [{ path: "/project/AGENTS.md", content: "PROJECT_CONTEXT" }],
    sections: { instructions },
  });
  const prompt = buildSystemPrompt(options);
  assert.ok(
    prompt.includes('<instructions>\n<instruction path="/catalogue/a&quot;&lt;&amp;&gt;.md">'),
  );
  assert.ok(prompt.includes(body));
  assert.match(prompt, /<project_context>[\s\S]*PROJECT_CONTEXT[\s\S]*<\/project_context>/);
  assert.equal((prompt.match(/Use <literal> wording\./g) ?? []).length, 1);
});
