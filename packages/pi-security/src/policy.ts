import type { Policy, Rule, LoadedPolicy, FilesystemScope, HostCapability } from "./types.ts";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalizeHost } from "./fetch-proxy.ts";
import { validateMatch } from "./matcher.ts";
import { assertHostCapabilities } from "./host-capabilities.ts";
import { MAX_NODE_TIMER_DELAY_MS } from "pi-runtime";

function keys(
  value: unknown,
  allowed: readonly string[],
  where: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${where}: expected object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw Error(`${where}: unknown key ${key}`);
}
function strings(value: unknown, where: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item || /[\x00-\x1f\x7f]/.test(item))
  )
    throw Error(`${where}: expected safe strings`);
}
const timeout = (value: unknown, fallback: number, where: string): number => {
  const result = value ?? fallback;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result <= 0 ||
    result * 1000 > MAX_NODE_TIMER_DELAY_MS
  )
    throw Error(`${where}: invalid`);
  return result;
};
function validateRule(value: Rule, where: string, allow: boolean) {
  keys(value, allow ? ["id", "tool", "match", "permissions"] : ["id", "tool", "match"], where);
  if (
    value.id !== undefined &&
    (typeof value.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value.id))
  )
    throw Error(`${where}: invalid id`);
  if (typeof value.tool !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(value.tool))
    throw Error(`${where}: unsupported tool`);
  if (value.match !== undefined) {
    if (value.tool === "bash") validateMatch(value.match);
    else if (["read", "write", "edit", "ls", "find", "grep"].includes(value.tool)) {
      keys(value.match, ["paths"], `${where}.match`);
      if (
        value.match.paths !== undefined &&
        !["read", "write"].includes(value.match.paths as string)
      )
        throw Error("invalid file match");
    } else throw Error("generic tools do not support match");
  }
  if (value.permissions !== undefined) {
    keys(value.permissions, ["write", "network"], `${where}.permissions`);
    if (value.permissions.write !== undefined && typeof value.permissions.write !== "boolean")
      throw Error("permissions.write: expected boolean");
    if (value.permissions.network !== undefined) {
      strings(value.permissions.network, "permissions.network");
      value.permissions.network = value.permissions.network.map(canonicalizeHost);
    }
  }
}
export function validatePolicy(value: unknown): Policy {
  const p = structuredClone(value) as Policy;
  keys(
    p,
    ["version", "mode", "resources", "classifier", "approvalTimeoutSec", "env", "deny", "allow"],
    "policy",
  );
  if (p.version !== 2) throw Error("version: expected 2");
  if (!["auto", "manual"].includes(p.mode)) throw Error("mode: invalid");
  if (p.resources === undefined) p.resources = {} as Policy["resources"];
  keys(p.resources, ["write", "denyRead", "denyWrite", "network"], "resources");
  if (p.resources.write === undefined) p.resources.write = ["${project}", "${tmp}"];
  if (p.resources.denyRead === undefined) p.resources.denyRead = [];
  if (p.resources.denyWrite === undefined) p.resources.denyWrite = [];
  if (p.resources.network === undefined) p.resources.network = [];
  for (const field of ["write", "denyRead", "denyWrite", "network"] as const)
    strings(p.resources[field], `resources.${field}`);
  p.resources.network = p.resources.network.map((host) =>
    host === "*" ? host : canonicalizeHost(host),
  );
  if (p.classifier === undefined) p.classifier = { model: "none", timeoutSec: 15 };
  keys(p.classifier, ["model", "timeoutSec"], "classifier");
  if (typeof p.classifier.model !== "string" || !p.classifier.model)
    throw Error("classifier.model: expected model");
  p.classifier.timeoutSec = timeout(p.classifier.timeoutSec, 15, "classifier.timeoutSec");
  p.approvalTimeoutSec = timeout(p.approvalTimeoutSec, 120, "approvalTimeoutSec");
  if (p.env === undefined) p.env = {} as Policy["env"];
  keys(p.env, ["path", "assignAllow"], "env");
  if (p.env.path === undefined) p.env.path = [];
  if (p.env.assignAllow === undefined) p.env.assignAllow = [];
  strings(p.env.path, "env.path");
  strings(p.env.assignAllow, "env.assignAllow");
  if (p.deny === undefined) p.deny = [];
  if (p.allow === undefined) p.allow = [];
  for (const field of ["deny", "allow"] as const) {
    if (!Array.isArray(p[field])) throw Error(`${field}: expected array`);
    p[field].forEach((item, index) => {
      validateRule(item, `${field}[${index}]`, field === "allow");
    });
  }
  const ids = [...p.deny, ...p.allow].flatMap((rule) => (rule.id === undefined ? [] : [rule.id]));
  if (new Set(ids).size !== ids.length) throw Error("duplicate rule id");
  return p;
}
export async function loadPolicy(
  file: string,
  {
    project,
    tmp,
    capabilities = [],
  }: { project: string; tmp: string; capabilities?: HostCapability[] },
): Promise<LoadedPolicy> {
  const raw = await readFile(file);
  const policy = validatePolicy(JSON.parse(raw.toString("utf8")));
  assertHostCapabilities(capabilities);
  const root = await realpath(project),
    temp = await realpath(tmp);
  const agent = path.resolve(
    process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME!, ".pi", "agent"),
  );
  const expand = (entry: string) => {
    for (const [token, base] of [
      ["${agent}", agent],
      ["${project}", root],
      ["${tmp}", temp],
    ] as const) {
      if (entry === token) return base;
      if (entry.startsWith(token + "/")) return path.join(base, entry.slice(token.length + 1));
    }
    if (entry.startsWith("~/")) return path.join(process.env.HOME!, entry.slice(2));
    if (path.isAbsolute(entry)) return path.resolve(entry);
    throw Error(`invalid resource path: ${entry}`);
  };
  const filesystem: FilesystemScope = {
    writeAllow: policy.resources.write.map(expand),
    readDeny: policy.resources.denyRead.map(expand),
    writeDeny: policy.resources.denyWrite.map(expand),
  };
  return {
    policy,
    filesystem,
    project: root,
    tmp: temp,
    capabilities: [...capabilities],
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}
export function materializeFilesystem(policy: Policy, filesystem: FilesystemScope): void {
  policy.resources.write = [...filesystem.writeAllow];
  policy.resources.denyRead = [...filesystem.readDeny];
  policy.resources.denyWrite = [...filesystem.writeDeny];
}
