import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileProfile } from "../src/profiles.ts";
import { compileProfileAsync } from "../src/profile-compiler.ts";
import { wrapShellAsync } from "../src/wrap-shell.ts";

async function fixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-profile-worker-")));
  try {
    const project = path.join(root, "project");
    await mkdir(path.join(project, "nested/repo/.git"), { recursive: true });
    await writeFile(path.join(project, "nested/repo/.git/config"), "protected");
    await writeFile(path.join(project, "nested/AGENTS.md"), "instructions");
    await writeFile(path.join(project, "secret"), "protected");
    const grant = path.join(root, "grant");
    await mkdir(grant);
    await writeFile(path.join(grant, "file"), "shared");
    await link(path.join(grant, "file"), path.join(root, "alias"));
    const loaded = {
      project,
      tmp: root,
      filesystem: {
        writeAllow: [project],
        writeDeny: [],
        readDeny: [path.join(project, "secret")],
      },
      capabilities: ["gpu"],
      policy: { resources: { network: ["example.com"] } },
    };
    await run(loaded, grant);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("worker preserves the compiler output while UI timers keep advancing", async () => {
  await fixture(async (loaded) => {
    const permissions = { write: true, network: [["example.com"]] };
    const options = {
      fetchLease: { port: 43210, release() {} },
      policyPath: path.join(loaded.project, "policy.json"),
    };
    const expected = compileProfile(loaded, permissions, options);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      assert.equal(await compileProfileAsync(loaded, permissions, options), expected);
      assert.ok(ticks > 0, "profile preparation must yield to the UI event loop");
    } finally {
      clearInterval(timer);
    }
    const read = { write: false, network: [] };
    assert.equal(await compileProfileAsync(loaded, read), compileProfile(loaded, read));
  });
});

test("worker retains hardlink protection for classifier-granted directories", async () => {
  await fixture(async (loaded, grant) => {
    const permissions = { write: true, network: [] };
    const options = {
      writeGrants: [{ kind: "directory", path: grant, source: grant, createParents: [] }],
    };
    const result = await compileProfileAsync(loaded, permissions, options);
    assert.equal(result, compileProfile(loaded, permissions, options));
    assert.ok(
      result.includes(`(deny file-read* file-write* (literal "${path.join(grant, "file")}"))`),
    );
  });
});

test("invalid scopes fail closed and cancellation stops pending compilation", async () => {
  await fixture(async (loaded) => {
    const permissions = { write: true, network: [] };
    await assert.rejects(
      compileProfileAsync(
        {
          ...loaded,
          filesystem: { ...loaded.filesystem, writeAllow: [path.join(loaded.project, "secret")] },
        },
        permissions,
      ),
      /directory changed/,
    );
    const aborted = AbortSignal.abort();
    await assert.rejects(compileProfileAsync(loaded, permissions, {}, aborted), /aborted/i);
    const controller = new AbortController();
    const pending = compileProfileAsync(loaded, permissions, {}, controller.signal);
    setImmediate(() => controller.abort());
    await assert.rejects(pending, /aborted/i);
  });
});

test("shell preparation rechecks session ownership after the asynchronous boundary", async () => {
  await fixture(async (loaded) => {
    let current = true;
    const pending = wrapShellAsync("echo ready", { write: true, network: [] }, loaded, {
      assertCurrent() {
        if (!current) throw Error("session ended");
      },
    });
    setImmediate(() => {
      current = false;
    });
    await assert.rejects(pending, /session ended/);
  });
});
