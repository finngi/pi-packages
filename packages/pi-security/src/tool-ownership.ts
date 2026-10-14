import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";

export async function effectToolOwnershipError(
  tools: Pick<ToolInfo, "name" | "sourceInfo">[],
  names: string[],
  entry: string,
): Promise<string | undefined> {
  let canonicalEntry: string;
  try {
    canonicalEntry = await realpath(entry);
  } catch {
    return "The loaded pi-security extension file is unavailable. Exit Pi and restart with pi --resume.";
  }
  const mismatches = await Promise.all(
    names.map(async (name) => {
      const source = tools.find((tool) => tool.name === name)?.sourceInfo?.path;
      if (!source) return `${name} (registration source missing)`;
      try {
        return (await realpath(source)) === canonicalEntry
          ? undefined
          : `${name} (different extension path)`;
      } catch {
        return `${name} (registration path unavailable)`;
      }
    }),
  );
  const failed = mismatches.filter((item) => item !== undefined);
  if (failed.length === 0) return undefined;
  return `Security tool registrations do not match the loaded pi-security extension: ${failed.join(", ")}. If Pi was upgraded during this session, exit Pi and restart with pi --resume. If this persists after restarting, check for another extension registering these tools.`;
}

export async function ownsEffectTools(
  tools: Pick<ToolInfo, "name" | "sourceInfo">[],
  names: string[],
  entry: string,
) {
  return (await effectToolOwnershipError(tools, names, entry)) === undefined;
}
