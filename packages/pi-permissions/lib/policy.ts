export type Mode = "off" | "ask" | "auto";
export const MODES: readonly Mode[] = ["off", "ask", "auto"];

export interface PermissionSettings {
  mode: Mode;
  /** `provider/id` or bare id of a classifier or chat model. Required for auto mode. */
  model?: string;
  timeoutSec: number;
  allow: string[];
  deny: string[];
}

export interface Decision {
  verdict: "allow" | "deny" | "ask";
  reason: string;
}

export const DEFAULT_ALLOW = ["read", "grep", "find", "ls"];
export const DEFAULT_SETTINGS: PermissionSettings = {
  mode: "ask",
  timeoutSec: 15,
  allow: DEFAULT_ALLOW,
  deny: [],
};

const RULE = /^[a-zA-Z0-9_.-]+(?::\S.*)?$/;
// Any of these means the command is more than one plain program invocation.
const SHELL_SYNTAX = /[;&|`$<>\n\r]/;

/** Validate the `permissions` key from Pi's personal settings. */
export function readSettings(raw: unknown): PermissionSettings {
  if (raw === undefined) return DEFAULT_SETTINGS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("permissions: expected an object");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!["mode", "model", "timeoutSec", "allow", "deny"].includes(key))
      throw Error(`permissions: unknown key ${key}`);
  const mode = value.mode ?? DEFAULT_SETTINGS.mode;
  if (!MODES.includes(mode as Mode)) throw Error("permissions.mode: expected off, ask or auto");
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim()))
    throw Error("permissions.model: expected a model name");
  const timeoutSec = value.timeoutSec ?? DEFAULT_SETTINGS.timeoutSec;
  if (typeof timeoutSec !== "number" || !(timeoutSec > 0 && timeoutSec <= 120))
    throw Error("permissions.timeoutSec: expected 0 < seconds <= 120");
  const rules = (key: "allow" | "deny", fallback: string[]) => {
    const list = value[key] ?? fallback;
    if (!Array.isArray(list)) throw Error(`permissions.${key}: expected a list`);
    for (const rule of list)
      if (typeof rule !== "string" || !RULE.test(rule))
        throw Error(`permissions.${key}: "${String(rule)}" is not "tool" or "bash:prefix"`);
    // Only Bash commands have a prefix to match; any other prefixed rule would never apply.
    for (const rule of list as string[])
      if (parseRule(rule).prefix !== undefined && parseRule(rule).tool !== "bash")
        throw Error(`permissions.${key}: "${rule}" has a prefix, but only bash rules can`);
    return list as string[];
  };
  return {
    mode: mode as Mode,
    ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
    timeoutSec,
    allow: rules("allow", DEFAULT_ALLOW),
    deny: rules("deny", []),
  };
}

function parseRule(rule: string) {
  const split = rule.indexOf(":");
  return split < 0
    ? { tool: rule, prefix: undefined }
    : { tool: rule.slice(0, split), prefix: rule.slice(split + 1).trim() };
}

// Bash splits words on any run of spaces or tabs, so compare with whitespace collapsed.
const words = (text: string) => text.trim().replace(/\s+/g, " ");
const startsWith = (command: string, prefix: string) => {
  const [a, b] = [words(command), words(prefix)];
  return a === b || a.startsWith(`${b} `);
};

/** A single program invocation with no operators, redirects or substitutions. */
export function plainCommand(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  return trimmed && !SHELL_SYNTAX.test(trimmed) ? trimmed : undefined;
}

/** The rule "Allow for this session" would add, if the call can be described by one. */
export function sessionRule(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== "bash") return tool;
  const program = plainCommand(input.command)?.split(/\s+/)[0];
  return program ? `bash:${program}` : undefined;
}

/** Apply deny rules, then allow rules. Anything unmatched is left to the mode. */
export function decide(
  tool: string,
  input: Record<string, unknown>,
  settings: Pick<PermissionSettings, "allow" | "deny">,
): Decision {
  const command = tool === "bash" && typeof input.command === "string" ? input.command.trim() : "";
  // Deny prefixes are checked against each command in a simple chain. They guard against
  // mistakes rather than confine anything: a script can always hide a program name.
  const segments = command
    .split(/&&|\|\||[;&|\n]/)
    .map((part) => part.trim().replace(/^[({\s]+/, ""))
    .filter(Boolean);
  for (const rule of settings.deny) {
    const { tool: name, prefix } = parseRule(rule);
    if (name !== tool) continue;
    if (prefix === undefined || segments.some((segment) => startsWith(segment, prefix)))
      return { verdict: "deny", reason: `denied by rule "${rule}"` };
  }
  const plain = tool === "bash" ? plainCommand(command) : undefined;
  for (const rule of settings.allow) {
    const { tool: name, prefix } = parseRule(rule);
    if (name !== tool) continue;
    if (prefix === undefined || (plain && startsWith(plain, prefix)))
      return { verdict: "allow", reason: `allowed by rule "${rule}"` };
  }
  return { verdict: "ask", reason: "no rule matched" };
}
