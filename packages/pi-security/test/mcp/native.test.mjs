import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpClient } from "@earendil-works/pi-mcp";
import { createMcpCapability } from "../../src/mcp-capability.ts";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}
async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function response(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

test("Pi native MCP HTTP transport requires a live one-shot dispatch ticket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-mcp-native-"));
  const home = path.join(root, "home"),
    agentDir = path.join(root, "agent");
  await Promise.all([mkdir(home), mkdir(agentDir)]);
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const calls = {
    initialize: 0,
    list: 0,
    tool: 0,
    resourceList: 0,
    resourceRead: 0,
    redirectTarget: 0,
  };
  let redirect = false,
    authMode = false;
  const target = createServer((_req, res) => {
    calls.redirectTarget++;
    response(res, 200, {});
  });
  const targetUrl = await listen(target);
  let allowedAuthCalls = 0,
    deniedAuthCalls = 0;
  const allowedAuthServer = createServer((_req, res) => {
    allowedAuthCalls++;
    response(res, 200, { ok: true });
  });
  const deniedAuthServer = createServer((_req, res) => {
    deniedAuthCalls++;
    response(res, 200, { ok: true });
  });
  const allowedAuthUrl = await listen(allowedAuthServer);
  const deniedAuthUrl = await listen(deniedAuthServer);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "DELETE") return response(res, 200, {});
    if (req.method !== "POST") return response(res, 405, {});
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.method === "initialize") {
      calls.initialize++;
      return response(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        { "mcp-session-id": "fixture-session" },
      );
    }
    if (message.method === "notifications/initialized") return response(res, 202);
    if (message.method === "tools/list") {
      calls.list++;
      return response(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
          ],
        },
      });
    }
    if (message.method === "resources/list") {
      calls.resourceList++;
      if (message.params?.cursor === "next")
        return response(res, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { resources: [{ uri: "fixture://two", name: "two" }] },
        });
      return response(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { resources: [{ uri: "fixture://one", name: "one" }], nextCursor: "next" },
      });
    }
    if (message.method === "resources/read") {
      calls.resourceRead++;
      return response(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { contents: [{ uri: message.params.uri, text: "resource" }] },
      });
    }
    if (message.method === "tools/call") {
      calls.tool++;
      if (authMode && req.headers.authorization !== "Bearer refreshed") {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer error="invalid_token"',
        });
        res.end("{}");
        return;
      }
      if (redirect) {
        redirect = false;
        res.writeHead(302, { location: targetUrl });
        res.end();
        return;
      }
      return response(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: message.params.arguments.value }] },
      });
    }
    return response(res, 200, { jsonrpc: "2.0", id: message.id, result: {} });
  });
  const endpoint = await listen(server);
  const port = new URL(endpoint).port;
  const allowedAuthPort = new URL(allowedAuthUrl).port;
  await writeFile(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { url: endpoint } } }),
  );
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir });
  let active = true;
  const loaded = {
    policy: { resources: { network: [`127.0.0.1:${port}`, `127.0.0.1:${allowedAuthPort}`] } },
    sha256: "test",
  };
  const capability = createMcpCapability({
    getLoaded: () => loaded,
    isCurrent: () => active,
    enabled: () => true,
    isRegisteredOwner: async () => true,
  });
  let client;
  try {
    const config = capability.loadConfig({ cwd: root, isProjectTrusted: () => false });
    assert.equal(config.errors.length, 0, JSON.stringify(config.errors));
    assert.equal(config.autoEnableCodemode, false);
    assert.equal(config.servers[0].config.exposure, "deferred");
    const registered = new Map();
    const facade = capability.wrapApi({
      registerTool(definition) {
        registered.set(definition.name, {
          ...definition,
          sourceInfo: {
            path: "pi-security-extension",
            source: "extension",
            scope: "user",
            origin: "top-level",
          },
        });
      },
      getAllTools() {
        return [...registered.values()];
      },
    });
    const toolDefinition = {
      name: "mcp__fixture__echo",
      label: "fixture/echo",
      namespace: { name: "mcp__fixture" },
      exposure: "deferred",
      execute(id, params) {
        return client.callTool("echo", params);
      },
    };
    facade.registerTool(toolDefinition);
    for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])
      facade.registerTool({
        name,
        label: name,
        execute(id, params) {
          if (name === "list_mcp_resources") return client.listResourcesPage(params.cursor);
          if (name === "read_mcp_resource") return client.readResource(params.uri);
          throw Error("resource templates are not used by this fixture");
        },
      });
    const toolInfo = registered.get(toolDefinition.name);
    const resourceInfo = (name) => registered.get(name);
    const transport = capability.transport(config.servers[0], root);
    client = new McpClient({ name: "test-client", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed[0].name, "echo");
    assert.equal(calls.initialize, 1);
    assert.equal(calls.list, 1);

    await assert.rejects(client.callTool("echo", { value: "denied" }));
    assert.equal(calls.tool, 0, "unapproved calls must not reach the server");

    capability.issue("approved-call", "mcp__fixture__echo", { value: "allowed" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    const result = await registered
      .get("mcp__fixture__echo")
      .execute("approved-call", { value: "allowed" });
    assert.equal(result.content[0].text, "allowed");
    assert.equal(calls.tool, 1);
    capability.revoke("approved-call");

    capability.issue("wrong-execution-id", "mcp__fixture__echo", { value: "wrong-id" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    await assert.rejects(
      registered.get("mcp__fixture__echo").execute("different-id", { value: "wrong-id" }),
    );
    assert.equal(calls.tool, 1, "a different tool call ID cannot consume an admitted operation");
    capability.revoke("wrong-execution-id");

    capability.issue("parallel-one", "mcp__fixture__echo", { value: "same" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    capability.issue("parallel-two", "mcp__fixture__echo", { value: "same" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    const [parallelOne, parallelTwo] = await Promise.all([
      registered.get("mcp__fixture__echo").execute("parallel-one", { value: "same" }),
      registered.get("mcp__fixture__echo").execute("parallel-two", { value: "same" }),
    ]);
    assert.equal(parallelOne.content[0].text, "same");
    assert.equal(parallelTwo.content[0].text, "same");
    assert.equal(calls.tool, 3, "identical concurrent calls retain separate approvals");
    capability.revoke("parallel-one");
    capability.revoke("parallel-two");

    let token,
      refreshes = 0;
    const authClient = new McpClient({ name: "auth-client", version: "1" });
    await authClient.connect(
      capability.transport(config.servers[0], root, {
        token: async () => token,
        async onUnauthorized(context) {
          await context.fetch(deniedAuthUrl, { method: "POST" });
          refreshes++;
          token = "refreshed";
        },
        async settled() {},
      }),
    );
    await authClient.listTools();
    authMode = true;
    client = authClient;
    capability.issue("oauth-denied", "mcp__fixture__echo", { value: "oauth-denied" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    await assert.rejects(
      registered.get("mcp__fixture__echo").execute("oauth-denied", { value: "oauth-denied" }),
      /network.tools/,
    );
    assert.equal(deniedAuthCalls, 0, "off-policy OAuth targets must receive no request");
    capability.revoke("oauth-denied");
    await authClient.close();

    const allowedAuthClient = new McpClient({ name: "auth-allowed-client", version: "1" });
    await allowedAuthClient.connect(
      capability.transport(config.servers[0], root, {
        token: async () => token,
        async onUnauthorized(context) {
          const response = await context.fetch(allowedAuthUrl, { method: "POST" });
          assert.equal(response.ok, true);
          refreshes++;
          token = "refreshed";
        },
        async settled() {},
      }),
    );
    await allowedAuthClient.listTools();
    client = allowedAuthClient;
    const authResultInput = { value: "oauth" };
    capability.issue("oauth-retry", "mcp__fixture__echo", authResultInput, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    const authResult = await registered
      .get("mcp__fixture__echo")
      .execute("oauth-retry", authResultInput);
    assert.equal(authResult.content[0].text, "oauth");
    assert.equal(refreshes, 1);
    assert.equal(
      allowedAuthCalls,
      1,
      "permitted OAuth helper requests use an explicitly allowed host",
    );
    assert.equal(calls.tool, 6, "one 401 refresh retry reuses the same logical ticket");
    authMode = false;
    capability.revoke("oauth-retry");
    await allowedAuthClient.close();
    await client.close();
    client = new McpClient({ name: "test-client-two", version: "1" });
    await client.connect(capability.transport(config.servers[0], root));
    await client.listTools();

    assert.throws(
      () =>
        capability.issueResource(
          "missing-server",
          "list_mcp_resources",
          "resources/list",
          {},
          resourceInfo("list_mcp_resources"),
          { write: false, network: [loaded.policy.resources.network] },
        ),
      /server/,
    );
    assert.equal(
      calls.resourceList,
      0,
      "resource listing without a bound server must not dispatch",
    );
    capability.issueResource(
      "resource-list",
      "list_mcp_resources",
      "resources/list",
      { server: "fixture" },
      resourceInfo("list_mcp_resources"),
      { write: false, network: [loaded.policy.resources.network] },
    );
    const resources = await registered
      .get("list_mcp_resources")
      .execute("resource-list", { server: "fixture" });
    assert.equal(resources.resources[0].uri, "fixture://one");
    assert.equal(resources.nextCursor, "next");
    assert.equal(calls.resourceList, 1);
    capability.revoke("resource-list");
    capability.issueResource(
      "resource-list-next",
      "list_mcp_resources",
      "resources/list",
      { server: "fixture", cursor: resources.nextCursor },
      resourceInfo("list_mcp_resources"),
      { write: false, network: [loaded.policy.resources.network] },
    );
    const nextResources = await registered.get("list_mcp_resources").execute("resource-list-next", {
      server: "fixture",
      cursor: resources.nextCursor,
    });
    assert.equal(nextResources.resources[0].uri, "fixture://two");
    assert.equal(
      calls.resourceList,
      2,
      "selected-server resource pagination gets its own dispatch ticket",
    );
    capability.revoke("resource-list-next");
    capability.issueResource(
      "resource-read",
      "read_mcp_resource",
      "resources/read",
      { server: "fixture", uri: "fixture://one" },
      resourceInfo("read_mcp_resource"),
      { write: false, network: [loaded.policy.resources.network] },
    );
    const resource = await registered
      .get("read_mcp_resource")
      .execute("resource-read", { server: "fixture", uri: "fixture://one" });
    assert.equal(resource.contents[0].text, "resource");
    assert.equal(calls.resourceRead, 1);
    capability.revoke("resource-read");

    capability.issue("mismatch-call", "mcp__fixture__echo", { value: "approved" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    await assert.rejects(
      registered.get("mcp__fixture__echo").execute("mismatch-call", { value: "changed" }),
    );
    assert.equal(calls.tool, 6, "changed params must fail before outbound dispatch");
    capability.revoke("mismatch-call");

    capability.issue("redirect-call", "mcp__fixture__echo", { value: "redirect" }, toolInfo, {
      write: false,
      network: [loaded.policy.resources.network],
    });
    redirect = true;
    await assert.rejects(
      registered.get("mcp__fixture__echo").execute("redirect-call", { value: "redirect" }),
    );
    assert.equal(calls.redirectTarget, 0, "redirect targets must never receive the request");
    capability.revoke("redirect-call");

    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { fixture: { url: endpoint, description: "changed after admission" } },
      }),
    );
    capability.issue(
      "changed-config-call",
      "mcp__fixture__echo",
      { value: "stale-config" },
      toolInfo,
      { write: false, network: [loaded.policy.resources.network] },
    );
    await assert.rejects(
      registered
        .get("mcp__fixture__echo")
        .execute("changed-config-call", { value: "stale-config" }),
      /stale|policy/,
    );
    assert.equal(calls.tool, 7, "changed MCP config fails before SDK execution");
    capability.revoke("changed-config-call");

    active = false;
    capability.clear();
    assert.throws(
      () => capability.issue("stale-call", "mcp__fixture__echo", { value: "stale" }, toolInfo),
      /stale/,
    );
    assert.equal(calls.tool, 7, "stale authorization must not dispatch");
  } finally {
    active = false;
    capability.clear();
    await client?.close();
    await close(server);
    await close(target);
    await close(allowedAuthServer);
    await close(deniedAuthServer);
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});

test("MCP configuration reports the security startup failure instead of implying a missing policy", () => {
  const reason = "Security tool registrations do not match the loaded pi-security extension: bash.";
  const capability = createMcpCapability({
    getLoaded: () => undefined,
    getUnavailableReason: () => reason,
    isCurrent: () => false,
    enabled: () => true,
    isRegisteredOwner: async () => false,
  });
  const config = capability.loadConfig({ cwd: "/tmp", isProjectTrusted: () => false });
  assert.deepEqual(config.errors, [`pi-security could not initialize: ${reason}`]);
});
