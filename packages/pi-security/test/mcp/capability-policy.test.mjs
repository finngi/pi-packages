import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpCapability } from "../../src/mcp-capability.ts";

async function inspect(url, tools) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-mcp-policy-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(home), mkdir(agentDir)]);
  await writeFile(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { url } } }),
  );
  const savedHome = process.env.HOME;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const capability = createMcpCapability({
    getLoaded: () => ({ policy: { resources: { network: tools } } }),
    isCurrent: () => true,
    enabled: () => true,
    isRegisteredOwner: async () => true,
  });
  try {
    const config = capability.loadConfig({ cwd: root, isProjectTrusted: () => false });
    return { accepted: config.servers.length === 1, errors: config.errors };
  } finally {
    capability.clear();
    savedHome === undefined ? delete process.env.HOME : (process.env.HOME = savedHome);
    savedAgentDir === undefined
      ? delete process.env.PI_CODING_AGENT_DIR
      : (process.env.PI_CODING_AGENT_DIR = savedAgentDir);
    await rm(root, { recursive: true, force: true });
  }
}

test("bare MCP host grants cover standard ports only; explicit ports are exact", async () => {
  for (const url of ["http://example.com/mcp", "https://example.com/mcp"]) {
    const result = await inspect(url, ["example.com"]);
    assert.equal(result.accepted, true, `${url} should use its standard port`);
  }

  for (const url of ["http://example.com:8443/mcp", "https://example.com:8443/mcp"]) {
    const result = await inspect(url, ["example.com"]);
    assert.equal(result.accepted, false, `${url} requires an explicit port grant`);
    assert.match(result.errors.join("\n"), /outside policy\.resources\.network/);
  }

  assert.equal((await inspect("http://example.com:8443/mcp", ["example.com:8443"])).accepted, true);
  assert.equal(
    (await inspect("http://example.com:8444/mcp", ["example.com:8443"])).accepted,
    false,
  );
  assert.equal((await inspect("https://example.com/mcp", ["example.com:443"])).accepted, true);
  assert.equal(
    (await inspect("http://[2606:4700:4700::1111]:8443/mcp", ["[2606:4700:4700::1111]:8443"]))
      .accepted,
    true,
  );
});
