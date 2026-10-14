import { matches, parseBash, validateMatch } from "./matcher.ts";
import type { Match, Rule } from "./types.ts";

export interface PermissionPolicy {
  mode: "off" | "manual" | "auto";
  deny: Rule[];
  allow: Rule[];
  classifier: { model: string; timeoutSec: number };
}

function object(
  value: unknown,
  allowed: string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${name}: expected object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw Error(`${name}: unknown key ${key}`);
}

export function permissionPolicy(value: unknown): PermissionPolicy {
  object(value, ["mode", "deny", "allow", "classifier"], "permissions");
  if (!["off", "manual", "auto"].includes(value.mode as string))
    throw Error("permissions.mode: expected off, manual or auto");
  const ruleList = (raw: unknown, family: string): Rule[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw Error(`${family}: expected array`);
    return raw.map((item, index) => {
      const name = `${family}[${index}]`;
      object(item, ["id", "tool", "match"], name);
      if (typeof item.tool !== "string" || !/^(?:\*|[a-zA-Z0-9_.:-]+)$/.test(item.tool))
        throw Error(`${name}.tool: invalid`);
      if (
        item.id !== undefined &&
        (typeof item.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(item.id))
      )
        throw Error(`${name}.id: invalid`);
      if (item.match !== undefined) {
        if (item.tool !== "bash") throw Error(`${name}.match: only bash supports command matching`);
        validateMatch(item.match);
        if ((item.match as Match).paths !== undefined)
          throw Error(`${name}.match.paths: permission rules do not define filesystem scope`);
      }
      return structuredClone(item) as unknown as Rule;
    });
  };
  const classifier = value.classifier ?? {};
  object(classifier, ["model", "timeoutSec"], "classifier");
  const model = classifier.model ?? "openai-codex/gpt-6-luna";
  const timeoutSec = classifier.timeoutSec ?? 15;
  if (typeof model !== "string" || !model.trim()) throw Error("classifier.model: expected model");
  if (
    typeof timeoutSec !== "number" ||
    !Number.isFinite(timeoutSec) ||
    timeoutSec <= 0 ||
    timeoutSec > 120
  )
    throw Error("classifier.timeoutSec: expected 0 < seconds <= 120");
  return {
    mode: value.mode as PermissionPolicy["mode"],
    deny: ruleList(value.deny, "deny"),
    allow: ruleList(value.allow, "allow"),
    classifier: { model, timeoutSec },
  };
}

export function permissionRule(
  tool: string,
  input: Record<string, unknown>,
  policy: PermissionPolicy,
): { verdict: "allow" | "deny" | "ask"; reason: string } {
  if (policy.mode === "off")
    return { verdict: "allow", reason: "permission checks disabled explicitly" };
  const applies = (rule: Rule) => rule.tool === tool || rule.tool === "*";
  const parsed = tool === "bash" ? parseBash(input.command) : undefined;
  for (const [index, rule] of policy.deny.entries()) {
    if (
      applies(rule) &&
      (!rule.match ||
        !Object.keys(rule.match).length ||
        parsed?.stages.some((stage) => matches(rule, stage, true)))
    )
      return { verdict: "deny", reason: `deny rule ${rule.id ?? `deny[${index}]`}` };
  }
  const allowed = policy.allow.filter(applies);
  if (
    parsed?.opaque &&
    policy.deny.some((rule) => rule.tool === "bash" && rule.match && Object.keys(rule.match).length)
  )
    return { verdict: "ask", reason: `cannot establish command deny rules: ${parsed.reason}` };
  if (allowed.some((rule) => !rule.match || !Object.keys(rule.match).length))
    return { verdict: "allow", reason: "allow rule" };
  // The existing parser inspects nested commands for denies; only closed literal commands can auto-allow.
  if (
    parsed &&
    !parsed.opaque &&
    !parsed.writes &&
    parsed.stages.every((stage) => allowed.some((rule) => matches(rule, stage, false)))
  )
    return { verdict: "allow", reason: "every command matched an allow rule" };
  return {
    verdict: "ask",
    reason: parsed?.opaque ? parsed.reason : "no allow rule matched the complete action",
  };
}
