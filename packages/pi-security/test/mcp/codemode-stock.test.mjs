import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policy } from "../skeleton/fixture.mjs";

// Real stock CLI, QuickJS sandbox, nested Pi dispatch and local HTTP MCP transport.
// The worker and classifier providers return fixtures; no account credentials are used.
for (const exposure of ["server", "tool", "missing"])
  test(`stock codemode retains per-tool permissions and bound MCP ${exposure} exposure with models enabled`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-security-codemode-")));
    const [project, home, agent, tmp] = ["project", "home", "agent", "tmp"].map((name) =>
      path.join(root, name),
    );
    await Promise.all([project, home, agent, tmp].map((dir) => mkdir(dir)));
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const send = (result, id, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (req.method === "DELETE") return send({});
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (rpc.method === "initialize")
        return send(
          {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
          rpc.id,
        );
      if (rpc.method === "notifications/initialized") return send({}, undefined, 202);
      if (rpc.method === "tools/list")
        return send(
          {
            tools: ["echo", "denied"].map((name) => ({
              name,
              description: name,
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            })),
          },
          rpc.id,
        );
      if (rpc.method === "tools/call") {
        requests.push(rpc.params);
        return send({ content: [{ type: "text", text: rpc.params.arguments.value }] }, rpc.id);
      }
      return send({}, rpc.id);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let child;
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
      const outside = path.join(root, "outside.txt");
      await writeFile(path.join(project, "permitted.txt"), "permitted read");
      await writeFile(path.join(project, "secret.txt"), "secret fixture");
      const p = policy();
      p.resources.denyRead = [path.join(project, "secret.txt")];
      p.resources.network = [`127.0.0.1:${server.address().port}`];
      p.allow.push(
        { id: "wrapper", tool: "codemode" },
        { id: "read", tool: "read" },
        {
          id: "echo",
          tool: "mcp__fixture__echo",
          permissions: { write: false, network: p.resources.network },
        },
      );
      p.deny.push({ id: "mcp-denied", tool: "mcp__fixture__denied" });
      await writeFile(path.join(agent, "policy.json"), JSON.stringify(p));
      await writeFile(
        path.join(agent, "settings.json"),
        JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] }),
      );
      await writeFile(
        path.join(agent, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: {
              url: endpoint,
              exposure: exposure === "server" ? "codemode" : "deferred",
              ...(exposure === "tool"
                ? { toolExposure: { echo: "codemode", denied: "codemode" } }
                : {}),
            },
          },
        }),
      );
      const chat = {
        id: "worker",
        name: "Worker",
        api: "codemode-test-chat",
        provider: "codemode-test",
        baseUrl: "http://invalid.local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      };
      const classifier = {
        id: "judge",
        name: "Judge",
        type: "classifier",
        api: "codemode-test-classifier",
        provider: chat.provider,
        baseUrl: chat.baseUrl,
        input: ["text"],
        cost: chat.cost,
        contextWindow: 8192,
      };
      const code = `text(await tools.read({path:'permitted.txt'})); for(const task of [()=>tools.read({path:'secret.txt'}),()=>tools.mcp__fixture__denied({value:'should-not-dispatch'})]) { try { await task(); text('unexpected permission bypass'); } catch(e) { text({refused:String(e)}); } } text(await tools.bash({command:${JSON.stringify("touch '" + outside + "'")}})); text(await Promise.all([tools.mcp__fixture__echo({value:'first'}),tools.mcp__fixture__echo({value:'second'})])); const judge=await models.getModelOfType('classifier',${JSON.stringify(chat.provider)},'judge'); text(await models.classify(judge,{state:{fixture:true},questions:{verdict:{type:'choice',instructions:'Choose',criteria:{finished:'done',incomplete:'remaining'}}}}));`;
      const providerPath = path.join(root, "provider.mjs");
      const classifyMarker = path.join(root, "classifier.json");
      const eventsPath = path.join(root, "gates.json");
      await writeFile(
        providerPath,
        `import {writeFileSync} from 'node:fs'; import {createAssistantMessageEventStream} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))}; export default pi=>{let i=0;const events=[]; pi.on('tool_call',e=>{events.push({id:e.toolCallId,parent:e.parentToolCallId,name:e.toolName});writeFileSync(${JSON.stringify(eventsPath)},JSON.stringify(events));}); const chat=${JSON.stringify(chat)},judge=${JSON.stringify(classifier)};pi.registerProvider(chat.provider,{api:chat.api,apiKey:'fixture-only',baseUrl:chat.baseUrl,models:[chat,judge],classifiers:{[judge.api]:{async classify(model,context){writeFileSync(${JSON.stringify(classifyMarker)},JSON.stringify({model,context}));return {api:judge.api,provider:judge.provider,model:judge.id,answers:{verdict:{type:'choice',choice:'finished',probabilities:{finished:1,incomplete:0},confidence:1}},stopReason:'stop',timestamp:Date.now()};}}},streamSimple:()=>{const s=createAssistantMessageEventStream(),first=i++===0,reason=first?'toolUse':'stop',message={role:'assistant',content:first?[{type:'toolCall',id:'script-call',name:${JSON.stringify(exposure === "missing" ? "read" : "codemode")},arguments:${JSON.stringify(exposure === "missing" ? { path: "permitted.txt" } : { code })}}]:[{type:'text',text:'done'}],api:chat.api,provider:chat.provider,model:chat.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{...chat.cost,total:0}},stopReason:reason,timestamp:Date.now()};queueMicrotask(()=>{s.push({type:'start',partial:message});s.push({type:'done',reason,message});s.end();});return s;}});};`,
      );
      const cli =
        process.env.PI_SECURITY_CODEMODE_CLI ||
        fileURLToPath(
          new URL(
            "../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            import.meta.url,
          ),
        );
      const extension =
        process.env.PI_SECURITY_CODEMODE_EXTENSION ||
        fileURLToPath(new URL("../../src/extension.ts", import.meta.url));
      child = spawn(
        process.execPath,
        [
          cli,
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-builtin-tools",
          "--exclude-tools",
          "powershell",
          "-e",
          extension,
          "-e",
          "builtin:tool-search",
          ...(exposure === "missing" ? [] : ["-e", "builtin:codemode"]),
          "-e",
          providerPath,
          "--security-mcp",
          "--security-codemode",
          "--provider",
          chat.provider,
          "--model",
          chat.id,
          "--thinking",
          "off",
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: agent,
            PI_SECURITY_POLICY: path.join(agent, "policy.json"),
            PI_SECURITY_ACTIVATION: "active",
            PI_SECURITY_PLACEMENT: "host",
            PI_SECURITY_TRANSPORT: "internal",
            PI_SECURITY_TMP: tmp,
            TMPDIR: `${tmp}/`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let pending = "",
        stderr = "";
      const frames = [];
      child.stderr.on("data", (value) => (stderr += value));
      child.stdout.on("data", (value) => {
        pending += value;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            frames.push(JSON.parse(line));
          } catch {}
          if (frames.at(-1)?.type === "agent_end") child.stdin.end();
        }
      });
      child.stdin.write(
        JSON.stringify({ type: "prompt", message: "Run the fixture", id: "test" }) + "\n",
      );
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) =>
          status === 0 ? resolve() : reject(Error(`CLI status ${status}: ${stderr}`)),
        );
        setTimeout(
          () => reject(Error(`Timeout: ${stderr}\n${JSON.stringify(frames.slice(-4))}`)),
          20000,
        ).unref();
      });
      if (exposure === "missing") {
        const refused = frames.find(
          (frame) => frame.type === "tool_execution_end" && frame.toolName === "read",
        );
        assert.ok(refused, stderr);
        assert.equal(refused.isError, true);
        assert.match(
          JSON.stringify(refused.result),
          /security-codemode requires stock builtin:codemode/,
        );
        assert.equal(requests.length, 0);
        await assert.rejects(readFile(classifyMarker), { code: "ENOENT" });
        return;
      }
      const wrapper = frames.find(
        (frame) => frame.type === "tool_execution_end" && frame.toolName === "codemode",
      );
      assert.ok(wrapper, stderr);
      assert.equal(wrapper.isError, false, JSON.stringify(wrapper));
      const output = JSON.stringify(wrapper.result);
      assert.doesNotMatch(output, /unexpected permission bypass|secret fixture/);
      assert.match(output, /permitted read/);
      assert.match(output, /finished/);
      assert.ok(
        wrapper.result.details.calls.some(
          (call) => call.name === "bash" && call.status === "error",
        ),
      );
      assert.ok(
        wrapper.result.details.calls.some(
          (call) => call.name === "read" && call.status === "error",
        ),
      );
      assert.deepEqual(requests.map((request) => request.arguments.value).sort(), [
        "first",
        "second",
      ]);
      const gates = JSON.parse(await readFile(eventsPath, "utf8"));
      const nested = gates.filter((event) => event.parent);
      assert.ok(nested.length >= 4, JSON.stringify(gates));
      assert.ok(nested.every((event) => event.parent === "script-call"));
      const echoes = nested.filter((event) => event.name === "mcp__fixture__echo");
      assert.equal(new Set(echoes.map((event) => event.id)).size, 2);
      assert.ok(
        !gates.some((event) => event.name === "models.classify"),
        "models calls use the accepted trusted-runtime path, not effect permissions",
      );
      assert.equal(JSON.parse(await readFile(classifyMarker, "utf8")).model.id, "judge");
      await assert.rejects(readFile(outside), { code: "ENOENT" });
      assert.equal(await readFile(path.join(project, "secret.txt"), "utf8"), "secret fixture");
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("close", resolve));
      }
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
