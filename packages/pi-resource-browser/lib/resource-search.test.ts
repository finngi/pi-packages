import assert from "node:assert/strict";
import test from "node:test";
import { ResourceSearch } from "./resource-search.ts";

const records = [
  {
    id: "docs",
    name: "documentation-agent",
    description: "Write and review project documentation",
    keywords: "read write luna",
  },
  {
    id: "review",
    name: "code-review",
    description: "Review code for correctness and security",
    keywords: "read grep",
  },
  {
    id: "build",
    name: "build-helper",
    description: "Compile the project and repair TypeScript errors",
    keywords: "bash sol",
  },
];
test("matches names, descriptions and keywords with Pi's fuzzy matcher", () => {
  const search = new ResourceSearch(records);
  assert.equal(search.search("documentation")[0].id, "docs");
  assert.equal(search.search("security")[0].id, "review");
  assert.equal(search.search("bash")[0].id, "build");
  assert.deepEqual(search.search("unknown vocabulary"), []);
});
test("abbreviations and prefixes match in order, regardless of case", () => {
  const search = new ResourceSearch(records);
  assert.deepEqual(
    search.search("bh").map((record) => record.id),
    ["build"],
  );
  assert.equal(search.search("DOCUM")[0].id, "docs");
  assert.equal(search.search("code-review")[0].id, "review");
});
test("every query token must match, and an empty query keeps the catalogue order", () => {
  const search = new ResourceSearch(records);
  assert.deepEqual(
    search.search("project typescript").map((record) => record.id),
    ["build"],
  );
  assert.deepEqual(search.search("review nowhere"), []);
  assert.deepEqual(search.search(""), records);
  assert.deepEqual(search.search("   "), records);
  assert.deepEqual(new ResourceSearch([]).search("review"), []);
});
