import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupNativeLaunch } from "./native-launcher.ts";

test("failed artifact collection retains scratch files and removes native child metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-cleanup-"));
  const privateTmp = join(root, "workspace"),
    configuration = join(root, "launch"),
    agentDir = join(root, "agent");
  try {
    await Promise.all([mkdir(privateTmp), mkdir(configuration), mkdir(agentDir)]);
    await writeFile(join(privateTmp, "work.txt"), "recoverable work");
    await writeFile(join(configuration, "auth.json"), "child secret");
    await writeFile(join(configuration, "launch.json"), "child launch metadata");
    await writeFile(join(agentDir, "config.json"), "child configuration");

    await assert.rejects(
      cleanupNativeLaunch({
        root,
        privateTmp,
        configuration,
        agentDir,
        beforeCleanup: async () => {
          throw Error("collection failed");
        },
      }),
      /scratch workspace path left untouched at/,
    );

    assert.equal(await readFile(join(privateTmp, "work.txt"), "utf8"), "recoverable work");
    await assert.rejects(readFile(join(configuration, "auth.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(configuration, "launch.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(agentDir, "config.json")), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), ["workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native child cleanup can retry after a transient collection failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-retry-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const model = {
    id: "fixture-model",
    provider: "fixture-provider",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const modelRegistry = {
    find: () => model,
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => undefined,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-only", headers: {} }),
    getAvailableOfType: async () => [model],
  };
  const pi = {
    events: { emit() {} },
    getActiveTools: () => ["read"],
    getCommands: () => [],
    getThinkingLevel: () => "off",
  };
  const { createNativeLauncher } = await import("./native-launcher.ts");
  const launcher = createNativeLauncher(
    pi as any,
    () => ({ cwd, model, modelRegistry }) as any,
    "/fixture/subagent-messaging.js",
  );
  try {
    const prepared = await launcher.prepareChildLaunch({
      task: "fixture task",
      communication: {
        id: "agent-bright-coral-river",
        name: "fixture",
        parentId: "agent-calm-silver-forest",
        parentName: "main",
      },
    });
    const marker = join(prepared.tmp, "recoverable.txt");
    await writeFile(marker, "recoverable work");
    let attempts = 0;
    prepared.beforeCleanup?.(async () => {
      if (attempts++ === 0) throw Error("transient collection failure");
    });
    await assert.rejects(prepared.cleanup(), /scratch workspace path left untouched/);
    assert.equal(await readFile(marker, "utf8"), "recoverable work");
    await prepared.cleanup();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
