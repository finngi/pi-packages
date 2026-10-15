import { outputPreview } from "./output-buffer.ts";
import type { ReadResult, Snapshot } from "./types.ts";

const ANSWER_PREVIEW_CHARACTERS = 8000;

/** Render a bounded notification; full retained output stays accessible by ID. */
export function completionContent(snapshot: Snapshot, read: ReadResult): string {
  const answer = snapshot.result?.text;
  let output: string;
  if (answer) {
    output = answer.slice(0, ANSWER_PREVIEW_CHARACTERS);
    if (answer.length > ANSWER_PREVIEW_CHARACTERS) {
      output += "\n[Answer preview truncated after 8000 characters]";
    }
  } else {
    output = outputPreview(read);
    if (read.nextCursor < snapshot.outputBytes) {
      output += `\n[Output preview truncated; continue at byte cursor ${read.nextCursor}]`;
    }
  }
  return [
    `Background process ${snapshot.label} (${snapshot.id}) ${snapshot.status}. ${snapshot.reason ?? ""}`,
    output,
    snapshot.result?.summary ?? "",
    ...(read.gap ? ["[Earlier output dropped from retained buffer]"] : []),
    "Use background_process with this ID to inspect retained output.",
  ].join("\n");
}
