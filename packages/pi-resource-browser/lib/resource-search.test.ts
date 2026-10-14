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
test("BM25 ranks complete terms across names, descriptions and agent metadata", () => {
  const search = new ResourceSearch(records);
  assert.equal(search.search("project documentation")[0].id, "docs");
  assert.equal(search.search("security")[0].id, "review");
  assert.equal(search.search("bash")[0].id, "build");
  assert.deepEqual(search.search("unknown vocabulary"), []);
});
test("typeahead supports prefixes, punctuation and case without changing an empty catalogue", () => {
  const search = new ResourceSearch(records);
  assert.equal(search.search("DOCUM")[0].id, "docs");
  assert.equal(search.search("code_review")[0].id, "review");
  assert.deepEqual(search.search(""), records);
  assert.deepEqual(new ResourceSearch([]).search("review"), []);
});
