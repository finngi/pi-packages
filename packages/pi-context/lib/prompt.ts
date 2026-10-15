import { getDocsPath } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ContextFile } from "./local-context.ts";

/** Selected snippets guide agent behavior; paths identify their source without changing their scope. */
export function renderInstructions(files: ContextFile[]): string {
  const xml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  return files
    .map(({ path, content }) => `<instruction path="${xml(path)}">\n${content}\n</instruction>`)
    .join("\n\n");
}

/** Keep harness help discoverable without inserting an SDK topic catalogue into every prompt. */
export function compactPiDocumentation(options: BuildSystemPromptOptions): void {
  if (
    options.customPrompt ||
    options.forceSystemPrompt !== undefined ||
    options.sections?.docs !== undefined
  )
    return;
  options.sections ??= {};
  options.sections.docs = options.skills?.some((skill) => skill.name === "pi-help")
    ? "For Pi harness questions, consult the pi-help skill."
    : `Pi harness documentation: ${getDocsPath()}`;
}
