import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const commands = [
  ["packages/pi-context/context-check.mjs"],
  ["--test", "packages/pi-delegation/lib/subagent/native-package-tools-stock.test.ts"],
  ["--test", "packages/pi-background/extensions/host-background-stock.test.ts"],
  ["packages/pi-permissions/test/stock-pi.mjs"],
  ["--test", "tests/packages.test.ts"],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
