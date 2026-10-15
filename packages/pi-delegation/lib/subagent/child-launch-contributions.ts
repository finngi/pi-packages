import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_LAUNCH_CONTRIBUTIONS, type ChildLaunchContributionRequest } from "pi-contracts";

/** Trusted extension hooks share launch configuration; model tool inputs never enter this event. */
export function childLaunchContributions(events: ExtensionAPI["events"], ctx: ExtensionContext) {
  const extensions = new Set<string>(),
    env: Record<string, string> = {},
    failures: string[] = [];
  events.emit(CHILD_LAUNCH_CONTRIBUTIONS, {
    version: 1,
    ctx,
    contribute(value) {
      try {
        if (
          !value ||
          typeof value.extension !== "string" ||
          !isAbsolute(value.extension) ||
          Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
        ) {
          failures.push("Invalid trusted child launch extension");
          return;
        }
        for (const [key, entry] of Object.entries(value.env ?? {})) {
          if (!/^PI_CHILD_EXTENSION_[A-Z0-9_]+$/.test(key) || typeof entry !== "string") {
            failures.push("Child extension configuration may only set PI_CHILD_EXTENSION_* values");
            continue;
          }
          if (Object.hasOwn(env, key) && env[key] !== entry)
            failures.push(`Duplicate child extension configuration ${key}`);
          env[key] = entry;
        }
        extensions.add(value.extension);
      } catch {
        failures.push("Invalid trusted child launch configuration");
      }
    },
    reject(reason) {
      failures.push(String(reason));
    },
  } satisfies ChildLaunchContributionRequest);
  if (failures.length) throw Error(failures.join("; "));
  return { extensions: [...extensions], env };
}
