import type { Policy, Rule } from "./types.ts";

/** Labels are diagnostics; an unnamed rule is identified by its position, never mutated. */
export function ruleLabel(policy: Policy, family: "allow" | "deny", rule: Rule): string {
  return rule.id ?? `${family}[${policy[family].indexOf(rule)}]`;
}
