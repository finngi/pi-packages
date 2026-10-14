import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { policy } from "./fixture.mjs";
import { loadPolicy, validatePolicy } from "../../src/policy.ts";
import { Bindings, decide } from "../../src/gate.ts";
import { compileProfile, sbplString } from "../../src/profiles.ts";
import { runKernelTrial } from "../kernel-helper.mjs";
import { linuxSandboxArgv } from "../../src/linux-executor.ts";

test("fail-closed policy, gate precedence, and one-use binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-policy-"));
  try {
    const project = path.join(root, "project"),
      tmp = path.join(root, "tmp");
    await mkdir(project);
    await mkdir(tmp);
    await assert.rejects(loadPolicy(path.join(root, "missing.json"), { project, tmp }));
    const file = path.join(root, "policy.json");
    await writeFile(file, "{");
    await assert.rejects(loadPolicy(file, { project, tmp }));
    const invalid = policy();
    invalid.resources.extra = [];
    assert.throws(() => validatePolicy(invalid), /unknown key/);
    const p = policy();
    await writeFile(file, JSON.stringify(p));
    const loaded = await loadPolicy(file, { project, tmp });
    assert.equal(
      decide("bash", { command: "cat secret.txt" }, loaded).ruleIds[0],
      "deny-cat-secret",
    );
    assert.equal(decide("bash", { command: "cat input.txt" }, loaded).permissions.write, false);
    assert.equal(
      decide("bash", { command: "cat input.txt; touch x" }, loaded).permissions.write,
      true,
    );
    const bindings = new Bindings();
    bindings.put(
      "a",
      "bash",
      { command: "cat input.txt" },
      { permissions: { write: false, network: [] } },
    );
    assert.throws(() => bindings.take("a", "bash", { command: "touch x" }), /differs/);
    assert.throws(() => bindings.take("a", "bash", { command: "cat input.txt" }), /differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy rejects timeouts that Node would clamp instead of waiting", () => {
  const tooLongHuman = policy();
  tooLongHuman.approvalTimeoutSec = 2_147_483.648;
  assert.throws(() => validatePolicy(tooLongHuman), /approvalTimeoutSec: invalid/);

  const tooLongClassifier = policy();
  tooLongClassifier.classifier.timeoutSec = 2_147_483.648;
  assert.throws(() => validatePolicy(tooLongClassifier), /classifier.timeoutSec: invalid/);

  const boundary = policy();
  boundary.approvalTimeoutSec = 2_147_483.647;
  boundary.classifier.timeoutSec = 2_147_483.647;
  assert.doesNotThrow(() => validatePolicy(boundary));
});

test(
  "compiled profile refuses outside and protected writes",
  { skip: process.platform !== "darwin" },
  async () => {
    assert.throws(() => sbplString("/tmp/evil\n(allow default)"), /unsafe/);
    const outside = await runKernelTrial({
      profile: (p) =>
        compileProfile(
          { filesystem: { writeAllow: [p.project, p.tmp], writeDeny: [], readDeny: [] } },
          { write: true, network: [] },
        ),
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", "echo nope > ../outside/nope"],
    });
    assert.equal(outside.setupFailure, null, JSON.stringify(outside.setupFailure));
    assert.notEqual(outside.process.exitCode, 0);
    assert.equal(
      outside.effects.created.some((x) => x.path === "outside/nope"),
      false,
    );
    assert.match(outside.refusal || outside.process.stderr, /not permitted|denied/i);
    const protectedWrite = await runKernelTrial({
      setup: async (p) => {
        await mkdir(path.join(p.project, "nested", ".git"), { recursive: true });
        await writeFile(path.join(p.project, "nested", ".git", "config"), "safe");
      },
      profile: (p) =>
        compileProfile(
          { filesystem: { writeAllow: [p.project, p.tmp], writeDeny: [], readDeny: [] } },
          { write: true, network: [] },
        ),
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", "echo bad > nested/AGENTS.md"],
    });
    assert.equal(protectedWrite.setupFailure, null, JSON.stringify(protectedWrite.setupFailure));
    assert.notEqual(protectedWrite.process.exitCode, 0);
    assert.equal(
      protectedWrite.effects.changed.some((x) => x.path === "project/nested/AGENTS.md"),
      false,
    );
  },
);

test("host capabilities are selected by trusted launch configuration rather than policy fields", () => {
  const p = policy();
  p.resources.gpu = true;
  assert.throws(() => validatePolicy(p), /unknown key/);
});

test("GPU profile adds only the two measured rules and preserves every other boundary", async () => {
  const root = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-security-gpu-",
    ),
  );
  try {
    const loaded = {
      policy: policy(),
      filesystem: {
        writeAllow: [root],
        writeDeny: [path.join(root, "protected")],
        readDeny: [path.join(root, "secret")],
      },
    };
    const rules =
      '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))\n' +
      '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))\n';
    loaded.policy.resources.network = ["example.com"];
    for (const permissions of [
      { write: false, network: [] },
      { write: true, network: [] },
      { write: false, network: [["example.com"]] },
      { write: true, network: [["example.com"]] },
    ]) {
      const options = permissions.network.length ? { fetchLease: { port: 12345 } } : {};
      const absent = compileProfile(loaded, permissions, options);
      loaded.capabilities = [];
      assert.equal(compileProfile(loaded, permissions, options), absent);
      assert.doesNotMatch(absent, /AGXDeviceUserClient|MTLCompilerService/);
      loaded.capabilities = ["gpu"];
      if (process.platform === "darwin") {
        const enabled = compileProfile(loaded, permissions, options);
        assert.ok(enabled.includes(rules));
        assert.equal(enabled.replace(rules, ""), absent);
      } else {
        assert.throws(
          () => compileProfile(loaded, permissions, options),
          /unsupported host capability/,
        );
      }
      delete loaded.capabilities;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux execution and policy loading refuse an explicit macOS GPU grant", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-gpu-linux-"));
  try {
    const value = policy();
    const file = path.join(root, "policy.json");
    await writeFile(file, JSON.stringify(value));
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    assert.throws(
      () =>
        linuxSandboxArgv(
          ["/bin/true"],
          { write: true, network: [] },
          { policy: value, capabilities: ["gpu"] },
        ),
      /unsupported host capability/,
    );
    await assert.rejects(
      loadPolicy(file, { project: root, tmp: root, capabilities: ["gpu"] }),
      /unsupported host capability/,
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux refuses writable shell execution before creating sandbox paths", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    assert.throws(
      () =>
        linuxSandboxArgv(["/bin/true"], { write: true, network: [] }, { policy: { scope: {} } }),
      /Bubblewrap cannot enforce write-deny rules for paths created after launch/,
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
