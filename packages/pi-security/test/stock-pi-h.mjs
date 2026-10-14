import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-stock-h-"));
const oldCwd = process.cwd();
const oldEnv = { ...process.env };
let session;
try {
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const cache = path.join(root, "npm-cache");
  await Promise.all([project, home, agentDir, cache].map((dir) => mkdir(dir)));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.npm_config_cache = cache;
  process.env.TMPDIR = `${root}/`;
  process.chdir(project);

  const sdk = await import("@earendil-works/pi-coding-agent");
  const packageFile = fileURLToPath(
    new URL("../../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
  );
  const packageInfo = JSON.parse(await readFile(packageFile, "utf8"));
  assert.equal(packageInfo.version, "1.1.0");

  const resultPath = path.join(root, "result.json");
  const extensionPath = path.join(root, "h-extension.mjs");
  const exampleUrl = pathToFileURL(
    fileURLToPath(new URL("./fixtures/kernel/examples.mjs", import.meta.url)),
  ).href;
  await writeFile(
    extensionPath,
    `
    import { writeFile } from 'node:fs/promises';
    import { scopedBuildWrite } from ${JSON.stringify(exampleUrl)};
    export default function (pi) {
      pi.on('session_start', async () => {
        try {
          const result = await scopedBuildWrite();
          await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ ok: true, result }));
        } catch (error) {
          await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ ok: false, error: String(error) }));
          throw error;
        }
      });
    }
  `,
  );

  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.equal(
    loader.getExtensions().errors.length,
    0,
    JSON.stringify(loader.getExtensions().errors),
  );
  assert.equal(
    loader.getExtensions().extensions.some((extension) => extension.path === extensionPath),
    true,
  );
  const created = await sdk.createAgentSession({
    cwd: project,
    agentDir,
    resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory(),
    sessionManager: sdk.SessionManager.inMemory(),
    noTools: "all",
  });
  session = created.session;
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  assert.deepEqual(errors, []);
  const smoke = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(smoke.ok, true, smoke.error);
  assert.equal(smoke.result.process.exitCode, 0);
  assert.equal(
    smoke.result.effects.created.find((file) => file.path === "project/marker.txt")?.content,
    "scoped-ok",
  );
  console.log(
    JSON.stringify({
      piVersion: packageInfo.version,
      extensionLoaded: true,
      callback: "session_start",
      exitCode: smoke.result.process.exitCode,
      marker: "scoped-ok",
    }),
  );
} finally {
  session?.dispose();
  process.chdir(oldCwd);
  for (const key of ["HOME", "PI_CODING_AGENT_DIR", "npm_config_cache", "TMPDIR"]) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  await rm(root, { recursive: true, force: true });
}
