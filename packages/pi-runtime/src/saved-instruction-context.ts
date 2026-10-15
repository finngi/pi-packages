import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SAVED_INSTRUCTION_CONTEXT, type SavedInstructionContextRequest } from "pi-contracts";

export { SAVED_INSTRUCTION_CONTEXT, type SavedInstructionContextRequest } from "pi-contracts";

/** No provider means no saved instructions; the parent's rendered section is never a fallback. */
export function savedInstructionContext(
  events: Pick<ExtensionAPI["events"], "emit">,
  ctx: ExtensionContext,
): string | undefined {
  const values: string[] = [],
    failures: string[] = [];
  events.emit(SAVED_INSTRUCTION_CONTEXT, {
    version: 1,
    ctx,
    contribute(instructions) {
      if (typeof instructions !== "string") failures.push("Invalid saved instruction context");
      else values.push(instructions);
    },
    reject(reason) {
      failures.push(String(reason));
    },
  } satisfies SavedInstructionContextRequest);
  if (failures.length) throw Error(failures.join("; "));
  if (values.length > 1) throw Error("Duplicate saved instruction context provider");
  return values[0];
}
