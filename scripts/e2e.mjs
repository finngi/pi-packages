import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const commands = [
  ["packages/pi-context/context-check.mjs"],
  ["packages/pi-codex-search/security-check.mjs"],
  ["packages/pi-security/test/extensions-e2e.mjs"],
  ["packages/pi-security/test/process-handover.mjs"],
  ["--test", "packages/pi-security/test/integration/*.test.mjs"],
  ["--test", "tests/packages.test.ts"],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
