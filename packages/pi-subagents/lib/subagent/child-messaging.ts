import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { securityService } from "../security-service.ts";
import { MESSAGE_BRIDGE, validateMessage } from "./messages.ts";
import type { Communication } from "pi-contracts";

export const messageParameters = Type.Object({
  to: Type.String({ description: "Recipient agent ID" }),
  message: Type.String({ description: "Message text" }),
  kind: Type.Optional(
    Type.Union([Type.Literal("progress"), Type.Literal("question"), Type.Literal("message")], {
      description:
        "Defaults to actionable message. Use progress for routine telemetry to your parent only; it never starts an idle parent turn. Questions and messages can wake recipients.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
      description:
        "Defaults to steer: deliver messages, questions and corrections at the next safe tool boundary. Use followUp only when the message can wait until the recipient finishes its current run.",
    }),
  ),
});
export const messageDescription =
  "Send to an existing agent ID. kind defaults to message for actionable coordination; question also wakes recipients. Use kind: progress only for routine telemetry to your parent: it is retained without starting an idle parent turn. Returns broker/RPC acceptance, not proof of reading, task acceptance or an answer. steer delivers at the next safe tool boundary; followUp waits for the current run to finish.";

export function registerChildMessaging(
  pi: ExtensionAPI,
  boundContext?: Communication & { workspace: string },
) {
  const context = () => boundContext ?? securityService(pi.events).getAgentContext?.();
  pi.registerTool({
    name: "agent_list",
    label: "Agent sessions",
    description: "List reachable agent sessions with their IDs, names and states.",
    promptSnippet: "List reachable agent IDs, names and states.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!context()) throw Error("Agent communication is not bound to this session");
      const answer = await ctx.ui.select(
        MESSAGE_BRIDGE + JSON.stringify({ operation: "list" }),
        ["Deliver"],
        { signal, timeout: 30_000 },
      );
      if (typeof answer !== "string") throw Error("Agent listing timed out or was cancelled");
      const value = JSON.parse(answer);
      if (value.accepted !== true) throw Error(value.error ?? "Agent listing failed");
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
  pi.registerTool({
    name: "agent_message",
    label: "Message agent",
    description: messageDescription,
    promptSnippet: "Send progress, questions or coordination to an agent ID.",
    parameters: messageParameters,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!context()) throw Error("Agent communication is not bound to this session");
      const frame = validateMessage(params);
      const answer = await ctx.ui.select(
        MESSAGE_BRIDGE + JSON.stringify({ ...frame, emittedAt: new Date().toISOString() }),
        ["Deliver"],
        {
          signal,
          timeout: 30_000,
        },
      );
      if (typeof answer !== "string")
        throw Error("Agent message delivery was cancelled or timed out");
      const receipt = JSON.parse(answer);
      if (!receipt || receipt.accepted !== true)
        throw Error(receipt?.error ?? "Agent message was not delivered");
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  });
}
