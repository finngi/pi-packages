import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import childProcess from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileClient } from "../src/file-client.ts";

test("session close waits for and cancels a helper restart still preparing to spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-helper-close-"));
  const originalMkdtemp = fs.promises.mkdtemp;
  const originalSpawn = childProcess.spawn;
  const children = [];
  let releaseRestart;
  let restartEntered;
  const restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  const enteredRestart = new Promise((resolve) => {
    restartEntered = resolve;
  });
  let mkdtempCalls = 0;
  fs.promises.mkdtemp = async (...args) => {
    if (++mkdtempCalls === 2) {
      restartEntered();
      await restartGate;
    }
    return originalMkdtemp(...args);
  };
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.kill = () => {
      setImmediate(() => child.finish(null, "SIGTERM"));
      return true;
    };
    child.finish = (code = 0, signal = null) => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code, signal);
    };
    children.push(child);
    setImmediate(() => child.stdout.write('{"ready":true}\n'));
    return child;
  };
  syncBuiltinESMExports();

  let client;
  let request;
  try {
    client = await createFileClient({
      loaded: {
        project: root,
        tmp: root,
        policy: { env: { path: [] } },
        tempIsolation: { launchDir: root },
      },
      mode: "read-only",
      wrapShell: () => ({
        argv: ["/bin/true"],
        env: { TMPDIR: root },
        profile: "(deny default)",
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
      }),
      compileProfile: () => "(version 1)\n(deny default)\n(allow process-exec)",
      policyPath: path.join(root, "policy.json"),
      extensionPath: path.join(root, "extension.js"),
      executables: {
        node: process.execPath,
        rg: "/usr/bin/true",
        fd: "/usr/bin/true",
      },
    });

    children[0].finish(1, "SIGKILL");
    request = client.request("exists", { path: path.join(root, "target") });
    request.catch(() => {});
    await enteredRestart;

    let closeSettled = false;
    const closing = client.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false, "close must own the in-flight restart");

    releaseRestart();
    await closing;
    await assert.rejects(request, /helper closed/);
    assert.equal(children.length, 1, "close must prevent the restarted helper from spawning");
  } finally {
    releaseRestart();
    await request?.catch(() => {});
    await client?.close();
    for (const child of children) child.finish(null, "SIGTERM");
    fs.promises.mkdtemp = originalMkdtemp;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("session close ends helper input and waits for graceful cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-helper-drain-"));
  const originalSpawn = childProcess.spawn;
  let child;
  let stdinEnded = false;
  let cancelWrites = 0;
  let killCalls = 0;
  let requestWritten;
  const wroteRequest = new Promise((resolve) => {
    requestWritten = resolve;
  });
  childProcess.spawn = () => {
    child = new EventEmitter();
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        if (JSON.parse(chunk.toString()).cancel) cancelWrites++;
        requestWritten();
        callback();
      },
      final(callback) {
        stdinEnded = true;
        setTimeout(() => {
          child.exitCode = 0;
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
          callback();
        }, 10);
      },
    });
    child.kill = () => {
      killCalls++;
      return true;
    };
    setImmediate(() => child.stdout.write('{"ready":true}\n'));
    return child;
  };
  syncBuiltinESMExports();

  let client;
  try {
    client = await createFileClient({
      loaded: {
        project: root,
        tmp: root,
        policy: { env: { path: [] } },
        tempIsolation: { launchDir: root },
      },
      mode: "read-only",
      wrapShell: () => ({
        argv: ["/bin/true"],
        env: { TMPDIR: root },
        profile: "(deny default)",
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
      }),
      compileProfile: () => "(version 1)\n(deny default)\n(allow process-exec)",
      policyPath: path.join(root, "policy.json"),
      extensionPath: path.join(root, "extension.js"),
      executables: { node: process.execPath, rg: "/usr/bin/true", fd: "/usr/bin/true" },
    });
    const controller = new AbortController();
    const request = client.request(
      "exists",
      { path: path.join(root, "target") },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(request, /Operation aborted/);
    await wroteRequest;
    const closing = client.close();
    controller.abort();
    await Promise.all([closing, rejected]);
    assert.equal(stdinEnded, true, "EOF tells the helper to abort active commands");
    assert.equal(cancelWrites, 0, "a pending cancellation is not written after helper EOF");
    assert.equal(killCalls, 0, "the helper exits after cancellation without immediate termination");
  } finally {
    await client?.close();
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "unexpected helper exit kills search process groups it reported",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-helper-crash-"));
    const originalSpawn = childProcess.spawn;
    const pidFile = path.join(root, "search-group.pid");
    const command = `trap '' TERM; exec 1>&- 2>&-; echo $$ > '${pidFile}'; exec /bin/sleep 30`;
    const fixture = [
      `const { spawn } = require("node:child_process");`,
      `const { existsSync } = require("node:fs");`,
      `const search = spawn("/bin/sh", ["-c", ${JSON.stringify(command)}], { detached: true, stdio: "ignore" });`,
      `process.stdout.write('{"ready":true}\\n');`,
      `let input = "";`,
      `process.stdin.on("data", chunk => { input += chunk; const end = input.indexOf("\\n"); if (end < 0) return; const request = JSON.parse(input.slice(0, end)); const timer = setInterval(() => { if (!existsSync(${JSON.stringify(pidFile)})) return; clearInterval(timer); process.stdout.write(JSON.stringify({ id: request.id, processGroup: { pid: search.pid, state: "started" } }) + "\\n", () => process.exit(17)); }, 10); });`,
    ].join("\n");
    childProcess.spawn = (_executable, _args, options) =>
      originalSpawn(process.execPath, ["-e", fixture], options);
    syncBuiltinESMExports();

    let client;
    try {
      client = await createFileClient({
        loaded: {
          project: root,
          tmp: root,
          policy: { env: { path: [] } },
          tempIsolation: { launchDir: root },
        },
        mode: "read-only",
        wrapShell: () => ({
          argv: ["/bin/true"],
          env: { TMPDIR: root },
          profile: "(deny default)",
          sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        }),
        compileProfile: () => "(version 1)\n(deny default)\n(allow process-exec)",
        policyPath: path.join(root, "policy.json"),
        extensionPath: path.join(root, "extension.js"),
        executables: { node: process.execPath, rg: "/usr/bin/true", fd: "/usr/bin/true" },
      });
      const request = client.request("exists", { path: path.join(root, "missing") });
      await assert.rejects(request, /helper exited 17/);
      const deadline = Date.now() + 3000;
      let pid;
      while (!pid && Date.now() < deadline) {
        pid = Number((await readFile(pidFile, "utf8").catch(() => "")) || 0) || undefined;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid, "fixture search process group started");
      await client.close();
      const stoppedBy = Date.now() + 2000;
      while (Date.now() < stoppedBy) {
        try {
          process.kill(-pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          return;
        }
      }
      assert.fail(`search process group ${pid} survived unexpected helper exit`);
    } finally {
      await client?.close();
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);
