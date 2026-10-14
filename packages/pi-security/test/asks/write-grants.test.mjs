import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  unlink,
  link,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { policy } from "../skeleton/fixture.mjs";
import { loadPolicy } from "../../src/policy.ts";
import { decide, Bindings } from "../../src/gate.ts";
import { attachWriteGrants, requestedWriteGrants } from "../../src/write-grants.ts";
import { createAskResolver } from "../../src/ask-resolver.ts";
import { compileProfile } from "../../src/profiles.ts";
import { wrapShell, shellOperations } from "../../src/wrap-shell.ts";
import { createFileClient } from "../../src/file-client.ts";
import { createFileToolDefinitions } from "../../src/file-tools.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-write-grants-")));
  const project = path.join(root, "project"),
    tmp = path.join(root, "tmp"),
    outside = path.join(root, "outside"),
    denied = path.join(outside, "denied");
  await Promise.all([project, tmp, denied].map((p) => mkdir(p, { recursive: true })));
  const p = policy();
  p.allow.push(
    { id: "shell-allowed", tool: "bash", permissions: { write: true, network: [] } },
    { id: "read-allowed", tool: "read", permissions: { write: false, network: [] } },
  );
  p.resources.denyWrite.push(denied);
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify(p));
  const loaded = await loadPolicy(policyPath, { project, tmp });
  return {
    root,
    project,
    tmp,
    outside,
    denied,
    policyPath,
    loaded,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
const allow = {
  verdict: "allow",
  reasonCode: "classifier-chat",
  labels: [],
  note: "The user requested this destination.",
};
async function approve(f, tool, input, classification = allow) {
  const checked = decide(tool, input, f.loaded);
  let view;
  const resolver = createAskResolver({
    policy: f.loaded.policy,
    authority: () => ({ userMessages: ["Write to the other project."] }),
    classify: async (v) => {
      view = v;
      return classification;
    },
  });
  try {
    return {
      checked,
      view: () => view,
      decision: attachWriteGrants(
        await resolver.resolve({ toolName: tool, input, cwd: f.project }, checked),
        checked.writeGrants ?? [],
      ),
    };
  } finally {
    resolver.close();
  }
}

test("allowlisted reads outside project need no classification; writes need per-call approval", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.outside, "result.txt");
    assert.equal(decide("read", { path: target }, f.loaded).verdict, "allow");
    const result = await approve(f, "write", { path: target, content: "ok" });
    assert.equal(result.checked.verdict, "ask");
    assert.equal(result.decision.verdict, "allow");
    assert.deepEqual(
      result.view().writeGrants.map((grant) => grant.path),
      [target],
    );
    assert.equal(result.view().writeGrants[0].kind, "file");
    assert.equal(result.decision.writeGrants[0].path, target);
    assert.ok(!f.loaded.filesystem.writeAllow.includes(f.outside));
    const b = new Bindings();
    b.put("one", "write", { path: target }, result.decision);
    assert.throws(() => b.take("two", "write", { path: target }), /differs/);
    assert.throws(() => b.take("one", "write", { path: path.join(f.outside, "other") }), /differs/);
    const refused = await approve(f, "write", { path: target }, { ...allow, verdict: "deny" });
    assert.equal(refused.decision.verdict, "deny");
    assert.equal(refused.decision.writeGrants, undefined);
  } finally {
    await f.close();
  }
});

test("explicit deny, protected names, sibling temp and readonly cap cannot receive grants", async () => {
  const f = await fixture();
  try {
    for (const target of [
      path.join(f.denied, "x"),
      path.join(f.outside, ".pi/config"),
      path.join(f.outside, "AGENTS.md"),
      path.join(f.outside, "AGENTS.MD"),
      path.join(f.outside, ".PI/config"),
    ]) {
      assert.equal(decide("write", { path: target }, f.loaded).verdict, "deny");
      assert.equal(
        decide("bash", { command: "touch x", permissions: { write: [target] } }, f.loaded).verdict,
        "deny",
      );
    }
    assert.equal(
      decide("bash", { command: "cat secret.txt", permissions: { write: [f.outside] } }, f.loaded)
        .verdict,
      "deny",
    );
    f.loaded.limits = { write: false, network: true };
    assert.equal(decide("write", { path: path.join(f.outside, "x") }, f.loaded).verdict, "deny");
    delete f.loaded.limits;
    f.loaded.tempIsolation = { base: f.root, own: f.project, launchDir: f.tmp };
    assert.equal(
      decide("bash", { command: "touch x", permissions: { write: [f.outside] } }, f.loaded).verdict,
      "deny",
    );
    assert.equal(decide("write", { path: path.join(f.tmp, "x") }, f.loaded).verdict, "deny");
  } finally {
    await f.close();
  }
});

test("approval preserves independent write and network permissions without a tier menu", async () => {
  const f = await fixture();
  try {
    f.loaded.policy.resources.network = ["example.com"];
    f.loaded.policy.allow.unshift({
      id: "fetch",
      tool: "bash",
      permissions: { write: true, network: ["example.com"] },
    });
    const input = { command: "touch x", permissions: { write: [f.outside] } };
    const result = await approve(f, "bash", input);
    assert.equal(result.decision.permissions.write, true);
    assert.deepEqual(result.decision.permissions.network, [["example.com"]]);
    assert.equal(result.view().permissions.write, true);
    f.loaded.policy.mode = "manual";
    const r = createAskResolver({ policy: f.loaded.policy, authority: () => ({}) });
    const checked = decide("bash", input, f.loaded);
    const manual = await r.resolve({ toolName: "bash", input }, checked, {
      hasUI: true,
      ui: { select: async () => "Allow" },
    });
    assert.equal(attachWriteGrants(manual, checked.writeGrants).verdict, "allow");
    r.close();
  } finally {
    await f.close();
  }
});

test("symlink destinations resolve for review and retargeting after approval fails closed", async () => {
  const f = await fixture();
  try {
    const first = path.join(f.outside, "a"),
      second = path.join(f.outside, "b"),
      link = path.join(f.project, "link");
    await Promise.all([first, second].map((p) => writeFile(p, "safe")));
    await symlink(first, link);
    const result = await approve(f, "write", { path: link });
    assert.deepEqual(
      result.view().writeGrants.map((grant) => grant.path),
      [first],
    );
    await unlink(link);
    await symlink(second, link);
    assert.throws(
      () =>
        compileProfile(
          f.loaded,
          { write: true, network: [] },
          { writeGrants: result.decision.writeGrants },
        ),
      /changed/,
    );
    await unlink(link);
    await symlink(path.join(f.denied, "secret"), link);
    assert.equal(decide("write", { path: link }, f.loaded).verdict, "deny");
  } finally {
    await f.close();
  }
});

test(
  "real file helper grants only the approved file and missing parent creation; later helper has no grant",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = await fixture();
    let client, baseline;
    try {
      const target = path.join(f.outside, "new", "nested", "result.txt");
      const input = { path: target, content: "approved" },
        result = await approve(f, "write", input);
      client = await createFileClient({
        loaded: f.loaded,
        mode: "write",
        wrapShell,
        compileProfile,
        policyPath: f.policyPath,
        writeGrants: result.decision.writeGrants,
      });
      const tools = createFileToolDefinitions({
        cwd: f.project,
        clientForPermissions: async () => client,
      });
      const output = await tools.write.execute("one", input, undefined, undefined, {
        cwd: f.project,
        securityPermissions: { write: true, network: [] },
        securityWriteGrants: result.decision.writeGrants,
      });
      assert.equal(output.isError, undefined);
      assert.equal(await readFile(target, "utf8"), "approved");
      await client.close();
      client = undefined;
      baseline = await createFileClient({
        loaded: f.loaded,
        mode: "write",
        wrapShell,
        compileProfile,
        policyPath: f.policyPath,
      });
      await assert.rejects(baseline.request("writeFile", { path: target, content: "unapproved" }), {
        code: "EPERM",
      });
      assert.equal(await readFile(target, "utf8"), "approved");
    } finally {
      await client?.close();
      await baseline?.close();
      await f.close();
    }
  },
);

test(
  "real shell grant allows requested file; sibling/protected targets stay blocked and grant does not persist",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = await fixture();
    try {
      const target = path.join(f.outside, "result.txt"),
        other = path.join(f.outside, "other.txt");
      const grants = requestedWriteGrants("bash", { permissions: { write: [target] } }, f.loaded);
      const ops = shellOperations(
        f.loaded,
        { write: true, network: [] },
        {
          writeGrants: grants,
          policyPath: f.policyPath,
        },
      );
      const run = async (operations, command) =>
        operations.exec(command, f.project, { onData() {}, timeout: 10 });
      assert.equal((await run(ops, `printf ok > '${target}'`)).exitCode, 0);
      assert.notEqual((await run(ops, `printf bad > '${other}'`)).exitCode, 0);
      const directoryOps = shellOperations(
        f.loaded,
        { write: true, network: [] },
        {
          writeGrants: requestedWriteGrants(
            "bash",
            { permissions: { write: [f.outside] } },
            f.loaded,
          ),
          policyPath: f.policyPath,
        },
      );
      assert.notEqual((await run(directoryOps, `printf bad > '${f.denied}/x'`)).exitCode, 0);
      assert.notEqual((await run(directoryOps, `mkdir '${f.outside}/.pi'`)).exitCode, 0);
      assert.notEqual((await run(directoryOps, `mkdir '${f.outside}/.PI'`)).exitCode, 0);
      assert.notEqual(
        (await run(directoryOps, `printf bad > '${f.outside}/AGENTS.MD'`)).exitCode,
        0,
      );
      assert.notEqual(
        (
          await run(
            shellOperations(f.loaded, { write: true, network: [] }, { policyPath: f.policyPath }),
            `printf bad > '${target}'`,
          )
        ).exitCode,
        0,
      );
      assert.equal(await readFile(target, "utf8"), "ok");
    } finally {
      await f.close();
    }
  },
);

test(
  "denied paths retain kernel protection through configured symlinks and hardlink aliases",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = await fixture();
    try {
      const secret = path.join(f.denied, "secret"),
        alias = path.join(f.outside, "alias"),
        deniedAlias = path.join(f.project, "blocked");
      await writeFile(secret, "safe");
      await link(secret, alias);
      await symlink(f.denied, deniedAlias);
      f.loaded.filesystem.writeDeny = [deniedAlias];
      f.loaded.filesystem.readDeny = [deniedAlias];
      const grants = requestedWriteGrants(
        "bash",
        { permissions: { write: [f.outside] } },
        f.loaded,
      );
      const ops = shellOperations(
        f.loaded,
        { write: true, network: [] },
        {
          writeGrants: grants,
          policyPath: f.policyPath,
        },
      );
      const run = (command) => ops.exec(command, f.project, { onData() {}, timeout: 10 });
      assert.notEqual((await run(`printf bad > '${secret}'`)).exitCode, 0);
      assert.notEqual((await run(`cat '${secret}'`)).exitCode, 0);
      assert.notEqual((await run(`cat '${alias}'`)).exitCode, 0);
      assert.notEqual((await run(`printf bad > '${alias}'`)).exitCode, 0);
      assert.equal(await readFile(secret, "utf8"), "safe");
    } finally {
      await f.close();
    }
  },
);

test("execution binding owns canonical cwd and immutable approved grants", async () => {
  const f = await fixture();
  try {
    const input = { command: "touch result.txt", permissions: { write: [f.outside] } };
    const approved = await approve(f, "bash", input);
    const b = new Bindings();
    b.put("one", "bash", input, approved.decision, f.project);
    assert.throws(() => b.take("one", "bash", input, f.outside), /directory differs/);
    b.put("two", "bash", input, approved.decision, f.project);
    approved.decision.writeGrants[0].path = f.denied;
    const bound = b.take("two", "bash", input, f.project);
    assert.equal(bound.cwd, f.project);
    assert.equal(bound.decision.writeGrants[0].path, f.outside);
    assert.ok(Object.isFrozen(bound.decision.writeGrants[0]));
  } finally {
    await f.close();
  }
});

test(
  "foreground call expiry stops ordinary descendants before returning its write grant",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = await fixture();
    try {
      const target = path.join(f.outside, "late.txt"),
        pidFile = path.join(f.project, "descendant.pid");
      const ops = shellOperations(
        f.loaded,
        { write: true, network: [] },
        {
          writeGrants: requestedWriteGrants("bash", { permissions: { write: [target] } }, f.loaded),
          policyPath: f.policyPath,
        },
      );
      const command = `(sleep 0.4; printf bad > '${target}') >/dev/null 2>&1 & printf '%s' "$!" > '${pidFile}'`;
      assert.equal((await ops.exec(command, f.project, { onData() {}, timeout: 10 })).exitCode, 0);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await assert.rejects(readFile(target), { code: "ENOENT" });
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await f.close();
    }
  },
);
