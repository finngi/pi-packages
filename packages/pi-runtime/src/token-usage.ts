/** Provider token categories, excluding delegated usage forwarded on tool results. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!keys.every((key) => Number.isSafeInteger(candidate[key]) && (candidate[key] as number) >= 0))
    return;
  return Object.fromEntries(keys.map((key) => [key, candidate[key]])) as unknown as TokenUsage;
}
export function addTokenUsage(first: TokenUsage, second: TokenUsage): TokenUsage | undefined {
  return readTokenUsage({
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
  });
}
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
