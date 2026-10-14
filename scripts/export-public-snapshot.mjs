import { execFileSync } from "node:child_process";
import { mkdir, lstat, copyFile, stat, chmod } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || !relative(root, output).startsWith(".."))
  throw Error("Pass a new snapshot directory outside the development checkout");
if (await stat(output).catch(() => false)) throw Error("Snapshot destination already exists");
execFileSync(process.execPath, [join(root, "scripts/check-public-boundary.mjs")], {
  cwd: root,
  stdio: "inherit",
});
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
await mkdir(output, { recursive: true, mode: 0o700 });
const copied = [];
for (const name of files) {
  const source = join(root, name),
    info = await lstat(source).catch(() => undefined);
  if (!info) continue;
  if (!info.isFile()) throw Error(`Unsupported snapshot entry: ${name}`);
  const target = join(output, name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, info.mode & 0o777);
  copied.push(name);
}
execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: output });
// A new export contains only the already boundary-checked file set.
execFileSync("git", ["add", "--", ...copied], { cwd: output });
execFileSync(
  "git",
  [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Pi extensions contributors",
    "-c",
    "user.email=contributors@users.noreply.github.com",
    "commit",
    "--quiet",
    "-m",
    "Initial reusable Pi extension snapshot",
  ],
  { cwd: output },
);
console.log(
  `Clean publication snapshot created at ${output}; one local commit, no remote, nothing published.`,
);
