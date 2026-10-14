import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
test("explain prints read-only and diagnostic fetch profiles without executing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-i-explain-"));
  const home = path.join(root, "home"),
    agent = path.join(root, "agent"),
    project = path.join(root, "project"),
    cache = path.join(root, "cache");
  try {
    await Promise.all([home, agent, project, cache].map((p) => mkdir(p, { mode: 0o700 })));
    const example = JSON.parse(
      await readFile(new URL("../../src/example-policy.json", import.meta.url), "utf8"),
    );
    const policyPath = path.join(agent, "policy.json");
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_SECURITY_POLICY: policyPath,
      TMPDIR: cache,
      XDG_CACHE_HOME: cache,
      npm_config_cache: cache,
    };
    await writeFile(policyPath, JSON.stringify(example));
    const read = spawnSync(process.execPath, [cli, "explain", "git status"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(read.status, 0, read.stderr);
    const first = JSON.parse(read.stdout.split("\n")[0]);
    assert.equal(first.permissions.write, false);
    assert.deepEqual(first.ruleIds, ["allow[5]"]);
    assert.match(read.stdout, /\(deny default\)/);
    const fetch = {
      ...example,
      deny: [],
      allow: [
        {
          id: "fixture-fetch",
          tool: "bash",
          match: { program: "curl" },
          permissions: { write: true, network: ["example.com"] },
        },
      ],
    };
    fetch.resources.network = ["example.com"];
    await writeFile(policyPath, JSON.stringify(fetch));
    const result = spawnSync(process.execPath, [cli, "explain", "curl https://example.com"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const diagnostic = JSON.parse(result.stdout.split("\n")[0]);
    assert.equal(diagnostic.permissions.write, true);
    assert.deepEqual(diagnostic.ruleIds, ["fixture-fetch"]);
    assert.equal(diagnostic.proxyPort, "allocated-at-execution");
    assert.equal(diagnostic.diagnosticProfilePort, 65535);
    assert.match(result.stdout, /\(remote ip "localhost:65535"\)/);
    assert.match(result.stdout, /\(deny default\)/);
    assert.match(result.stdout, /com\.apple\.trustd\.agent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
