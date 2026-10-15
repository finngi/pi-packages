import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { policy } from "../skeleton/fixture.mjs";
import { loadPolicy } from "../../src/policy.ts";
import { createTempScope, tempIsolationRules } from "../../src/temp-scope.ts";
import { assertNarrows } from "../../src/child-policy.ts";
import { createChildLauncher, loadChildLaunch } from "../../src/child-launch.ts";
import { handleChildAsk, forwardChildAsk } from "../../src/child-ask.ts";

test("secured children do not inherit runtime injection variables", async () => {
  const fixture = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-loader-env-",
    ),
  );
  let scope;
  let launcher;
  const names = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "NODE_PATH",
    "CUDA_VISIBLE_DEVICES",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.LD_PRELOAD = "/tmp/fixture-preload.so";
    process.env.LD_LIBRARY_PATH = "/tmp/fixture-libraries";
    process.env.LD_AUDIT = "/tmp/fixture-audit.so";
    process.env.DYLD_INSERT_LIBRARIES = "/tmp/fixture-dyld.dylib";
    process.env.NODE_OPTIONS = "--require=/tmp/fixture-preload.cjs";
    process.env.NODE_PATH = "/tmp/fixture-node-modules";
    process.env.CUDA_VISIBLE_DEVICES = "3";
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const policyFile = path.join(fixture, "policy.json");
    await writeFile(policyFile, JSON.stringify(policy()));
    const parent = await loadPolicy(policyFile, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: "/fixture/extension.mjs",
      piCliPath: "/fixture/cli.js",
    });
    const launch = await launcher.prepareChildLaunch({ task: "fixture" });
    for (const name of names.slice(0, -1))
      assert.equal(launch.env[name], undefined, `${name} must not reach the child Pi process`);
    assert.equal(launch.env.CUDA_VISIBLE_DEVICES, "3");
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await launcher?.close();
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("narrowed launch data, forwarding and recursive cleanup", async () => {
  const fixture = await mkdtemp(
    path.join(await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())), "pi-u-unit-"),
  );
  let scope;
  try {
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const file = path.join(fixture, "policy.json");
    await writeFile(file, JSON.stringify(policy()));
    const parent = await loadPolicy(file, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: "/fixture/extension.mjs",
      piCliPath: "/fixture/cli.js",
    });
    const launch = await launcher.prepareChildLaunch({
      task: "untrusted fixture task",
      allowIds: ["cat", "touch"],
      permissions: { write: true, network: false },
    });
    const loaded = await loadChildLaunch({ env: launch.env, loadPolicy });
    assert.equal(loaded.launchId, launch.id);
    assert.deepEqual(loaded.filesystem.writeAllow, [launch.tmp]);
    assert.match(tempIsolationRules(loaded.tempIsolation), /require-not/);
    await assert.rejects(
      launcher.prepareChildLaunch({ task: "widen", writeAllow: [scope.tmp] }),
      /widened/,
    );
    await assert.rejects(
      launcher.prepareChildLaunch({ task: "widen", networkHosts: ["evil.invalid"] }),
      /widened/,
    );
    const corrupted = structuredClone(loaded);
    corrupted.policy.allow.push({
      id: "x",
      tool: "bash",
      permissions: { write: true, network: [["example.com"]] },
    });
    assert.throws(() => assertNarrows(corrupted, parent));
    let requests = 0;
    const decision = await forwardChildAsk({
      call: { toolCallId: "a", toolName: "bash", input: { command: "printf fixture" } },
      decision: { verdict: "ask", permissions: { write: true, network: [] } },
      childLoaded: loaded,
      ctx: {
        hasUI: true,
        ui: {
          select: async (title, options) => {
            const request = { id: "rpc-a", method: "select", title, options };
            const response = await handleChildAsk({
              request,
              launch,
              parentCheck: async () => ({ verdict: "ask", ruleIds: [] }),
              parentResolve: async () => {
                requests++;
                return { verdict: "allow", permissions: { write: true, network: [] } };
              },
            });
            assert.equal(
              (
                await handleChildAsk({
                  request,
                  launch,
                  parentCheck: async () => ({ verdict: "ask" }),
                  parentResolve: async () => {
                    throw Error("replay");
                  },
                })
              ).value,
              "Deny",
            );
            return response.value;
          },
        },
      },
    });
    assert.deepEqual(decision.permissions, { write: true, network: [] });
    assert.equal(requests, 1);
    const grandchild = await scope.allocateChild(launch.tmp);
    await writeFile(path.join(grandchild, "marker"), "fixture");
    await launch.cleanup();
    await assert.rejects(readFile(path.join(grandchild, "marker")));
    const launch2 = await launcher.prepareChildLaunch({ task: "tamper" });
    const payload = JSON.parse(launch2.env.PI_POLICY_LAUNCH);
    await writeFile(payload.path, "{}");
    await assert.rejects(loadChildLaunch({ env: launch2.env, loadPolicy }), /hash/);
    await launcher.close();
    await scope.close();
    scope = undefined;
  } finally {
    if (scope) await scope.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed artifact collection retains only the workspace and scrubs child credentials", async () => {
  const fixture = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-retain-child-",
    ),
  );
  let scope;
  try {
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const policyFile = path.join(fixture, "policy.json");
    await writeFile(policyFile, JSON.stringify(policy()));
    const parent = await loadPolicy(policyFile, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const model = {
      id: "fixture-model",
      name: "Fixture model",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: "/fixture/extension.mjs",
      piCliPath: "/fixture/cli.js",
      parentResources: {
        tools: ["read"],
        skills: [],
        model: { provider: model.provider, id: model.id },
        models: [model],
        thinking: "off",
      },
      resolveAuth: async () => ({
        model,
        auth: { ok: true, apiKey: "fixture-child-secret", headers: {} },
      }),
    });
    const launch = await launcher.prepareChildLaunch({ task: "fixture", tools: [], skills: [] });
    const marker = path.join(launch.tmp, "inspect-after-failure.txt");
    await writeFile(marker, "workspace retained");
    const authPath = JSON.parse(launch.env.PI_SECURITY_CHILD_AUTH).path;
    const manifestPath = JSON.parse(launch.env.PI_POLICY_LAUNCH).path;
    const launchDirectory = launch.childLoaded.launchResources.directory;
    let collectionAttempts = 0;
    launch.beforeCleanup(async () => {
      if (collectionAttempts++ === 0) throw Error("fixture collection limit");
    });

    await assert.rejects(launcher.close(), (error) => {
      assert.match(error.message, /One or more child launches failed to clean up/);
      assert.match(
        String(error.errors?.[0]),
        /Artifact collection failed.*scratch workspace path left untouched at/,
      );
      return true;
    });
    assert.equal(await readFile(marker, "utf8"), "workspace retained");
    await assert.rejects(readFile(authPath), { code: "ENOENT" });
    await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(launchDirectory, "child.json")), { code: "ENOENT" });
    await assert.rejects(
      readFile(path.join(scope.launchDir, "credentials", path.basename(authPath))),
      { code: "ENOENT" },
    );
    await chmod(launch.tmp, 0o700);
    await launch.cleanup();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await scope.close();
  } finally {
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("resources distinguish inheritance and empty lists and refuse unsupported settings before allocation", async () => {
  const fixture = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-resource-unit-",
    ),
  );
  let scope;
  try {
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const file = path.join(fixture, "policy.json");
    await writeFile(file, JSON.stringify(policy()));
    const parent = await loadPolicy(file, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const skill = path.join(fixture, "SKILL.md");
    await writeFile(skill, "---\nname: chosen\ndescription: fixture skill\n---\nChosen body");
    const resources = {
      tools: ["read", "bash"],
      skills: [{ name: "chosen", path: skill }],
      thinking: "off",
    };
    const launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: "/fixture/extension.mjs",
      piCliPath: "/fixture/cli.js",
      parentResources: resources,
    });
    const inherited = await launcher.prepareChildLaunch({
      task: "untrusted",
      instructions: "Trusted body",
    });
    assert.deepEqual(inherited.childLoaded.resources.tools, ["read", "bash"]);
    assert.equal(inherited.childLoaded.resources.skills.length, 1);
    assert.equal(inherited.argv.filter((x) => x === "--skill").length, 1);
    assert.ok(inherited.argv.includes("--no-context-files"));
    const preview = await launcher.describeChild({
      task: "preview",
      permissions: { write: false, network: false },
    });
    assert.deepEqual(preview.scope.permissions, { write: false, network: false });
    assert.equal(preview.scope.mode, "auto");
    assert.equal(preview.scope.write, "none");
    assert.equal(launcher.launches.size, 1);
    const badRoots = structuredClone(inherited.childLoaded);
    badRoots.tempIsolation.resourceReadAllow = [scope.launchDir];
    assert.throws(
      () => assertNarrows(badRoots, { ...parent, resourceAuthority: resources }),
      /read roots widened/,
    );
    const badTools = structuredClone(inherited.childLoaded);
    badTools.resources.tools.push("write");
    assert.throws(
      () => assertNarrows(badTools, { ...parent, resourceAuthority: resources }),
      /selected tools widened/,
    );
    const empty = await launcher.prepareChildLaunch({
      task: "untrusted",
      tools: [],
      skills: [],
      permissions: { write: false, network: false },
    });
    assert.deepEqual(empty.childLoaded.resources.tools, []);
    assert.deepEqual(empty.childLoaded.limits, { write: false, network: false });
    assert.ok(!empty.argv.includes("--skill"));
    for (const spec of [
      { tools: ["write"] },
      { skills: ["unselected"] },
      { model: { provider: "missing", id: "model" } },
      { thinking: "high" },
      { permissionMode: "full-access" },
      { permissionMode: "dangerously-unrestricted" },
    ])
      await assert.rejects(
        launcher.prepareChildLaunch({ task: "bad", ...spec }),
        /unavailable|widened|unsupported/,
      );
    assert.equal(launcher.launches.size, 2);
    const instructionPath = inherited.childLoaded.launchResources.instructions.path;
    await (await import("node:fs/promises")).chmod(instructionPath, 0o600);
    await writeFile(instructionPath, "changed");
    await assert.rejects(loadChildLaunch({ env: inherited.env, loadPolicy }), /resource hash/);
    await launcher.close();
  } finally {
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("private bundle skills are attested to one protected launch and cannot widen child access", async () => {
  const fixture = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-private-bundle-",
    ),
  );
  let scope;
  try {
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const policyFile = path.join(fixture, "policy.json");
    await writeFile(policyFile, JSON.stringify(policy()));
    const parent = await loadPolicy(policyFile, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const bundleRoot = path.join(fixture, "reviewer");
    const skillPath = path.join(bundleRoot, "skills", "private", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: private\ndescription: fixture\n---\nPrivate instructions",
    );
    const launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: "/fixture/extension.mjs",
      piCliPath: "/fixture/cli.js",
      parentResources: { tools: ["read"], skills: [], thinking: "off" },
    });
    const launch = await launcher.prepareChildLaunch({
      task: "fixture",
      skills: ["private"],
      agentBundle: { root: bundleRoot, privateSkills: [{ name: "private", path: skillPath }] },
    });
    const protectedBundle = launch.childLoaded.launchResources.bundle;
    assert.ok(protectedBundle);
    assert.deepEqual(
      protectedBundle.skills.map(({ name }) => name),
      ["private"],
    );
    const trustedParent = {
      ...launch.parentLoaded,
      resourceAuthority: {
        tools: ["read"],
        skills: [],
        privateSkills: [{ name: "private", path: skillPath }],
      },
    };
    assert.doesNotThrow(() => assertNarrows(launch.childLoaded, trustedParent));

    const forgedExtra = structuredClone(launch.childLoaded);
    forgedExtra.resources.skills.push({
      name: "extra",
      path: path.join(bundleRoot, "skills/extra/SKILL.md"),
    });
    assert.throws(() => assertNarrows(forgedExtra, trustedParent), /selected skills widened/);

    const otherLaunch = structuredClone(launch.childLoaded);
    otherLaunch.launchResources.bundle.path = path.join(
      scope.launchDir,
      "another-launch",
      "bundles",
      "agent",
    );
    assert.throws(
      () => assertNarrows(otherLaunch, trustedParent),
      /invalid protected agent bundle/,
    );

    const metadataMismatch = structuredClone(launch.childLoaded);
    metadataMismatch.launchResources.bundle.sourceRoot = fixture;
    assert.throws(
      () => assertNarrows(metadataMismatch, trustedParent),
      /private bundle metadata mismatch|invalid protected bundle skill/,
    );
    await launcher.close();
  } finally {
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("child manifests preserve GPU scope and reject grants absent from the parent", async () => {
  const fixture = await mkdtemp(
    path.join(
      await import("node:fs/promises").then((x) => x.realpath(os.tmpdir())),
      "pi-gpu-child-",
    ),
  );
  let scope, launcher;
  try {
    scope = await createTempScope({ base: path.join(fixture, "base") });
    for (const gpu of [undefined, false, ...(process.platform === "darwin" ? [true] : [])]) {
      const value = policy();
      const file = path.join(fixture, "policy.json");
      await writeFile(file, JSON.stringify(value));
      const parent = await loadPolicy(file, {
        project: scope.tmp,
        tmp: scope.tmp,
        capabilities: gpu ? ["gpu"] : [],
      });
      parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
      launcher = createChildLauncher({
        parentLoaded: parent,
        tempScope: scope,
        extensionPath: "/fixture/extension.mjs",
        piCliPath: "/fixture/cli.js",
      });
      const preview = await launcher.describeChild({ task: "preview" });
      assert.equal(preview.scope.capabilities.includes("gpu"), gpu === true);
      const launch = await launcher.prepareChildLaunch({ task: "GPU inheritance" });
      const loaded = await loadChildLaunch({ env: launch.env, loadPolicy });
      assert.deepEqual(loaded.capabilities, parent.capabilities);
      const widened = structuredClone(loaded);
      widened.capabilities = ["gpu"];
      if (gpu !== true)
        assert.throws(
          () => assertNarrows(widened, parent),
          process.platform === "darwin"
            ? /host capabilities widened/
            : /unsupported host capability/,
        );
      const narrowed = structuredClone(loaded);
      narrowed.capabilities = [];
      assert.doesNotThrow(() => assertNarrows(narrowed, parent));
      for (const invalid of ["gpu", ["unknown"]]) {
        const malformed = structuredClone(loaded);
        malformed.capabilities = invalid;
        assert.throws(() => assertNarrows(malformed, parent), /unsupported host capability/);
      }
      await launcher.close();
      launcher = undefined;
    }
  } finally {
    await launcher?.close();
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("child process transport is explicit, not inherited without its extension", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-child-transport-")));
  let scope, internal, external;
  const old = process.env.PI_SECURITY_TRANSPORT;
  try {
    process.env.PI_SECURITY_TRANSPORT = "extensions";
    scope = await createTempScope({ base: path.join(root, "base") });
    const file = path.join(root, "policy.json");
    await writeFile(file, JSON.stringify(policy()));
    const loaded = await loadPolicy(file, { project: scope.tmp, tmp: scope.tmp });
    const options = {
      parentLoaded: loaded,
      tempScope: scope,
      extensionPath: "/fixture/security.ts",
      piCliPath: "/fixture/cli.js",
    };
    internal = createChildLauncher(options);
    const a = await internal.prepareChildLaunch({ task: "internal" });
    assert.equal(a.env.PI_SECURITY_TRANSPORT, "internal");
    external = createChildLauncher({
      ...options,
      processExtension: () => "/fixture/background.ts",
    });
    const b = await external.prepareChildLaunch({ task: "external" });
    assert.equal(b.env.PI_SECURITY_TRANSPORT, "extensions");
    const index = b.argv.indexOf("/fixture/background.ts");
    assert.ok(index > 0);
    assert.equal(b.argv[index - 1], "-e");
  } finally {
    if (old === undefined) delete process.env.PI_SECURITY_TRANSPORT;
    else process.env.PI_SECURITY_TRANSPORT = old;
    await internal?.close();
    await external?.close();
    await scope?.close();
    await rm(root, { recursive: true, force: true });
  }
});
