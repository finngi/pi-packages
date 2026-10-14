import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("stock package loader accepts host SDK peer metadata without duplicate-runtime warnings", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-package-"))),
    saved = { ...process.env };
  try {
    const agent = join(root, "agent"),
      cwd = join(root, "project"),
      cache = join(agent, "git/github.com/finngi2/pi-packages");
    await Promise.all([mkdir(dirname(cache), { recursive: true }), mkdir(cwd)]);
    const packageRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    await symlink(packageRoot, cache);
    Object.assign(process.env, {
      HOME: root,
      PI_CODING_AGENT_DIR: agent,
      PI_SECURITY_ACTIVATION: "active",
      PI_SECURITY_PLACEMENT: "host",
      PI_SECURITY_TRANSPORT: "extensions",
    });
    delete process.env.PI_POLICY_LAUNCH;
    delete process.env.PI_SUBAGENT;
    const sdk = await import("@earendil-works/pi-coding-agent");
    const source = "git:https://github.com/finngi2/pi-packages@fixture";
    const settings = sdk.SettingsManager.inMemory({ packages: [source] });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: agent,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [join(cache, "packages/pi-security/src/extension.ts")],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].path, join(cache, "packages/pi-security/src/extension.ts"));
    assert.deepEqual([...result.extensions[0].tools.keys()].sort(), [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
