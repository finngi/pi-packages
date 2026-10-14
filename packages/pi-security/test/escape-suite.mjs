// Question: do the twelve named escape routes alter disposable protected state?
// Fields: successful startup control, gate verdict, exit/stderr, and protected canaries.
// Done: run each case once through the real deny-default kernel executor, observe state.
// Excludes live apps, actual clipboard contents, internet and deliberate daemon escapes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  access,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { loadPolicy } from "../src/policy.ts";
import { wrapShell } from "../src/wrap-shell.ts";
import { decide } from "../src/gate.ts";
import { policy } from "./skeleton/fixture.mjs";
const outer = await mkdtemp(path.join(await realpath("/private/tmp"), "pi-i-escapes-"));
const saved = { ...process.env };
const results = [];
try {
  for (const name of [
    "open",
    "BASH_ENV",
    "brace-expansion",
    "rename-git",
    "symlink-outside",
    "hard-link-outside",
    "unix-socket",
    "signal",
    "defaults-write",
    "pbcopy",
    "nested-sandbox-exec",
    "literal-tmp",
  ]) {
    if (
      process.argv.includes("--only") &&
      !process.argv.slice(process.argv.indexOf("--only") + 1).includes(name)
    )
      continue;
    const root = path.join(outer, name),
      home = path.join(root, "home"),
      project = path.join(root, "project"),
      tmp = path.join(root, "tmp"),
      outside = path.join(root, "outside"),
      launch = path.join(root, "launch"),
      agent = path.join(root, "agent");
    await Promise.all(
      [home, project, tmp, outside, launch, agent].map((p) =>
        mkdir(p, { recursive: true, mode: 0o700 }),
      ),
    );
    Object.assign(process.env, {
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      TMPDIR: tmp + "/",
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      npm_config_cache: path.join(tmp, "npm"),
    });
    const pp = path.join(agent, "policy.json");
    await writeFile(pp, JSON.stringify(policy()));
    const loaded = await loadPolicy(pp, { project, tmp });
    loaded.tempIsolation = { base: tmp, own: tmp, launchDir: launch };
    const marker = path.join(outside, "protected");
    await writeFile(marker, "unchanged");
    let command,
      fixture,
      server,
      socketRequests = 0,
      literal;
    if (name === "open") {
      fixture = path.join(outside, "Fixture.app");
      await mkdir(path.join(fixture, "Contents/MacOS"), { recursive: true });
      await writeFile(
        path.join(fixture, "Contents/Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>local.pi-security.fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
      );
      await copyFile("/usr/bin/true", path.join(fixture, "Contents/MacOS/fixture"));
      command = "open -a " + JSON.stringify(fixture);
    } else if (name === "BASH_ENV") {
      fixture = path.join(outside, "rc");
      await writeFile(fixture, "printf bad > " + JSON.stringify(marker));
      process.env.BASH_ENV = fixture;
      command = "printf safe";
    } else if (name === "brace-expansion")
      command = "touch " + JSON.stringify(outside) + "/{protected,other}";
    else if (name === "rename-git") {
      await mkdir(path.join(project, ".git/hooks"), { recursive: true });
      await writeFile(path.join(project, ".git/config"), "unchanged");
      command = "mv .git renamed";
    } else if (name === "symlink-outside") {
      await symlink(outside, path.join(project, "link"));
      command = "printf bad > link/protected";
    } else if (name === "hard-link-outside")
      command = "ln " + JSON.stringify(marker) + " linked && printf bad > linked";
    else if (name === "unix-socket") {
      const socket = path.join(outside, "socket");
      server = net.createServer((c) => {
        socketRequests++;
        c.end();
      });
      await new Promise((r) => server.listen(socket, r));
      command =
        JSON.stringify(process.execPath) +
        " -e " +
        JSON.stringify(
          'require("node:net").connect(' +
            JSON.stringify(socket) +
            ').on("error",e=>{console.error(e.message);process.exitCode=1})',
        );
    } else if (name === "signal") {
      fixture = spawn("/bin/sleep", ["30"], {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        stdio: "ignore",
      });
      command = "kill -TERM " + fixture.pid;
    } else if (name === "defaults-write") {
      await mkdir(path.join(home, "Library/Preferences"), { recursive: true });
      command =
        "defaults write " +
        JSON.stringify(path.join(home, "Library/Preferences/local.pi-security.fixture")) +
        " probe -string changed";
    } else if (name === "pbcopy") command = "pbcopy";
    else if (name === "nested-sandbox-exec")
      command =
        "sandbox-exec -p " +
        JSON.stringify("(version 1)(allow default)") +
        " /bin/sh -c " +
        JSON.stringify("printf bad > " + JSON.stringify(marker));
    else {
      literal = "/tmp/pi-security-literal-" + path.basename(outer);
      command = "printf bad > " + JSON.stringify(literal);
    }
    const wrap = wrapShell(command, { write: true, network: [] }, loaded, {
      policyPath: pp,
      extensionPath: path.resolve("src/extension.ts"),
    });
    const profile = path.join(launch, "trial.sb");
    await writeFile(profile, wrap.profile);
    const control = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", profile, "/bin/bash", "--noprofile", "--norc", "-c", "printf startup > control"],
      { cwd: project, env: wrap.env, encoding: "utf8" },
    );
    assert.equal(control.status, 0, control.stderr);
    assert.equal(await readFile(path.join(project, "control"), "utf8"), "startup");
    let mach;
    if (["open", "pbcopy"].includes(name)) {
      const code = path.join(root, "mach.c"),
        binary = path.join(root, "mach");
      await copyFile(
        new URL("../docs/inputs/experiments/critic-exp2/e2/mach.c", import.meta.url),
        code,
      );
      const build = spawnSync("/usr/bin/clang", [code, "-o", binary], {
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "clang") },
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const service =
        name === "pbcopy" ? "com.apple.pasteboard.1" : "com.apple.coreservices.launchservicesd";
      const naked = spawnSync(binary, [service], { encoding: "utf8", env: wrap.env });
      const confined = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, binary, service], {
        cwd: project,
        env: wrap.env,
        encoding: "utf8",
      });
      assert.match(naked.stdout, /REACHABLE/);
      assert.match(confined.stdout, /refused/);
      mach = { service, control: naked.stdout.trim(), confined: confined.stdout.trim() };
    }
    const clipboardCount = () =>
      spawnSync(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          "ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.changeCount",
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    const beforeClipboard = name === "pbcopy" ? clipboardCount() : undefined;
    let trial;
    if (name === "pbcopy") {
      // Keep stdin open and empty: refusal must happen before EOF can commit clipboard data.
      trial = await new Promise((resolve, reject) => {
        let out = "",
          err = "";
        const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, ...wrap.argv], {
          cwd: project,
          env: wrap.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (err += b));
        const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ status: code, signal, stdout: out, stderr: err });
        });
      });
    } else
      trial = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, ...wrap.argv], {
        cwd: project,
        env: wrap.env,
        encoding: "utf8",
        timeout: 5000,
      });
    let state = (await readFile(marker, "utf8")) === "unchanged";
    if (name === "rename-git") {
      state &&= (await readFile(path.join(project, ".git/config"), "utf8")) === "unchanged";
      await assert.rejects(access(path.join(project, "renamed")));
    }
    if (name === "signal") {
      try {
        process.kill(fixture.pid, 0);
      } catch {
        state = false;
      }
      fixture.kill();
      await new Promise((r) => fixture.once("close", r));
    }
    if (name === "unix-socket") {
      state &&= socketRequests === 0;
      await new Promise((r) => server.close(r));
    }
    if (name === "defaults-write")
      try {
        await access(path.join(home, "Library/Preferences/local.pi-security.fixture.plist"));
        state = false;
      } catch {}
    if (literal) {
      try {
        await access(literal);
        state = false;
      } catch {}
      await rm(literal, { force: true });
    }
    const afterClipboard = name === "pbcopy" ? clipboardCount() : undefined;
    if (name === "pbcopy") state &&= !!beforeClipboard && beforeClipboard === afterClipboard;
    assert.equal(
      state,
      true,
      name + " protected state changed or clipboard denial unproven: " + trial.stderr,
    );
    results.push({
      name,
      controlExit: control.status,
      gate: decide("bash", { command }, loaded).verdict,
      kernelExit: trial.status,
      signal: trial.signal ?? null,
      stderr: trial.stderr.trim(),
      protectedUnchanged: state,
      ...(mach ? { mach } : {}),
      ...(name === "pbcopy"
        ? {
            clipboardChangeCountBefore: beforeClipboard,
            clipboardChangeCountAfter: afterClipboard,
            stdin: "held open empty; never EOF or data",
          }
        : {}),
    });
    delete process.env.BASH_ENV;
  }
  console.log(JSON.stringify({ count: results.length, results }));
} finally {
  process.env = saved;
  await rm(outer, { recursive: true, force: true });
}
