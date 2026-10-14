import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { createFetchProxy } from "../../src/fetch-proxy.ts";
import { wrapShell } from "../../src/wrap-shell.ts";
export const cases = [
  {
    name: "curl",
    host: "example.com",
    allow: "/usr/bin/curl --fail --silent --show-error --max-time 20 https://example.com/",
    deny: "/usr/bin/curl --fail --silent --show-error --max-time 20 https://www.iana.org/",
  },
  {
    name: "git",
    host: "github.com",
    allow:
      "/usr/bin/git -c credential.helper= -c http.sslVerify=true ls-remote https://github.com/earendil-works/pi.git HEAD",
    deny: "/usr/bin/git -c credential.helper= ls-remote https://gitlab.com/gitlab-org/gitlab.git HEAD",
  },
  {
    name: "npm",
    host: "registry.npmjs.org",
    allow:
      "npm --userconfig=/dev/null --fetch-retries=0 --fetch-timeout=20000 view is-number version --registry=https://registry.npmjs.org",
    deny: "npm --userconfig=/dev/null --fetch-retries=0 --fetch-timeout=20000 view is-number version --registry=https://registry.yarnpkg.com",
  },
  {
    name: "go",
    host: "proxy.golang.org",
    allow: "GOSUMDB=off GOPROXY=https://proxy.golang.org go mod download -json rsc.io/quote@v1.5.2",
    deny: "GOSUMDB=off GOPROXY=https://goproxy.io go mod download -json rsc.io/quote@v1.5.1",
  },
];
export async function createLab() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-security-n-")));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    tmp = path.join(root, "tmp"),
    agentDir = path.join(root, "agent");
  await Promise.all([home, project, tmp, agentDir].map((dir) => mkdir(dir)));
  await writeFile(path.join(tmp, "npm-global-config"), "");
  const loaded = {
    project,
    tmp,
    policy: {
      resources: { network: cases.map((c) => c.host) },
      env: { path: [], assignAllow: [] },
    },
    filesystem: { writeAllow: [project, tmp], writeDeny: [], readDeny: [] },
  };
  const proxy = await createFetchProxy({ hosts: cases.map((c) => c.host) });
  let connections = 0;
  const direct = createServer((s) => {
    connections++;
    s.end();
  });
  await new Promise((resolve) => direct.listen(0, "127.0.0.1", resolve));
  const script = path.join(project, "direct.mjs");
  await writeFile(
    script,
    `import {connect} from 'node:net'; const s=connect(${direct.address().port},'127.0.0.1');s.on('connect',()=>{console.log('connected');s.end()});s.on('error',e=>{console.error(e.code,e.message);process.exitCode=4});`,
  );
  let counter = 0;
  async function execute(command, host, permissions = { write: true, network: [[host]] }) {
    const lease = permissions.network.length ? await proxy.lease(permissions.network) : undefined;
    try {
      const wrapped = wrapShell(command, permissions, loaded, {
        fetchLease: lease,
        envAssign: lease?.env,
      });
      const profile = wrapped.profile;
      const profilePath = path.join(tmp, `profile-${++counter}.sb`);
      await writeFile(profilePath, profile);
      const env = {
        ...wrapped.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        npm_config_globalconfig: path.join(tmp, "npm-global-config"),
        GOMODCACHE: path.join(tmp, "go-mod-cache"),
        GOTOOLCHAIN: "local",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...(lease?.env ?? {}),
      };
      let output = "";
      const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, ...wrapped.argv], {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      clearTimeout(timer);
      return { exitCode, output, permissions };
    } finally {
      await lease?.release();
    }
  }
  return {
    root,
    home,
    project,
    tmp,
    agentDir,
    execute,
    directCommand: `${process.execPath} direct.mjs`,
    connectionCount: () => connections,
    async close() {
      await proxy.close();
      await new Promise((resolve) => direct.close(resolve));
      await new Promise((resolve) =>
        spawn("/bin/chmod", ["-R", "u+w", root]).once("close", resolve),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
