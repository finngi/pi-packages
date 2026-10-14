import type { LoadedPolicy, ProfileOptions } from "./types.ts";
import type * as profileCompiler from "./profiles.ts";
import { realpathSync } from "node:fs";
import { sbplString } from "./profiles.ts";

export async function compileFileProfile(
  loaded: LoadedPolicy,
  mode: "read-only" | "write",
  options: ProfileOptions & {
    compileProfile: (
      ...args: Parameters<typeof profileCompiler.compileProfile>
    ) => string | Promise<string>;
    executables: string[];
    helperPath: string;
  },
) {
  if (!["read-only", "write"].includes(mode)) throw Error("invalid helper mode");
  const { compileProfile, executables, helperPath, ...compilerOptions } = options;
  const base = await compileProfile(
    loaded,
    { write: mode === "write", network: [] },
    compilerOptions,
  );
  if (!base.includes("(deny default)") || !base.includes("(allow process-exec)"))
    throw Error("unexpected compiler base");
  const trusted = [...new Set(executables.map((p) => realpathSync(p)))];
  if (!trusted.length) throw Error("missing helper executables");
  const out = base.replace(
    "(allow process-exec)",
    `(allow process-exec ${trusted.map((p) => `(literal ${sbplString(p)})`).join(" ")})`,
  );
  if (/\(allow network/.test(out)) throw Error("network not allowed in helper");
  return out + `(deny file-write* (subpath ${sbplString(helperPath)}))\n`;
}
