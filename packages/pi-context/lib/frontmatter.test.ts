import assert from "node:assert/strict";
import { test } from "node:test";
import { stripFrontmatter } from "./frontmatter.ts";
test("complete leading YAML is removed; comments and body are preserved", () => {
  assert.equal(
    stripFrontmatter("---\ncomment: observer\n---\n<!-- body -->\ninstruction"),
    "<!-- body -->\ninstruction",
  );
  assert.equal(stripFrontmatter("\uFEFF---\ncomment: observer\n---\nbody"), "body");
  assert.equal(stripFrontmatter("---\r\ncomment: observer\r\n---\r\nbody"), "body");
  assert.equal(stripFrontmatter("---\ncomment: incomplete"), "---\ncomment: incomplete");
  assert.equal(stripFrontmatter("body\n---\ncomment: body\n---"), "body\n---\ncomment: body\n---");
});
test("malformed closed metadata is removed without discarding the context body", () => {
  const malformed = "---\nnotes: [unfinished\n---\nKEEP_BODY\n<!-- keep comment -->";
  assert.equal(stripFrontmatter(malformed), "KEEP_BODY\n<!-- keep comment -->");
  assert.equal(
    stripFrontmatter("---\nnotes: [unfinished\nKEEP_BODY"),
    "---\nnotes: [unfinished\nKEEP_BODY",
  );
  assert.equal(stripFrontmatter("<!-- comment -->\nbody"), "<!-- comment -->\nbody");
});
test("only complete standalone leading delimiters identify metadata", () => {
  for (const text of [
    "--- heading\n---\nbody",
    "---\nbody\n--- heading\nmore body",
    "body\n---\nnotes: body\n---",
    "\r\n---\nnotes: body\n---\nbody",
  ]) {
    assert.equal(stripFrontmatter(text), text);
  }
});
test("a delimiter prefix inside metadata cannot leak metadata beyond the exact closing delimiter", () => {
  const text =
    "---\nnotes: first\n---bad\nnotes: SHOULD_BE_HIDDEN\n---\nBODY\n<!-- body comment -->\n";
  assert.equal(stripFrontmatter(text), "BODY\n<!-- body comment -->\n");
});
