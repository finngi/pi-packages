import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileProfileAsync as compileProfile } from "../../src/profile-compiler.ts";
import { runKernelTrial } from "../kernel-helper.mjs";

const profile = (p) =>
  compileProfile(
    { filesystem: { writeAllow: [p.project, p.tmp], writeDeny: [], readDeny: [] } },
    { write: true, network: [] },
  );
test("confined build directories can be created, renamed and removed", async () => {
  const result = await runKernelTrial({
    profile,
    argv: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "mkdir -p crate/target/debug; printf built > crate/target/debug/output; mv crate/target/debug crate/target/cache; cat crate/target/cache/output; rm crate/target/cache/output; rmdir crate/target/cache",
    ],
  });
  assert.equal(result.setupFailure, null);
  assert.equal(result.process.exitCode, 0, result.process.stderr);
  assert.equal(result.process.stdout, "built");
});

test("ancestor moves cannot relocate protected names or explicit protected paths", async () => {
  const result = await runKernelTrial({
    setup: async (p) => {
      for (const [directory, name] of [
        ["instructions/deep", "AGENTS.md"],
        ["repo/.git", "config"],
        ["settings", "runtime"],
        ["private", "credential"],
      ]) {
        await mkdir(path.join(p.project, directory), { recursive: true });
        await writeFile(path.join(p.project, directory, name), "unchanged");
      }
      await mkdir(path.join(p.project, "trusted/launch"), { recursive: true });
      await writeFile(path.join(p.project, "trusted/launch", "metadata"), "unchanged");
      await mkdir(path.join(p.project, "future-deny"));
    },
    profile: (p) =>
      compileProfile(
        {
          filesystem: {
            writeAllow: [p.project, p.tmp],
            writeDeny: [
              path.join(p.project, "settings/runtime"),
              path.join(p.project, "repo/.git/config"),
              path.join(p.project, "fresh/.git/config"),
              path.join(p.project, "future-deny/credential"),
            ],
            readDeny: [path.join(p.project, "private/credential")],
          },
          tempIsolation: {
            base: p.tmp,
            own: p.tmp,
            launchDir: path.join(p.project, "trusted/launch"),
          },
        },
        { write: true, network: [] },
      ),
    argv: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "mv instructions moved-instructions; rm -rf instructions; mv repo moved-repo; rm -rf repo; mv settings moved-settings; mv private moved-private; mv trusted moved-trusted; mv future-deny moved-future-deny; rmdir future-deny; mkdir future; printf injected > future/AGENTS.md; mkdir -p fresh/.git; printf injected > fresh/.git/config; mv fresh prospective",
    ],
  });
  assert.equal(result.setupFailure, null);
  assert.match(result.process.stderr, /not permitted|denied/i);
  assert.deepEqual(result.effects.changed, []);
  assert.deepEqual(result.effects.removed, []);
  assert.equal(result.effects.created.length, 0);
});

const rustBin =
  process.env.PI_SECURITY_TEST_RUST_BIN ||
  path.join(process.env.HOME, ".rustup/toolchains/stable-aarch64-apple-darwin/bin");
const quotedRustBin = `'${rustBin.replaceAll("'", "'\\''")}'`;
test(
  "direct rustc and offline Cargo test build under the real confined profile",
  { skip: !existsSync(path.join(rustBin, "cargo")) || !existsSync(path.join(rustBin, "rustc")) },
  async () => {
    const result = await runKernelTrial({
      setup: async (p) => {
        await mkdir(path.join(p.project, "crate/src"), { recursive: true });
        await writeFile(
          path.join(p.project, "crate/Cargo.toml"),
          '[package]\nname="confined-directory-fixture"\nversion="0.1.0"\nedition="2021"\n',
        );
        await writeFile(
          path.join(p.project, "crate/src/lib.rs"),
          "#[test] fn fixture() { assert_eq!(2+2,4); }\n",
        );
        await writeFile(
          path.join(p.project, "probe.rs"),
          'fn main() { println!("CONFINED_READY"); }\n',
        );
      },
      profile,
      argv: [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        `export PATH=${quotedRustBin}:/usr/bin:/bin:/usr/sbin:/sbin; export CARGO_HOME="$TMPDIR/cargo"; rustc probe.rs -o probe && ./probe && cd crate && cargo test --offline`,
      ],
      timeoutMs: 30000,
    });
    assert.equal(result.setupFailure, null);
    assert.equal(result.process.exitCode, 0, result.process.stderr);
    assert.match(result.process.stdout, /CONFINED_READY/);
    assert.match(result.process.stdout, /1 passed; 0 failed/);
    assert.ok(
      result.effects.created.some((entry) => entry.path.startsWith("project/crate/target/")),
    );
  },
);

test("project Git initialization and configuration use ordinary write permissions", async () => {
  const result = await runKernelTrial({
    profile,
    argv: [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "mkdir repository; git -C repository init; git -C repository config user.name Fixture; git -C repository config user.name",
    ],
  });
  assert.equal(result.setupFailure, null);
  assert.equal(result.process.exitCode, 0, result.process.stderr);
  assert.match(result.process.stdout, /Fixture/);
  assert.ok(
    result.effects.created.some((entry) => entry.path === "project/repository/.git/config"),
  );
});
