import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { policy } from "../skeleton/fixture.mjs";
import { createTempScope } from "../../src/temp-scope.ts";
import { loadPolicy } from "../../src/policy.ts";
import { createChildLauncher } from "../../src/child-launch.ts";
import { resolveChildAuth } from "../../src/child-auth.ts";
import { decide } from "../../src/gate.ts";
import { wrapShell } from "../../src/wrap-shell.ts";
const source = fileURLToPath(new URL("../..", import.meta.url));
test("selected runtime credentials reach real child HTTP adapter but remain denied to effect tools", async () => {
  const fixture = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-child-auth-"));
  let scope, launcher, child;
  const token = "synthetic-secret-token",
    header = "synthetic-private-header";
  let observed;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      observed = { headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "scripted",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "fixture answer" },
                finish_reason: null,
              },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "scripted",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const home = path.join(fixture, "home");
    await mkdir(home);
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const policyPath = path.join(fixture, "policy.json");
    await writeFile(policyPath, JSON.stringify(policy()));
    const parent = await loadPolicy(policyPath, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const model = {
      id: "scripted",
      name: "Fixture model",
      api: "openai-completions",
      provider: "synthetic-parent",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: token,
      headers: { "x-private-fixture": header },
      models: [model],
    });
    const registry = new ModelRegistry(runtime);
    launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: path.join(source, "src/extension.ts"),
      piCliPath: path.join(
        source,
        "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      parentResources: {
        tools: ["read", "grep", "bash"],
        skills: [],
        models: [model],
        model: { provider: model.provider, id: model.id },
        thinking: "off",
      },
      resolveAuth: (selected) => resolveChildAuth(registry, selected),
    });
    const launch = await launcher.prepareChildLaunch({ task: "fixture", tools: [], skills: [] });
    const authPayload = JSON.parse(launch.env.PI_SECURITY_CHILD_AUTH);
    assert.ok(launch.childLoaded.filesystem.readDeny.includes(authPayload.path));
    const manifest = await readFile(JSON.parse(launch.env.PI_POLICY_LAUNCH).path, "utf8");
    assert.ok(!manifest.includes(token) && !manifest.includes(header));
    assert.ok(!JSON.stringify(launch.argv).includes(token));
    assert.equal(decide("read", { path: authPayload.path }, launch.childLoaded).verdict, "deny");
    assert.equal(decide("read", { path: authPayload.path }, parent).verdict, "deny");
    const parentWrapped = wrapShell(
      "cat " + JSON.stringify(authPayload.path),
      { write: true, network: [] },
      parent,
      { policyPath, extensionPath: path.join(source, "src/extension.ts") },
    );
    const parentProfile = path.join(fixture, "parent-auth.sb");
    await writeFile(parentProfile, parentWrapped.profile);
    const parentDenied = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", parentProfile, ...parentWrapped.argv],
      { cwd: scope.tmp, env: parentWrapped.env, encoding: "utf8" },
    );
    assert.notEqual(parentDenied.status, 0);
    assert.ok(!parentDenied.stdout.includes(token));
    const wrapped = wrapShell(
      "cat " + JSON.stringify(authPayload.path),
      { write: true, network: [] },
      launch.childLoaded,
      { policyPath, extensionPath: path.join(source, "src/extension.ts") },
    );
    const profile = path.join(fixture, "auth.sb");
    await writeFile(profile, wrapped.profile);
    const denied = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, ...wrapped.argv], {
      cwd: launch.tmp,
      env: wrapped.env,
      encoding: "utf8",
    });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Operation not permitted|Permission denied/);
    assert.ok(!denied.stdout.includes(token));
    let stderr = "",
      buffer = "";
    child = spawn(launch.argv[0], [...launch.argv.slice(1), "--no-session"], {
      cwd: launch.cwd,
      env: { ...launch.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const processChild = child,
      closed = new Promise((resolve) => child.once("close", resolve));
    child.stderr.on("data", (b) => (stderr += b));
    let timer;
    const frames = [];
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error("auth fixture timeout " + stderr)), 15000);
        child.once("error", reject);
        child.once("close", (code) => reject(Error("auth fixture exit " + code + " " + stderr)));
        child.stdout.on("data", (b) => {
          buffer += b;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            frames.push(frame);
            if (frame.type === "agent_end") resolve();
          }
        });
        child.stdin.write(
          JSON.stringify({ type: "prompt", message: "Fixture only", id: "auth-fixture" }) + "\n",
        );
      });
    } finally {
      clearTimeout(timer);
      processChild.kill();
      await closed;
      child = undefined;
    }
    assert.equal(observed?.headers.authorization, "Bearer " + token, JSON.stringify(frames));
    assert.equal(observed.headers["x-private-fixture"], header);
    assert.equal(observed.body.model, model.id);
    assert.match(JSON.stringify(frames), /fixture answer/);
    assert.ok(!JSON.stringify(frames).includes(token) && !JSON.stringify(frames).includes(header));
    const unsupported = {
      find: () => model,
      getRegisteredProviderConfig: () => ({ streamSimple: () => {} }),
    };
    await assert.rejects(
      resolveChildAuth(unsupported, { provider: model.provider, id: model.id }),
      /trusted provider adapter/,
    );
    await launcher.close();
  } finally {
    child?.kill();
    await launcher?.close();
    await scope?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
