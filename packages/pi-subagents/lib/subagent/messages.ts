export const MESSAGE_BRIDGE = "pi-subagents-message:v1:";
export const MAX_MESSAGE_BYTES = 64 * 1024;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type AgentMessageKind = "progress" | "question" | "message";
export interface AgentMessage {
  to: string;
  message: string;
  mode: "steer" | "followUp";
  kind: AgentMessageKind;
}

export function agentEnvelope(
  kind: AgentMessageKind | "result",
  from: string,
  text: string,
  options: {
    sequence?: number;
    truncated?: boolean;
    emittedAt?: string;
    sourceRequestIds?: string[];
    requestIds?: string[];
  } = {},
): string {
  const attributes = [
    `from="${escapeXml(from)}"`,
    ...(options.emittedAt ? [`emitted_at="${escapeXml(options.emittedAt)}"`] : []),
    ...(options.sourceRequestIds?.length
      ? [`source_request_ids="${escapeXml(options.sourceRequestIds.join(" "))}"`]
      : []),
    ...(options.requestIds?.length
      ? [`request_ids="${escapeXml(options.requestIds.join(" "))}"`]
      : []),
    ...(options.sequence === undefined ? [] : [`sequence="${options.sequence}"`]),
    ...(options.truncated ? ['truncated="true"'] : []),
  ].join(" ");
  const notice =
    kind === "result" && options.truncated && options.sequence !== undefined
      ? `\n<reply_notice>The child reply exceeded the retained text limit and may be incomplete. Use subagent_check({id: "${escapeXml(from)}", replySequence: ${options.sequence}}) to read retained text in bounded chunks; text beyond the saved portion is unavailable.</reply_notice>`
      : "";
  return `<agent_${kind} ${attributes}>\n${escapeXml(text)}${notice}\n</agent_${kind}>`;
}

export function displayAgentName(name: string): string {
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function validateMessage(value: unknown): AgentMessage {
  const input = value as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["to", "message", "mode", "kind"].includes(key)) ||
    typeof input.to !== "string" ||
    !/^(?:agent-)?[a-z]+-[a-z]+-[a-z]+$/.test(input.to) ||
    typeof input.message !== "string" ||
    !input.message.trim() ||
    Buffer.byteLength(input.message) > MAX_MESSAGE_BYTES ||
    (input.kind !== undefined &&
      (typeof input.kind !== "string" ||
        !["progress", "question", "message"].includes(input.kind))) ||
    (input.mode !== undefined && input.mode !== "steer" && input.mode !== "followUp")
  )
    throw Error("Invalid agent message: supply a recipient ID and up to 64 KiB of text");
  return {
    to: input.to,
    message: input.message,
    mode: input.mode ?? "steer",
    kind: (input.kind as AgentMessageKind) ?? "message",
  };
}
