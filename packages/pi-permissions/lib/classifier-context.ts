export interface ClassifierView {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  /** What the user asked for. In a child agent, the root session's user messages. */
  userMessages: string[];
  /** A child agent's assignment, written by the parent agent rather than the user. */
  childTask?: string;
  /** The agent's text and reasoning immediately before this call. */
  assistantDecision?: { text: string; thinking: string };
}

const TRANSCRIPT_BYTES = 64 * 1024;
/** Larger calls go to the user: the classifier must see the whole call it approves. */
export const MAX_CALL_BYTES = 24 * 1024;
const FIELD_BYTES = 8 * 1024;

const bytes = (text: string) => Buffer.byteLength(text);
function tail(text: string, limit = FIELD_BYTES) {
  if (bytes(text) <= limit) return text;
  return `[…trimmed]${Buffer.from(text).subarray(-limit).toString("utf8")}`;
}

function messages(entries: readonly unknown[]): Array<{ role: string; content: any }> {
  return entries.flatMap((entry: any) =>
    entry?.type === "message" && entry.message ? [entry.message] : [],
  );
}

/** User text on the selected branch, oldest first. */
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

/** Text and reasoning before the recorded call, including nested codemode calls. */
export function assistantDecisionBeforeTool(
  entries: readonly unknown[],
  call: { toolCallId: string; parentToolCallId?: string },
): ClassifierView["assistantDecision"] {
  const target = call.parentToolCallId ?? call.toolCallId;
  for (const message of messages(entries).reverse()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let index = message.content.findIndex(
      (block: any) => block.type === "toolCall" && block.id === target,
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
    const join = (type: string, key: string) =>
      preceding
        .filter((block: any) => block.type === type)
        .map((block: any) => block[key])
        .join("\n");
    return { text: join("text", "text"), thinking: join("thinking", "thinking") };
  }
  return undefined;
}

/** Render the view for the model, dropping the oldest user messages to fit. */
export function classifierTranscript(view: ClassifierView): string {
  const fixed = [
    ...(view.childTask === undefined
      ? []
      : [`Child agent task (written by the parent agent): ${tail(view.childTask)}`]),
    ...(view.assistantDecision
      ? [
          `Agent text before the call: ${tail(view.assistantDecision.text)}`,
          ...(view.assistantDecision.thinking
            ? [`Agent reasoning before the call: ${tail(view.assistantDecision.thinking)}`]
            : []),
        ]
      : []),
    `Working directory: ${view.cwd}`,
    `Tool call: ${view.tool} ${JSON.stringify(view.input)}`,
  ];
  let budget = TRANSCRIPT_BYTES - bytes(fixed.join("\n"));
  const users: string[] = [];
  for (const text of [...view.userMessages].reverse()) {
    const line = `User: ${tail(text)}`;
    if (bytes(line) > budget && users.length) break;
    users.unshift(line);
    budget -= bytes(line);
  }
  if (users.length < view.userMessages.length) users.unshift("[earlier user messages omitted]");
  return [...users, ...fixed].join("\n");
}
