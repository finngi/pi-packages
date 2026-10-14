import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { USAGE_EVENT } from "pi-contracts";
import {
  UsageLedger,
  replayUsageLedger,
  readUsage,
  addUsage,
  emptyUsage,
  usageLabel,
  type UsageRecord,
} from "./usage.ts";

const SERVICE = "pi-runtime:accounting:v1";
export const USAGE_BRIDGE = "pi-runtime-usage:v1:";
export function installAccounting(pi: ExtensionAPI): void {
  let installed = false;
  pi.events.emit(SERVICE, {
    respond: () => {
      installed = true;
    },
  });
  if (installed) return;
  pi.events.on(SERVICE, (value) => (value as { respond(): void }).respond());
  let ledger = new UsageLedger(),
    context: ExtensionContext | undefined;
  const refresh = () => context?.ui.setStatus("pi-usage", undefined);
  const replay = (ctx: ExtensionContext) => {
    context = ctx;
    ledger = replayUsageLedger(ctx.sessionManager.getEntries());
    refresh();
  };
  pi.on("session_start", (_event, ctx) => replay(ctx));
  pi.on("session_tree", (_event, ctx) => replay(ctx));
  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
    refresh();
  });
  pi.events.on(USAGE_EVENT, (data) => {
    const record = data as UsageRecord;
    if (record?.ownerSessionId && record.ownerSessionId !== context?.sessionManager.getSessionId())
      return;
    if (
      !context ||
      !record ||
      typeof record.id !== "string" ||
      !["child", "classifier", "evaluator"].includes(record.kind) ||
      typeof record.source !== "string" ||
      typeof record.label !== "string"
    )
      return;
    const value = { ...record, usage: readUsage(record.usage) };
    if (!ledger.record(value)) return;
    pi.appendEntry("pi-runtime.usage.v1", value);
    refresh();
    if (process.env.PI_SUBAGENT === "1" && record.kind === "classifier") {
      void context.ui
        .select(USAGE_BRIDGE + JSON.stringify(value), ["Record"], { timeout: 30_000 })
        .catch(() => {});
    }
  });
  pi.on("tool_result", (event) => {
    if (event.parentToolCallId) return;
    const pending = ledger.pending();
    if (!pending.ids.length) return;
    const existing = readUsage(event.usage);
    for (const id of pending.ids) ledger.forwarded.add(id);
    const details =
      event.details && typeof event.details === "object"
        ? (event.details as Record<string, unknown>)
        : {};
    return {
      usage: existing ? addUsage(existing, pending.usage) : pending.usage,
      details: {
        ...details,
        piUsageIds: [
          ...(Array.isArray(details.piUsageIds) ? details.piUsageIds : []),
          ...pending.ids,
        ],
      },
    };
  });
  pi.registerCommand("costs", {
    description:
      "Show total usage, agent/classifier/evaluator breakdowns and accounting limitations",
    handler: async (_args, ctx) => {
      let parent = emptyUsage(),
        missing = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        const value =
          entry.type === "message" && entry.message.role === "assistant"
            ? entry.message.usage
            : entry.type === "usage" ||
                entry.type === "compaction" ||
                entry.type === "branch_summary"
              ? entry.usage
              : undefined;
        const usage = readUsage(value);
        if (usage) parent = addUsage(parent, usage);
        else if (entry.type === "message" && entry.message.role === "assistant") missing++;
      }
      let nativeTools = emptyUsage();
      for (const entry of ctx.sessionManager.getEntries())
        if (entry.type === "message" && entry.message.role === "toolResult") {
          const usage = readUsage(entry.message.usage);
          if (usage) nativeTools = addUsage(nativeTools, usage);
        }
      const total = addUsage(addUsage(parent, nativeTools), ledger.pending().usage);
      const sources = new Map(
        [...ledger.records.values()].map((record) => [`${record.kind}:${record.source}`, record]),
      );
      const lines = [
        `Session total: ${usageLabel({ usage: total, missing: missing + ledger.total().missing })}`,
        "Costs use provider/model price estimates, not an invoice. Missing receipts make totals a known lower bound. Input includes repeated and cached requests; tool receipts already included in session totals are not added again.",
        `Main model calls and summaries: ${usageLabel({ usage: parent, missing })}`,
        ...[...sources.values()].map(
          (record) =>
            `${record.kind}: ${record.label}${record.source.startsWith("agent-") ? ` (${record.source})` : ""} — ${usageLabel(ledger.total(record.source, record.kind))}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
