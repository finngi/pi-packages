import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const errors = [];
let checked = 0;
for (const name of files) {
  const path = join(root, name),
    info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) continue;
  checked++;
  if (
    /(?:^|\/)(?:docs\/inputs|docs\/results|private-history|private-archive)(?:\/|\.|$)/.test(name)
  )
    errors.push(`${name}: private research path`);
  if (info.size > 4_000_000) continue;
  const text = await readFile(path, "utf8");
  if (/\/Users\/(?!dev\b|example\b|fixture\b|test\b)[^/\s"']+\//.test(text))
    errors.push(`${name}: personal macOS home path`);
  if (
    /(?:src|lib|extensions)\//.test(name) &&
    !name.includes("test") &&
    /DEFAULT_(?:EVALUATOR|CLASSIFIER)_MODEL\s*=\s*["'][^"']+\//.test(text)
  )
    errors.push(`${name}: provider-specific runtime default`);
}
if (errors.length) throw Error(errors.join("\n"));
console.log(
  `Public source boundary checked across ${checked} tracked/local files; private history is outside the publication snapshot.`,
);
