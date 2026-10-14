import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Resolve host-selected executables before the confined helper starts. */
export async function resolveHostExecutable(
  names: string[],
  directories: string[],
  selected?: string,
): Promise<string> {
  const candidates = selected
    ? [selected]
    : directories.flatMap((directory) => {
        if (!path.isAbsolute(directory))
          throw Error("Trusted executable directories must be absolute");
        return names.map((name) => path.join(directory, name));
      });
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw Error("Selected helper executable must be absolute");
    try {
      const canonical = await realpath(candidate);
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch (error) {
      if (selected) throw error;
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  throw Error(
    `Required helper executable ${names.join(" or ")} was not found in policy.env.path; configure trusted host directories`,
  );
}
