import type { Usage } from "@earendil-works/pi-ai";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { usageLabel } from "pi-runtime";
import { type AgentMessageKind, displayAgentName } from "./messages.ts";

interface ReplyDetails {
  id: string;
  agent: string;
  sequence?: number;
  requestIds?: string[];
  sourceRequestIds?: string[];
  emittedAt?: string;
  text: string;
  truncated?: boolean;
  textTruncated?: boolean;
  textOffset?: number;
  nextTextOffset?: number;
  kind?: AgentMessageKind | "result";
  results?: ReplyDetails[];
  usageSummary?: { usage: Usage; missing: number };
  deliveryGaps?: Array<{
    id: string;
    agent: string;
    firstSequence: number;
    lastSequence: number;
    count: number;
  }>;
  unlistedOmittedReplies?: number;
}

export const renderSubagentReply: MessageRenderer<ReplyDetails> = (message, options, theme) => {
  const reply = message.details;
  if (reply?.results || reply?.deliveryGaps) {
    const container = new Container();
    for (const gap of reply.deliveryGaps ?? []) {
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          theme.fg(
            "customMessageLabel",
            theme.bold(`Delivery incomplete for ${displayAgentName(gap.agent)} agent`),
          ),
          0,
          0,
        ),
      );
      box.addChild(new Spacer(1));
      box.addChild(
        new Text(
          theme.fg(
            "customMessageText",
            `${gap.count} earlier repl${gap.count === 1 ? "y" : "ies"} (sequences ${gap.firstSequence}–${gap.lastSequence}) were omitted from automatic delivery. Use subagent_check to inspect retained history.`,
          ),
          0,
          0,
        ),
      );
      container.addChild(box);
    }
    if (reply.unlistedOmittedReplies) {
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(theme.fg("customMessageLabel", theme.bold("Additional delivery gaps")), 0, 0),
      );
      box.addChild(new Spacer(1));
      box.addChild(
        new Text(
          theme.fg(
            "customMessageText",
            `At least ${reply.unlistedOmittedReplies} more replies were omitted from automatic delivery. Inspect active children with agent_list and subagent_check, or read a recently closed child with subagent_check.`,
          ),
          0,
          0,
        ),
      );
      container.addChild(box);
    }
    for (const result of reply.results ?? []) {
      const component = renderSubagentReply({ ...message, details: result }, options, theme);
      if (component) container.addChild(component);
    }
    return container;
  }
  if (!reply || typeof reply.agent !== "string" || typeof reply.text !== "string") return undefined;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      theme.fg(
        "customMessageLabel",
        theme.bold(
          `${reply.kind === "progress" ? "Progress" : reply.kind === "question" ? "Question" : reply.kind === "message" ? "Message" : "Result"} from ${displayAgentName(reply.agent)} agent`,
        ),
      ),
      0,
      0,
    ),
  );
  if (reply.emittedAt) box.addChild(new Text(theme.fg("dim", `Emitted: ${reply.emittedAt}`), 0, 0));
  if (reply.sourceRequestIds?.length)
    box.addChild(
      new Text(
        theme.fg(
          "dim",
          `Active source requests observed at receipt: ${reply.sourceRequestIds.join(", ")}`,
        ),
        0,
        0,
      ),
    );
  if (reply.usageSummary)
    box.addChild(
      new Text(
        theme.fg("dim", `Known child usage at delivery: ${usageLabel(reply.usageSummary)}`),
        0,
        0,
      ),
    );
  if (options.expanded) {
    box.addChild(new Text(theme.fg("dim", `Agent ID: ${reply.id}`), 0, 0));
    if (reply.requestIds?.length)
      box.addChild(
        new Text(
          theme.fg("dim", `In response to parent messages: ${reply.requestIds.join(", ")}`),
          0,
          0,
        ),
      );
  }
  box.addChild(new Spacer(1));
  if (reply.truncated) {
    box.addChild(
      new Text(
        theme.fg(
          "customMessageLabel",
          `This child reply exceeded the retained text limit and may be incomplete. Use subagent_check({id: "${reply.id}", replySequence: ${reply.sequence}}) to inspect the saved text in pages; text beyond the saved portion is unavailable.`,
        ),
        0,
        0,
      ),
    );
    box.addChild(new Spacer(1));
  }
  if (reply.textTruncated) {
    box.addChild(
      new Text(
        theme.fg(
          "customMessageLabel",
          `More of this saved reply is available. Continue with subagent_check({id: "${reply.id}", replySequence: ${reply.sequence}, textOffset: ${reply.nextTextOffset ?? 0}}).`,
        ),
        0,
        0,
      ),
    );
    box.addChild(new Spacer(1));
  }
  box.addChild(
    new Markdown(reply.text, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("customMessageText", text),
    }),
  );
  return box;
};
