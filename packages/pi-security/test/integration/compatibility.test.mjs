import test from "node:test";
import assert from "node:assert/strict";
import { compatibility, launchOptions } from "../../src/compatibility.ts";
import { Bindings } from "../../src/gate.ts";
test("compatibility fails closed and retains definition identity", async () => {
  let initialized = false;
  const s = compatibility({ placement: "wall", initialized: () => initialized });
  const d = { name: "fixture" };
  assert.equal(s.registerMcpToolDefinition(d), d);
  assert.equal(s.registerMcpResourceDefinition(d), d);
  s.configureLaunch({
    version: 1,
    identity: "fixture",
    mode: "contained",
    placement: { kind: "container", verified: true },
    allowedModes: ["contained"],
    mcp: [{ name: "fixture" }],
  });
  await assert.rejects(s.ready());
  initialized = true;
  s.started();
  await assert.rejects(s.ready());
  assert.throws(() =>
    s.acknowledgeMcpReady({
      version: 1,
      identity: "fixture",
      sessionGeneration: 0,
      isCurrent: () => true,
      connections: [],
    }),
  );
  s.acknowledgeMcpReady({
    version: 1,
    identity: "fixture",
    sessionGeneration: 1,
    isCurrent: () => true,
    connections: [{ name: "fixture", state: "connected", identity: "c", connectionGeneration: 1 }],
  });
  assert.deepEqual(await s.ready(), {
    version: 1,
    identity: "fixture",
    mode: "contained",
    nativeReady: true,
    sessionGeneration: 1,
    policyEpoch: 1,
    reviewer: "not-required",
  });
  assert.throws(() => s.configureLaunch({}));
  assert.throws(() => launchOptions({ PI_SECURITY_PLACEMENT: "unknown" }));
});
test("bindings are one shot exact input and clear on shutdown", () => {
  const b = new Bindings();
  b.put("1", "bash", { command: "true" }, { permissions: { write: false, network: [] } });
  assert.throws(() => b.take("1", "bash", { command: "false" }));
  assert.throws(() => b.take("1", "bash", { command: "true" }));
  b.put("2", "bash", {}, {});
  b.clear();
  assert.throws(() => b.take("2", "bash", {}));
});
