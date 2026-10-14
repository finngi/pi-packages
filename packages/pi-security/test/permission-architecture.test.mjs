import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPolicy, validatePolicy } from "../src/policy.ts";
import { decide, Bindings } from "../src/gate.ts";
import { createAskResolver } from "../src/ask-resolver.ts";
import { childPermissionLimits, narrow, assertNarrows } from "../src/child-policy.ts";
import { normalizePermissions, permitsNetwork, requestedNetwork } from "../src/permissions.ts";
import { createSearchCapabilities } from "../src/search-capability.ts";

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-permission-architecture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    tmp = path.join(root, "tmp");
  await Promise.all([project, tmp].map((directory) => mkdir(directory)));
  const source = {
    version: 2,
    mode: "auto",
    classifier: { model: "fixture", timeoutSec: 1 },
    resources: { network: ["example.org:443"] },
    allow: [
      { tool: "read" },
      { tool: "write" },
      { tool: "bash", permissions: { write: false, network: [] } },
    ],
    ...overrides,
  };
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify(source));
  const loaded = await loadPolicy(policyPath, { project, tmp });
  return { root, project, tmp, source, loaded };
}

test("public configuration supplies defaults and rejects the old tier vocabulary", () => {
  const source = { version: 2, mode: "manual" };
  const p = validatePolicy(source);
  assert.deepEqual(p.resources.write, ["${project}", "${tmp}"]);
  assert.deepEqual(source, { version: 2, mode: "manual" });
  assert.throws(() => validatePolicy({ ...source, classes: {} }), /unknown key classes/);
  assert.throws(() => validatePolicy({ ...source, ask: {} }), /unknown key ask/);
});

test("allowlisted reads cross project boundaries while explicit read exclusions remain hard", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.txt");
  assert.equal(decide("read", { path: outside }, f.loaded).verdict, "allow");
  f.loaded.filesystem.readDeny.push(outside);
  assert.equal(decide("read", { path: outside }, f.loaded).verdict, "deny");
});

test("manual and automatic approval preserve the same reviewed resources and policy", async (t) => {
  const f = await fixture(t);
  const input = { path: path.join(f.root, "other-project.txt"), content: "ok" };
  const call = { toolName: "write", toolCallId: "write-call", input, cwd: f.project };
  const decision = decide(call.toolName, input, f.loaded);
  assert.equal(decision.verdict, "ask");
  const snapshot = structuredClone(f.loaded);
  let view;
  const auto = createAskResolver({
    policy: f.loaded.policy,
    authority: () => ({ userMessages: ["Write the other project file."] }),
    classify: async (value) => {
      view = value;
      return { verdict: "allow", reasonCode: "fixture", labels: [], note: "Requested target." };
    },
  });
  const manualPolicy = { ...f.loaded.policy, mode: "manual" };
  const manual = createAskResolver({ policy: manualPolicy, authority: () => ({}) });
  t.after(() => {
    auto.close();
    manual.close();
  });
  const automated = await auto.resolve(call, decision);
  const interactive = await manual.resolve(call, decision, {
    hasUI: true,
    ui: {
      select: async (_title, choices) => {
        assert.deepEqual(choices, ["Allow", "Deny"]);
        return "Allow";
      },
    },
  });
  assert.equal(automated.verdict, "allow");
  assert.equal(interactive.verdict, "allow");
  assert.deepEqual(interactive.permissions, automated.permissions);
  assert.deepEqual(interactive.writeGrants, automated.writeGrants);
  assert.deepEqual(view.permissions, decision.permissions);
  assert.deepEqual(f.loaded, snapshot);
  assert.equal(decide("write", input, f.loaded).verdict, "ask");
});

test("network permission is independent of write permission", async (t) => {
  const f = await fixture(t);
  const input = { command: "echo ready", permissions: { network: ["example.org:443"] } };
  const d = decide("bash", input, { ...f.loaded, limits: { write: false, network: true } });
  assert.equal(d.verdict, "ask");
  assert.equal(d.permissions.write, false);
  assert.equal(permitsNetwork(d.permissions, new URL("https://example.org/data")), true);
  assert.equal(permitsNetwork(d.permissions, new URL("http://example.org/data")), false);
  assert.equal(permitsNetwork(d.permissions, new URL("https://elsewhere.org/data")), false);
});

test("child write and network ceilings are independent of approval mode", async (t) => {
  const f = await fixture(t);
  const parent = { ...f.loaded, limits: { write: true, network: true } };
  for (const permissionMode of ["auto", "manual"]) {
    assert.deepEqual(
      childPermissionLimits(parent, { permissionMode, permissions: { write: false } }),
      { write: false, network: true },
    );
    assert.deepEqual(
      childPermissionLimits(parent, { permissionMode, permissions: { network: false } }),
      { write: true, network: false },
    );
  }
  assert.throws(
    () =>
      childPermissionLimits(
        { ...parent, limits: { write: false, network: true } },
        { permissions: { write: true } },
      ),
    /write permission widened/,
  );
});

test("actual child launch policy preserves ceilings when switching resolver", async (t) => {
  const f = await fixture(t, { mode: "manual" });
  const childTmp = path.join(f.tmp, "child"),
    launchDir = path.join(f.root, "launch");
  await Promise.all([childTmp, launchDir].map((directory) => mkdir(directory)));
  const snapshot = structuredClone(f.loaded);
  const child = narrow(
    f.loaded,
    { task: "Fetch the document", permissionMode: "auto", permissions: { write: false } },
    { tmp: childTmp, tempBase: f.tmp, launchDir },
  );
  assert.equal(child.policy.mode, "auto");
  assert.deepEqual(child.limits, { write: false, network: true });
  assertNarrows(child, f.loaded);
  assert.deepEqual(f.loaded, snapshot);
  const widened = structuredClone(child);
  widened.capabilities = ["invented-capability"];
  assert.throws(() => assertNarrows(widened, f.loaded), /host capability/);
});

test("explicit action denies win before resource review or either resolver", async (t) => {
  const f = await fixture(t, { deny: [{ id: "blocked-shell", tool: "bash" }] });
  const call = {
    toolName: "bash",
    input: { command: "echo ready", permissions: { network: ["example.org:443"] } },
  };
  const d = decide(call.toolName, call.input, f.loaded);
  assert.equal(d.verdict, "deny");
  let classifierCalls = 0,
    uiCalls = 0;
  const resolver = createAskResolver({
    policy: f.loaded.policy,
    authority: () => ({}),
    classify: async () => {
      classifierCalls++;
      throw Error("must not run");
    },
  });
  t.after(() => resolver.close());
  assert.deepEqual(
    await resolver.resolve(call, d, {
      hasUI: true,
      ui: {
        select: async () => {
          uiCalls++;
          return "Allow";
        },
      },
    }),
    d,
  );
  assert.equal(classifierCalls, 0);
  assert.equal(uiCalls, 0);
});

test("resource requests cannot exceed child write or network ceilings", async (t) => {
  const f = await fixture(t);
  assert.equal(
    decide(
      "write",
      { path: path.join(f.project, "file.txt") },
      { ...f.loaded, limits: { write: false, network: true } },
    ).verdict,
    "deny",
  );
  assert.equal(
    decide(
      "bash",
      { command: "echo ready", permissions: { network: ["example.org:443"] } },
      { ...f.loaded, limits: { write: true, network: false } },
    ).verdict,
    "deny",
  );
  assert.throws(() => requestedNetwork(["example.org"], f.loaded), /hard limits/);
  assert.throws(() => requestedNetwork(["example.org:444"], f.loaded), /hard limits/);
  assert.throws(() => requestedNetwork(["elsewhere.org:443"], f.loaded), /hard limits/);
  assert.deepEqual(
    normalizePermissions(
      { write: true, network: [["example.org:443"]] },
      { ...f.loaded, limits: { write: false, network: true } },
    ),
    { write: false, network: [["example.org:443"]] },
  );
});

test("one approval is immutable, bound to arguments and cwd, and consumed only once", async (t) => {
  const f = await fixture(t);
  const bindings = new Bindings(),
    input = { command: "echo ready" };
  const decision = {
    verdict: "allow",
    reason: "approved",
    permissions: { write: false, network: [["example.org:443"]] },
  };
  bindings.put("one", "bash", input, decision, f.project);
  decision.permissions.write = true;
  const bound = bindings.take("one", "bash", input, f.project);
  assert.equal(bound.decision.permissions.write, false);
  assert.equal(Object.isFrozen(bound.decision.permissions.network[0]), true);
  assert.throws(() => bindings.take("one", "bash", input, f.project), /decided call/);
  bindings.put("two", "bash", input, decision, f.project);
  assert.throws(
    () => bindings.take("two", "bash", { command: "echo changed" }, f.project),
    /decided call/,
  );
  bindings.put("three", "bash", input, decision, f.project);
  assert.throws(() => bindings.take("three", "bash", input, f.tmp), /directory differs/);
});

test("remote tool argument permissions remain tool data, not harness resource control", async (t) => {
  const f = await fixture(t, {
    allow: [
      {
        id: "remote-access-update",
        tool: "mcp__service__update_access",
        permissions: { network: ["example.org:443"] },
      },
    ],
  });
  const input = { document: "example", permissions: { role: "reader", users: ["a-user"] } };
  const d = decide("mcp__service__update_access", input, f.loaded, ["example.org:443"]);
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.permissions, { write: false, network: [["example.org:443"]] });
  assert.deepEqual(input.permissions, { role: "reader", users: ["a-user"] });
});

test("fixed HTTPS search destinations use port-aware permissions and revoke with policy ownership", async (t) => {
  const f = await fixture(t, {
    resources: { network: ["chatgpt.com:443"] },
    allow: [
      {
        id: "search",
        tool: "codex_search",
        permissions: { write: false, network: ["chatgpt.com:443"] },
      },
    ],
  });
  let current = f.loaded;
  const input = { query: "architecture" },
    bindings = new Bindings();
  const decision = decide("codex_search", input, current);
  assert.equal(decision.verdict, "allow");
  assert.equal(decision.permissions.write, false);
  bindings.put("search-call", "codex_search", input, decision);
  const adapter = createSearchCapabilities({ bindings, getLoaded: () => current });
  t.after(() => adapter.close());
  const capability = adapter.prepareSearch({ toolCallId: "search-call", input });
  capability.assertCurrent(input);
  current = structuredClone(current);
  assert.throws(() => capability.assertCurrent(input), /expired/);
  assert.equal(capability.signal.aborted, true);
});

test("local control tools do not acquire the resource ceiling as network authority", async (t) => {
  const f = await fixture(t, { allow: [{ id: "goal-status", tool: "get_goal" }] });
  const d = decide("get_goal", {}, f.loaded);
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.permissions, { write: false, network: [] });
});

test("bound remote adapters infer exact default destinations without redundant review", async (t) => {
  const f = await fixture(t, {
    resources: { network: ["example.org:443", "elsewhere.org:443"] },
    allow: [{ id: "remote-read", tool: "mcp__service__read" }],
  });
  const d = decide("mcp__service__read", { document: "example" }, f.loaded, ["example.org:443"]);
  assert.equal(d.verdict, "allow");
  assert.deepEqual(d.permissions, { write: false, network: [["example.org:443"]] });
});

test("unnamed rules preserve matching, denials and readable diagnostics without mutating policy", async (t) => {
  const f = await fixture(t, {
    allow: [{ tool: "read" }, { tool: "get_goal" }, { tool: "bash", match: { program: "printf" } }],
    deny: [{ tool: "write" }, { tool: "bash", match: { program: "rm" } }],
  });
  const cases = [
    ["read", { path: "file.txt" }, "allow", "allow[0]"],
    ["get_goal", {}, "allow", "allow[1]"],
    ["bash", { command: "printf hello" }, "allow", "allow[2]"],
    ["write", { path: "file.txt", content: "no" }, "deny", "deny[0]"],
    ["bash", { command: "rm file.txt" }, "deny", "deny[1]"],
  ];
  for (const [tool, input, verdict, label] of cases) {
    const result = decide(tool, input, f.loaded);
    assert.equal(result.verdict, verdict);
    assert.deepEqual(result.ruleIds, [label]);
  }
  assert.ok(
    [...f.loaded.policy.allow, ...f.loaded.policy.deny].every((rule) => rule.id === undefined),
  );
});

test("optional labels validate only when supplied and never substitute for tool matching", () => {
  const p = { version: 2, mode: "manual", allow: [{ tool: "read" }, { tool: "read" }] };
  assert.doesNotThrow(() => validatePolicy(p));
  for (const id of [null, 1, "", "bad label"])
    assert.throws(() => validatePolicy({ ...p, allow: [{ id, tool: "read" }] }), /invalid id/);
  assert.throws(() => validatePolicy({ ...p, allow: [{ id: "label" }] }), /unsupported tool/);
  assert.throws(
    () =>
      validatePolicy({
        ...p,
        allow: [{ id: "same", tool: "read" }],
        deny: [{ id: "same", tool: "write" }],
      }),
    /duplicate rule id/,
  );
});

test("children inherit unnamed rules and explicit allowIds only narrows named rules", async (t) => {
  const f = await fixture(t, { allow: [{ tool: "read" }, { id: "edit-code", tool: "edit" }] });
  const tmp = path.join(f.tmp, "child"),
    launchDir = path.join(f.tmp, "launch");
  await Promise.all([tmp, launchDir].map((p) => mkdir(p)));
  const paths = { tmp, tempBase: f.tmp, launchDir };
  const inherited = narrow(f.loaded, { task: "Review the project" }, paths);
  assert.deepEqual(inherited.policy.allow, f.loaded.policy.allow);
  const selected = narrow(f.loaded, { task: "Edit the project", allowIds: ["edit-code"] }, paths);
  assert.deepEqual(selected.policy.allow, [{ id: "edit-code", tool: "edit" }]);
  assert.deepEqual(
    narrow(f.loaded, { task: "No automatic allows", allowIds: [] }, paths).policy.allow,
    [],
  );
  assert.throws(
    () => narrow(f.loaded, { task: "Invalid selector", allowIds: ["allow[0]"] }, paths),
    /unknown allow id/,
  );
});

test("public-network ceiling permits exact-host approval without granting blanket network access", async (t) => {
  const f = await fixture(t, { resources: { network: ["*"] }, allow: [{ tool: "bash" }] });
  const ordinary = decide("bash", { command: "curl https://example.net" }, f.loaded);
  assert.deepEqual(ordinary.permissions.network, []);
  const requested = decide(
    "bash",
    { command: "curl https://example.net", permissions: { network: ["example.net"] } },
    f.loaded,
  );
  assert.equal(requested.verdict, "ask");
  assert.deepEqual(requested.permissions.network, [["example.net"]]);
  assert.deepEqual(requestedNetwork(["new.example:8443"], f.loaded), ["new.example:8443"]);
  assert.deepEqual(requestedNetwork(["*"], f.loaded), ["*"]);
  const broad = await fixture(t, {
    resources: { network: ["*"] },
    allow: [{ tool: "bash", permissions: { network: ["*"] } }],
  });
  assert.deepEqual(
    decide("bash", { command: "curl https://example.net" }, broad.loaded).permissions.network,
    [["*"]],
  );
  const childTmp = path.join(f.tmp, "child");
  await mkdir(childTmp);
  const child = narrow(
    f.loaded,
    { task: "narrow public hosts", networkHosts: ["example.net"] },
    { tmp: childTmp, tempBase: f.root, launchDir: path.join(f.root, "launch") },
  );
  assertNarrows(child, f.loaded);
  assert.equal(
    decide(
      "bash",
      { command: "curl https://other.net", permissions: { network: ["other.net"] } },
      child,
    ).verdict,
    "deny",
  );
});

test("host execution is explicit, reviewed per command, and respects action denies and child ceilings", async (t) => {
  const f = await fixture(t);
  const input = { command: "codex --no-daemon login status", permissions: { execution: "host" } };
  assert.equal(decide("bash", input, f.loaded).verdict, "deny");
  f.loaded.capabilities = ["host-execution"];
  const decision = decide("bash", input, f.loaded);
  assert.equal(decision.verdict, "ask");
  assert.deepEqual(decision.permissions, { execution: "host", write: true, network: [["*"]] });
  for (const limits of [
    { write: false, network: true },
    { write: true, network: false },
  ])
    assert.equal(decide("bash", input, { ...f.loaded, limits }).verdict, "deny");
  assert.equal(
    decide("bash", { ...input, permissions: { execution: "host", write: [f.project] } }, f.loaded)
      .verdict,
    "deny",
  );
  f.loaded.policy.deny.push({ tool: "bash" });
  assert.equal(decide("bash", input, f.loaded).verdict, "deny");
});

test("host wrapping uses ordinary PATH and authentication while sandbox wrapping stays confined", async (t) => {
  const f = await fixture(t);
  f.loaded.capabilities = ["host-execution"];
  const { wrapShellAsync } = await import("../src/wrap-shell.ts");
  const host = await wrapShellAsync(
    "codex --no-daemon login status",
    { execution: "host", write: true, network: [["*"]] },
    f.loaded,
  );
  assert.equal(host.execution, "host");
  assert.equal(host.profile, "");
  assert.equal(host.argv[0], "/bin/bash");
  assert.equal(host.env.PATH, process.env.PATH);
  assert.equal(host.env.PI_SECURITY_HOST_CAPABILITIES, undefined);
  // This assertion exercises the Seatbelt backend; Linux has its own executor suite.
  if (process.platform === "darwin") {
    const constrained = await wrapShellAsync(
      "printf safe",
      { write: false, network: [] },
      f.loaded,
    );
    assert.notEqual(constrained.profile, "");
    assert.equal(constrained.execution, undefined);
  }
});
