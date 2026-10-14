import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const namedDirs = ["project", "outside", "home", "agent", "tmp"];

async function snapshot(paths) {
  const files = new Map();
  async function visit(root, dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = `${root}/${path.relative(paths[root], absolute)}`;
      if (entry.isDirectory()) await visit(root, absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        const content = info.size <= 1024 * 1024 ? await readFile(absolute, "utf8") : null;
        files.set(relative, { size: info.size, content });
      }
    }
  }
  for (const name of namedDirs) await visit(name, paths[name]);
  return files;
}

function run(argv, paths, timeoutMs) {
  const result = spawnSync("/usr/bin/sandbox-exec", argv, {
    cwd: paths.project,
    env: {
      HOME: paths.home,
      PI_CODING_AGENT_DIR: paths.agent,
      TMPDIR: `${paths.tmp}/`,
      npm_config_cache: path.join(paths.tmp, "npm-cache"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
}

/** Run one compiled SBPL profile against argv in fresh, canonical trial paths. */
export async function runKernelTrial({ profile, argv, setup, timeoutMs = 5000 }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string")) {
    throw new TypeError("argv must be a nonempty string array");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-kernel-"));
  try {
    const paths = {};
    for (const name of namedDirs) {
      const dir = path.join(root, name);
      await mkdir(dir);
      paths[name] = await realpath(dir);
    }
    if (setup) await setup(paths);
    const before = await snapshot(paths);
    const compiled = typeof profile === "function" ? await profile(paths) : profile;
    if (typeof compiled !== "string" || !compiled.trim())
      throw new TypeError("profile must be SBPL text");
    const profilePath = path.join(root, "trial.sb");
    await writeFile(profilePath, compiled, { mode: 0o600 });

    // A failed profile probe is setup failure, not evidence of command refusal.
    const probe = run(["-f", profilePath, "/usr/bin/true"], paths, timeoutMs);
    if (probe.exitCode !== 0)
      return {
        setupFailure: probe,
        process: null,
        refusal: null,
        effects: { created: [], changed: [], removed: [] },
      };

    const process = run(["-f", profilePath, ...argv], paths, timeoutMs);
    const after = await snapshot(paths);
    const created = [...after]
      .filter(([name]) => !before.has(name))
      .map(([name, value]) => ({ path: name, ...value }));
    const changed = [...after]
      .filter(
        ([name, value]) =>
          before.has(name) && JSON.stringify(value) !== JSON.stringify(before.get(name)),
      )
      .map(([name, value]) => ({ path: name, ...value }));
    const removed = [...before.keys()].filter((name) => !after.has(name));
    const refusal =
      (process.stderr + "\n" + process.stdout)
        .split("\n")
        .find((line) => /operation not permitted|permission denied|sandbox.*den/i.test(line)) ??
      null;
    return { setupFailure: null, process, refusal, effects: { created, changed, removed } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
