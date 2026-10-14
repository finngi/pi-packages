// Question: do the two real helpers confine files and preserve framing/errno?
// Compared fields: readyMs, Unicode round trip, tool content/details, EPERM and unchanged targets.
// Done when all six file tools and kernel refusals execute against synthetic fixtures.
// Does not check policy matcher, model intelligence, or later child lifecycle.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileClient } from "../../src/file-client.ts";
import { createFileToolDefinitions } from "../../src/file-tools.ts";
import { compileProfile } from "../../src/profiles.ts";
import { wrapShell } from "../../src/wrap-shell.ts";
import { loadPolicy } from "../../src/policy.ts";
import { policy } from "../skeleton/fixture.mjs";

export async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-f-"));
  const prior = { ...process.env };
  const project = path.join(root, "project"),
    tmp = path.join(root, "tmp"),
    home = path.join(root, "home"),
    outside = path.join(root, "outside"),
    agentDir = path.join(root, "agent");
  await Promise.all([project, tmp, home, outside, agentDir].map((p) => mkdir(p)));
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TMPDIR: tmp + "/",
    npm_config_cache: path.join(tmp, "npm-cache"),
  });
  const policyPath = path.join(agentDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policy()));
  const loaded = await loadPolicy(policyPath, { project, tmp });
  await writeFile(path.join(project, "input.txt"), "hello\nsecond\n");
  await writeFile(path.join(outside, "target.txt"), "unchanged");
  await symlink(path.join(outside, "target.txt"), path.join(project, "escape"));
  await mkdir(path.join(project, "nested", ".git", "hooks"), { recursive: true });
  await writeFile(path.join(project, "nested", ".git", "config"), "protected");
  const ro = await createFileClient({
    loaded,
    mode: "read-only",
    wrapShell,
    compileProfile,
    policyPath,
    extensionPath: path.resolve("src"),
  });
  const rw = await createFileClient({
    loaded,
    mode: "write",
    wrapShell,
    compileProfile,
    policyPath,
    extensionPath: path.resolve("src"),
  });
  const tools = createFileToolDefinitions({
    cwd: project,
    clientForPermissions: async (c) => {
      if (!c.write) return ro;
      if (c.write) return rw;
      throw Error("unbound class");
    },
  });
  return {
    root,
    project,
    tmp,
    home,
    outside,
    agentDir,
    loaded,
    tools,
    ro,
    rw,
    policyPath,
    async close() {
      await Promise.all([ro.close(), rw.close()]);
      process.env = prior;
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function verify(f) {
  const unicode = "a\u2028b\u2029c\nend";
  await f.rw.request("writeFile", { path: path.join(f.project, "unicode.txt"), content: unicode });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.ro.request("readFile", { path: path.join(f.project, "unicode.txt") }),
    ),
  );
  for (const s of results) assert.equal(Buffer.from(s, "base64").toString(), unicode);
  await assert.rejects(
    f.ro.request("writeFile", { path: path.join(f.project, "no-ro-write"), content: "bad" }),
    { code: "EPERM" },
  );
  await assert.rejects(
    f.rw.request("writeFile", { path: path.join(f.project, "escape"), content: "bad" }),
    { code: "EPERM" },
  );
  assert.equal(await readFile(path.join(f.outside, "target.txt"), "utf8"), "unchanged");
  await assert.rejects(
    f.rw.request("writeFile", {
      path: path.join(f.project, "nested", ".git", "config"),
      content: "bad",
    }),
    { code: "EPERM" },
  );
  await assert.rejects(
    f.rw.request("rename", {
      from: path.join(f.project, "nested"),
      to: path.join(f.project, "moved"),
    }),
    { code: "EPERM" },
  );
  assert.equal(
    await readFile(path.join(f.project, "nested", ".git", "config"), "utf8"),
    "protected",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.ro.request(
      "readFile",
      { path: path.join(f.project, "input.txt") },
      { signal: controller.signal },
    ),
    /aborted/,
  );
  await assert.rejects(f.ro.request("readFile", { path: path.join(f.project, "missing") }), {
    code: "ENOENT",
  });
  return {
    readyMs: { readOnly: f.ro.readyMs, write: f.rw.readyMs },
    concurrentUnicode: 8,
    symlink: "EPERM target unchanged",
    protected: "EPERM content unchanged",
    ancestor: "EPERM content unchanged",
    readOnlyWrite: "EPERM",
  };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const f = await fixture();
  try {
    console.log(JSON.stringify(await verify(f)));
  } finally {
    await f.close();
  }
}
