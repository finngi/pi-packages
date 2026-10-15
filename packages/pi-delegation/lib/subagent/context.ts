/** How much of the parent conversation an agent is given: none, all of it, or the last N user turns. */
export type ContextSetting = "none" | "all" | number;

const BAD_CONTEXT = 'conversation must be "none", "all" or a positive number of turns';

/** A YAML value or the tool's string argument; undefined when absent. */
export function parseContext(value: unknown): ContextSetting | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "none" || value === "all") return value;
  const turns =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (Number.isInteger(turns) && turns > 0) return turns;
  throw new Error(BAD_CONTEXT);
}

/**
 * What a call gets. The agent file sets the default and the ceiling: `none` never takes the conversation, a number
 * takes at most that many turns, `all` or nothing takes whatever the caller asks for. The default without a file
 * setting is none, because a clean context is the point of an agent.
 */
export function resolveContext(
  request: string | undefined,
  agentSetting: ContextSetting | undefined,
): ContextSetting {
  const wanted = parseContext(request);
  if (agentSetting === undefined) return wanted ?? "none";
  if (agentSetting === "none") {
    if (wanted === undefined || wanted === "none") return "none";
    throw new Error("this agent does not take the parent conversation");
  }
  if (wanted === undefined) return agentSetting;
  if (agentSetting === "all" || wanted === "none") return wanted;
  if (wanted === "all" || wanted > agentSetting)
    throw new Error(
      `this agent takes at most the last ${agentSetting} turns of the parent conversation`,
    );
  return wanted;
}

interface Entry {
  role: "user" | "assistant";
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The parent conversation as text, for the child's task file. Only what the user and the assistant said is kept:
 * thinking, tool calls and results, shell output and extension messages are left out, as is anything not text.
 * "Last N turns" counts user messages, including the one that led to this call.
 */
export function transcript(messages: readonly unknown[], setting: ContextSetting): string {
  if (setting === "none") return "";
  const entries: Entry[] = [];
  for (const message of messages as { role?: string; content?: unknown }[]) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = textOf(message.content).trim();
    // An image-only user message is still a turn, so it counts towards "last N" even though it has no text.
    if (text || message.role === "user") entries.push({ role: message.role, text });
  }
  const users = entries.flatMap((entry, index) => (entry.role === "user" ? [index] : []));
  const from = setting !== "all" && users.length > setting ? users[users.length - setting] : 0;
  return entries
    .slice(from)
    .filter((entry) => entry.text)
    .map((entry) => `[${entry.role === "user" ? "User" : "Assistant"}]: ${entry.text}`)
    .join("\n\n");
}

/** The task file's content: the task alone, or the shared conversation followed by the task. */
export function taskFileText(task: string, conversation: string): string {
  if (!conversation) return task;
  return `<parent_conversation>\n${conversation}\n</parent_conversation>\n\n<task>\n${task}\n</task>`;
}
