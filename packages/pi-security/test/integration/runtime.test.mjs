import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { protectRuntime } from "../../src/runtime-protection.ts";
import { decide } from "../../src/gate.ts";
import { policy } from "../skeleton/fixture.mjs";

test("shared and sibling runtime packages remain protected even inside the project write root", async () => {
  const project = fileURLToPath(new URL("../../../../", import.meta.url));
  const p = policy();
  const filesystem = { readDeny: [], writeDeny: [], writeAllow: [project] };
  const loaded = {
    project,
    tmp: project,
    filesystem: filesystem,
    policy: p,
  };
  await protectRuntime(loaded, fileURLToPath(new URL("../../src/extension.ts", import.meta.url)));
  for (const name of [
    "pi-runtime",
    "pi-contracts",
    "pi-background",
    "pi-delegation",
    "pi-goal",
    "pi-context",
    "pi-codex-search",
  ]) {
    const file = ["pi-runtime", "pi-contracts"].includes(name)
      ? fileURLToPath(import.meta.resolve(name))
      : fileURLToPath(new URL(`../../../${name}/package.json`, import.meta.url));
    assert.equal(decide("write", { path: file }, loaded).verdict, "deny", name);
  }
  assert.deepEqual(loaded.policy.resources.denyWrite, loaded.filesystem.writeDeny);
});
