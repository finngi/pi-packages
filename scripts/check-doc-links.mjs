import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
let checked = 0;
const errors = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", ".artifacts"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".md")) {
      const text = (await readFile(path, "utf8")).replace(/```[\s\S]*?```/g, "");
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1];
        if (/^(?:https?:|mailto:|#)/.test(link)) continue;
        const target = decodeURIComponent(link.split("#")[0]);
        if (!target) continue;
        checked++;
        if (!(await stat(resolve(dirname(path), target)).catch(() => false)))
          errors.push(`${path}: missing ${target}`);
      }
    }
  }
}
await walk(root);
if (errors.length) throw Error(errors.join("\n"));
console.log(`${checked} relative documentation links checked.`);
