import assert from "node:assert/strict";
import test from "node:test";
import { newSemanticId, type SemanticIdKind } from "../src/semantic-id.ts";
import { SEMANTIC_WORDS } from "../src/semantic-words.ts";

const kinds: SemanticIdKind[] = [
  "agent",
  "tool",
  "message",
  "process",
  "goal",
  "wait",
  "artifact",
  "task",
];
const vocabulary = new Set<string>(SEMANTIC_WORDS);

test("semantic ID vocabulary is sorted, lowercase, and contains 500 unique words", () => {
  assert.equal(SEMANTIC_WORDS.length, 500);
  assert.equal(vocabulary.size, SEMANTIC_WORDS.length);
  assert.deepEqual(SEMANTIC_WORDS, [...SEMANTIC_WORDS].sort());
  for (const word of SEMANTIC_WORDS) assert.match(word, /^[a-z]+$/);
});

test("newSemanticId emits a typed prefix and three distinct vocabulary words", () => {
  for (const kind of kinds) {
    const id = newSemanticId(kind);
    const [prefix, ...words] = id.split("-");
    assert.equal(prefix, kind);
    assert.equal(words.length, 3);
    assert.equal(new Set(words).size, 3);
    for (const word of words) assert(vocabulary.has(word));
  }
});
