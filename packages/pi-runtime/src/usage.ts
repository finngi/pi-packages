import { readTokenUsage } from "./token-usage.ts";
import type { Usage } from "@earendil-works/pi-ai";

export interface UsageRecord {
  id: string;
  kind: "child" | "classifier" | "evaluator";
  source: string;
  ownerSessionId?: string;
  label: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  incomplete?: boolean;
}
export function readUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return;
  const usage = value as Usage;
  if (!readTokenUsage(usage) || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0)
    return;
  if (
    !usage.cost ||
    ![
      usage.cost.input,
      usage.cost.output,
      usage.cost.cacheRead,
      usage.cost.cacheWrite,
      usage.cost.total,
    ].every((n) => Number.isFinite(n) && n >= 0)
  )
    return;
  return structuredClone(usage);
}
export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export function addUsage(first: Usage, second: Usage): Usage {
  const usage = emptyUsage();
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
    usage[key] = first[key] + second[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    usage.cost[key] = first.cost[key] + second.cost[key];
  if (first.reasoning !== undefined || second.reasoning !== undefined)
    usage.reasoning = (first.reasoning ?? 0) + (second.reasoning ?? 0);
  if (first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined)
    usage.cacheWrite1h = (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0);
  return usage;
}
export function replayUsageLedger(
  entries: readonly import("@earendil-works/pi-coding-agent").SessionEntry[],
): UsageLedger {
  const ledger = new UsageLedger();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "pi-runtime.usage.v1")
      ledger.record(entry.data as UsageRecord);
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const details = entry.message.details as { piUsageIds?: string[] } | undefined;
      for (const id of details?.piUsageIds ?? []) ledger.forwarded.add(id);
    }
  }
  return ledger;
}
export class UsageLedger {
  readonly records = new Map<string, UsageRecord>();
  readonly forwarded = new Set<string>();
  record(record: UsageRecord): boolean {
    const existing = this.records.get(record.id);
    if (existing && (existing.usage || !record.usage)) return false;
    this.records.set(record.id, structuredClone(record));
    return true;
  }
  total(source?: string, kind?: UsageRecord["kind"]) {
    let usage = emptyUsage(),
      missing = 0;
    for (const record of this.records.values()) {
      if (source !== undefined && record.source !== source) continue;
      if (kind !== undefined && record.kind !== kind) continue;
      if (record.usage) usage = addUsage(usage, record.usage);
      if (!record.usage || record.incomplete) missing++;
    }
    return { usage, missing };
  }
  pending() {
    let usage = emptyUsage();
    const ids: string[] = [];
    for (const record of this.records.values()) {
      if (!record.usage || this.forwarded.has(record.id)) continue;
      usage = addUsage(usage, record.usage);
      ids.push(record.id);
    }
    return { usage, ids };
  }
}
export function usageLabel(summary: { usage: Usage; missing: number }): string {
  return `${summary.usage.totalTokens} tokens · $${summary.usage.cost.total.toFixed(4)} estimated${summary.missing ? ` · incomplete (${summary.missing})` : ""}`;
}
