import type { ClassifierView, ToolCall } from "./types.ts";

export const MAX_CLASSIFIER_BYTES = 64 * 1024;

function messages(entries: readonly unknown[]): Array<{ role: string; content: any }> {
  return entries.flatMap((entry: any) =>
    entry?.type === "message" && entry.message ? [entry.message] : [],
  );
}

/** Restore genuine root user text from the selected branch, never child dialogue. */
export function recentUserMessages(entries: readonly unknown[]): string[] {
  return messages(entries)
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n"),
    )
    .filter(Boolean);
}

/** Match the recorded assistant call, including its nested codemode descendants. */
export function assistantDecisionBeforeTool(
  entries: readonly unknown[],
  call: Pick<ToolCall, "toolCallId" | "parentToolCallId">,
): ClassifierView["assistantDecision"] {
  const target = call.parentToolCallId ?? call.toolCallId;
  for (const message of messages(entries).reverse()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let index = message.content.findIndex(
      (block: any) =>
        block.type === "toolCall" && typeof block.id === "string" && block.id === target,
    );
    if (index < 0 && call.parentToolCallId) {
      let longest = 0;
      message.content.forEach((block: any, candidate: number) => {
        if (
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          target.startsWith(`${block.id}/`) &&
          block.id.length > longest
        ) {
          index = candidate;
          longest = block.id.length;
        }
      });
    }
    if (index < 0) continue;
    const preceding = message.content.slice(0, index);
    return {
      text: preceding
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n"),
      thinking: preceding
        .filter((block: any) => block.type === "thinking")
        .map((block: any) => block.thinking)
        .join("\n"),
    };
  }
  return undefined;
}
