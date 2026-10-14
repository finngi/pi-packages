import assert from "node:assert/strict";
import test from "node:test";
import { addTokenUsage, readTokenUsage, totalTokens } from "../src/token-usage.ts";

test("parent token accounting includes cached/repeated categories independently of forwarding cost metadata", () => {
  const first = readTokenUsage({
    input: 8,
    output: 2,
    cacheRead: 90,
    cacheWrite: 4,
    totalTokens: 104,
    cost: { total: 0 },
  })!;
  const next = addTokenUsage(first, { input: 8, output: 2, cacheRead: 90, cacheWrite: 0 })!;
  assert.equal(totalTokens(next), 204);
  assert.deepEqual(next, { input: 16, output: 4, cacheRead: 180, cacheWrite: 4 });
});

test("invalid categories and unsafe accumulated counters remain unknown", () => {
  for (const value of [
    undefined,
    { input: 1, output: 2 },
    { input: 1, output: -1, cacheRead: 0, cacheWrite: 0 },
    { input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0 },
  ])
    assert.equal(readTokenUsage(value), undefined);
  assert.equal(
    addTokenUsage(
      { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
      { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    ),
    undefined,
  );
});
