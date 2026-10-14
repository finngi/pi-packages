import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { linuxSandboxArgv } from "../src/linux-executor.ts";
import { shellOperations, wrapShell } from "../src/wrap-shell.ts";
import { createFileClient } from "../src/file-client.ts";
import { compileProfile } from "../src/profiles.ts";
import { createBackgroundJobs } from "../src/background-jobs.ts";
import { createTempScope } from "../src/temp-scope.ts";
import { createChildLauncher, loadChildLaunch } from "../src/child-launch.ts";
import { loadPolicy } from "../src/policy.ts";
import { policy } from "./skeleton/fixture.mjs";
import { fileURLToPath } from "node:url";

test(
  "Bubblewrap creates missing mount targets in the host-backed writable project",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-linux-mount-target-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project"),
      target = path.join(project, "future-denial");
    await mkdir(project);
    const result = spawnSync(
      "/usr/bin/bwrap",
      [
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        project,
        project,
        "--tmpfs",
        target,
        "--",
        "/bin/true",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(target)).isDirectory(), true);
  },
);

test(
  "Linux read-only kernel boundary hides credentials/proc and refuses writes/network",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-linux-kernel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project"),
      own = path.join(root, "tmp"),
      launchDir = path.join(root, "launch"),
      secret = path.join(root, "auth.json"),
      outside = path.join(root, "outside");
    for (const dir of [project, own, launchDir, outside]) await mkdir(dir, { mode: 0o700 });
    await writeFile(secret, "credential-canary-never-print");
    await writeFile(path.join(project, "input.txt"), "input");
    await writeFile(path.join(project, "AGENTS.md"), "trusted");
    const loaded = {
      project,
      tmp: own,
      limits: { write: false, network: false },
      filesystem: { writeAllow: [project, own], writeDeny: [launchDir], readDeny: [secret] },
      tempIsolation: { base: root, own, launchDir },
      policy: { resources: { network: [] }, env: { path: ["/usr/local/bin", "/usr/bin", "/bin"] } },
    };
    const run = (command, className = "read-only") => {
      const prepared = wrapShell(command, className, loaded);
      return spawnSync(prepared.sandboxArgv[0], prepared.sandboxArgv.slice(1), {
        cwd: project,
        env: prepared.env,
        encoding: "utf8",
      });
    };
    const good = run("cat input.txt");
    assert.equal(good.status, 0, good.stderr);
    for (const command of [
      `cat '${secret}'`,
      `printf denied > '${outside}/bad'`,
      "printf denied > result.txt",
      "printf denied > AGENTS.md",
      `cat /proc/1/root${secret}`,
    ]) {
      const result = run(command);
      assert.notEqual(result.status, 0);
      assert.ok(!result.stdout.includes("credential-canary"));
    }
    assert.notEqual(
      run('node -e \'require("net").connect(443,"1.1.1.1").on("error",()=>process.exit(1))\'')
        .status,
      0,
    );
    assert.throws(
      () => linuxSandboxArgv(["/bin/true"], { write: true, network: [] }, loaded),
      /writable shell execution is disabled/,
    );
    const futureDeny = path.join(project, "future-denial");
    assert.throws(
      () =>
        linuxSandboxArgv(
          ["/bin/true"],
          { write: true, network: [] },
          {
            ...loaded,
            filesystem: { ...loaded.filesystem, writeDeny: [futureDeny] },
          },
        ),
      /writable shell execution is disabled/,
    );
    await assert.rejects(readFile(futureDeny), { code: "ENOENT" });
    assert.throws(
      () => linuxSandboxArgv(["/bin/true"], { write: true, network: [["example.com"]] }, loaded),
      /fetch execution is disabled/,
    );
    const client = await createFileClient({
      loaded,
      mode: "read-only",
      wrapShell,
      compileProfile,
      policyPath: path.join(launchDir, "policy.json"),
      extensionPath: new URL("../src/extension.ts", import.meta.url).pathname,
    });
    t.after(() => client.close());
    assert.equal(
      Buffer.from(
        await client.request("readFile", { path: path.join(project, "input.txt") }),
        "base64",
      ).toString(),
      "input",
    );
    await assert.rejects(client.request("readFile", { path: secret }));
    await assert.rejects(
      client.request("writeFile", { path: path.join(project, "helper-output"), content: "denied" }),
    );
    await assert.rejects(readFile(path.join(project, "helper-output")));
  },
);
test(
  "Linux read-only child scope and stock RPC lifecycle use the kernel executor",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-linux-child-"));
    let scope, launcher;
    t.after(async () => {
      await launcher?.close();
      await scope?.close();
      await rm(root, { recursive: true, force: true });
    });
    scope = await createTempScope({ base: path.join(root, "base") });
    const file = path.join(root, "policy.json");
    await writeFile(file, JSON.stringify(policy()));
    const parent = await loadPolicy(file, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    parent.limits = { write: false, network: false };
    launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
      piCliPath: fileURLToPath(
        new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
      ),
      parentResources: {
        tools: ["read", "write", "bash"],
        skills: [],
        models: [],
        thinking: "off",
      },
    });
    const launch = await launcher.prepareChildLaunch({
      task: "local executor conformance, no model request",
      tools: ["read", "write", "bash"],
      skills: [],
      limits: { write: false, network: false },
    });
    const child = await loadChildLaunch({ env: launch.env, loadPolicy });
    assert.deepEqual(child.resources.tools, ["read", "write", "bash"]);
    const sample = path.join(launch.cwd, "sample.txt");
    await writeFile(sample, "child can read this");
    const prepared = wrapShell(`cat '${sample}'`, { write: false, network: [] }, child);
    assert.equal(
      spawnSync(prepared.sandboxArgv[0], prepared.sandboxArgv.slice(1), {
        cwd: launch.cwd,
        env: prepared.env,
        encoding: "utf8",
      }).status,
      0,
    );
    const forbidden = wrapShell(
      `printf denied > '${parent.project}/parent-output'`,
      { write: false, network: [] },
      child,
    );
    assert.notEqual(
      spawnSync(forbidden.sandboxArgv[0], forbidden.sandboxArgv.slice(1), {
        cwd: launch.cwd,
        env: forbidden.env,
        encoding: "utf8",
      }).status,
      0,
    );
    const deniedChildWrite = wrapShell(
      `printf denied > '${launch.tmp}/child-output'`,
      { write: false, network: [] },
      child,
    );
    assert.notEqual(
      spawnSync(deniedChildWrite.sandboxArgv[0], deniedChildWrite.sandboxArgv.slice(1), {
        cwd: launch.cwd,
        env: deniedChildWrite.env,
        encoding: "utf8",
      }).status,
      0,
    );
    const secret = path.join(scope.launchDir, "credentials-canary");
    await writeFile(secret, "child-credential-canary");
    const denied = wrapShell(`cat '${secret}'`, { write: false, network: [] }, child);
    const deniedResult = spawnSync(denied.sandboxArgv[0], denied.sandboxArgv.slice(1), {
      cwd: launch.cwd,
      env: denied.env,
      encoding: "utf8",
    });
    assert.ok(!deniedResult.stdout.includes("child-credential-canary"));
    const rpc = spawn(launch.argv[0], [...launch.argv.slice(1), "--offline"], {
      cwd: launch.cwd,
      env: { ...launch.env, PI_SECURITY_TRANSPORT: "extensions" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => rpc.kill("SIGKILL"));
    const state = await new Promise((resolve, reject) => {
      let output = "",
        error = "";
      const timer = setTimeout(
        () => reject(Error("stock child RPC startup timeout: " + error)),
        10000,
      );
      rpc.stderr.on("data", (data) => {
        error = (error + data).slice(-3000);
      });
      rpc.stdout.on("data", (data) => {
        output += data;
        let end;
        while ((end = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.id === "child-state") {
              clearTimeout(timer);
              resolve(value);
            }
          } catch {}
        }
      });
      rpc.once("error", reject);
      rpc.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("stock RPC exited " + code + ": " + error));
      });
      rpc.stdin.write(JSON.stringify({ id: "child-state", type: "get_state" }) + "\n");
    });
    assert.equal(state.success, true);
    rpc.stdin.end();
    rpc.kill("SIGTERM");
    await new Promise((resolve) => rpc.once("close", resolve));
    const jobs = createBackgroundJobs({
      prepare: async ({ command }) => ({
        ...wrapShell(command, { write: false, network: [] }, parent),
        profileRoot: scope.launchDir,
      }),
    });
    const job = await jobs.start({
      command: "sleep 60",
      cwd: parent.project,
      decision: { verdict: "allow", permissions: { write: false, network: [] } },
    });
    await jobs.cancel(job.id);
    assert.equal(jobs.status(job.id).state, "done");
    await jobs.close();
    await launch.cleanup();
    assert.equal(launch.isCurrent(), false);
    await assert.rejects(readFile(path.join(launch.tmp, "child-output")));
  },
);
