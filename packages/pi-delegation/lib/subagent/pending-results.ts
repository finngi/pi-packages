export interface PendingResult {
  id: string;
  agent: string;
  sequence: number;
  text: string;
  [key: string]: unknown;
}

export interface OmittedPendingResults {
  id: string;
  agent: string;
  firstSequence: number;
  lastSequence: number;
  count: number;
}

export const MAX_PENDING_RESULTS = 64;
export const MAX_PENDING_RESULT_BYTES = 4 * 1024 * 1024 - 128 * 1024;
export const MAX_PENDING_GAP_SUMMARIES = 64;

/** Bounds replies waiting for a safe parent delivery boundary. */
export class PendingResults<T extends PendingResult = PendingResult> {
  private readonly items = new Map<string, T>();
  private readonly sizes = new Map<string, number>();
  private readonly omitted = new Map<string, OmittedPendingResults>();
  private bytes = 0;
  private unlistedOmittedReplies = 0;
  private readonly measure: (item: T) => number;

  constructor(measure: (item: T) => number = (item) => Buffer.byteLength(item.text)) {
    this.measure = measure;
  }

  get size(): number {
    return this.items.size;
  }

  get hasEntries(): boolean {
    return this.items.size > 0 || this.omitted.size > 0 || this.unlistedOmittedReplies > 0;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  textBytes(key: string): number | undefined {
    const item = this.items.get(key);
    return item ? Buffer.byteLength(item.text, "utf8") : undefined;
  }

  add(key: string, item: T): T[] {
    const itemBytes = this.measure(item);
    if (!Number.isSafeInteger(itemBytes) || itemBytes < 0)
      throw new Error("A pending reply has an invalid measured size");
    const previous = this.items.get(key);
    if (previous) {
      this.bytes -= this.sizes.get(key) ?? 0;
      this.items.delete(key);
      this.sizes.delete(key);
    }
    if (itemBytes > MAX_PENDING_RESULT_BYTES) {
      this.recordOmitted(item);
      return [item];
    }
    this.items.set(key, item);
    this.sizes.set(key, itemBytes);
    this.bytes += itemBytes;

    const dropped: T[] = [];
    while (this.items.size > MAX_PENDING_RESULTS || this.bytes > MAX_PENDING_RESULT_BYTES) {
      const oldest = this.items.entries().next().value as [string, T] | undefined;
      if (!oldest) break;
      const [oldestKey, removed] = oldest;
      this.items.delete(oldestKey);
      this.bytes -= this.sizes.get(oldestKey) ?? 0;
      this.sizes.delete(oldestKey);
      dropped.push(removed);
      this.recordOmitted(removed);
    }
    return dropped;
  }

  delete(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.bytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    return true;
  }

  deletePrefix(prefix: string): void {
    for (const key of this.items.keys()) if (key.startsWith(prefix)) this.delete(key);
  }

  deleteOmitted(id: string): void {
    this.omitted.delete(id);
  }

  take(): {
    results: T[];
    omitted: OmittedPendingResults[];
    unlistedOmittedReplies: number;
  } {
    const results = [...this.items.values()].map((item) => structuredClone(item));
    const omitted = [...this.omitted.values()];
    const unlistedOmittedReplies = this.unlistedOmittedReplies;
    this.clear();
    return { results, omitted, unlistedOmittedReplies };
  }

  clear(): void {
    this.items.clear();
    this.sizes.clear();
    this.omitted.clear();
    this.bytes = 0;
    this.unlistedOmittedReplies = 0;
  }

  private recordOmitted(item: T): void {
    const range = this.omitted.get(item.id);
    if (range) {
      range.firstSequence = Math.min(range.firstSequence, item.sequence);
      range.lastSequence = Math.max(range.lastSequence, item.sequence);
      range.count++;
    } else if (this.omitted.size < MAX_PENDING_GAP_SUMMARIES) {
      this.omitted.set(item.id, {
        id: item.id,
        agent: item.agent.slice(0, 128),
        firstSequence: item.sequence,
        lastSequence: item.sequence,
        count: 1,
      });
    } else {
      this.unlistedOmittedReplies = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.unlistedOmittedReplies + 1,
      );
    }
  }
}
