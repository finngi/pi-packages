import { ruleLabel } from "./rule-label.ts";
import type { Decision, LoadedPolicy, CallInput, Rule } from "./types.ts";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalWritePath, requestedWriteGrants } from "./write-grants.ts";
import {
  localPermissions,
  normalizePermissions,
  rulePermissions,
  requestedNetwork,
  networkScopeWithin,
} from "./permissions.ts";
import { decideBash } from "./matcher.ts";

const effects = new Set(["read", "write", "edit", "ls", "find", "grep", "bash"]);
export function capDecision(decision: Decision, loaded: LoadedPolicy): Decision {
  if (decision.verdict === "deny" || !decision.permissions) return decision;
  try {
    return { ...decision, permissions: normalizePermissions(decision.permissions, loaded) };
  } catch {
    return { verdict: "deny", ruleIds: decision.ruleIds, reason: "invalid execution permissions" };
  }
}
export function decide(
  tool: string,
  input: CallInput,
  loaded?: LoadedPolicy,
  requiredNetwork: string[] = [],
): Decision {
  if (!loaded) return { verdict: "deny", reason: "policy unavailable" };
  const adapterHosts = tool === "codex_search" ? ["chatgpt.com:443"] : requiredNetwork;
  let decision = capDecision(decideUncapped(tool, input, loaded, adapterHosts), loaded);
  if (decision.verdict === "deny") return decision;
  try {
    const requested = tool === "bash" ? input.permissions : undefined;
    if (
      requested !== undefined &&
      (!requested ||
        typeof requested !== "object" ||
        Array.isArray(requested) ||
        Object.keys(requested).some((key) => !["execution", "write", "network"].includes(key)))
    )
      throw Error("invalid requested permissions");
    if (requested?.execution === "host") {
      if (
        [requested.write, requested.network].some(
          (value) => value != null && (!Array.isArray(value) || value.length > 0),
        )
      )
        throw Error(
          "Host execution uses the harness's own filesystem and network controls; request execution only, without sandbox write/network grants",
        );
      const permissions = normalizePermissions(
        { execution: "host", write: true, network: [["*"]] },
        loaded,
      );
      return {
        ...decision,
        verdict: "ask",
        permissions,
        reason: "host execution requires approval for this exact command",
      };
    }
    if (requested?.execution != null && requested.execution !== "sandbox")
      throw Error("invalid requested execution mode");
    const grants = requestedWriteGrants(tool, input, loaded);
    const requestedHosts = requestedNetwork(
      [...(requested?.network ?? []), ...adapterHosts],
      loaded,
    );
    const permission =
      decision.permissions ?? localPermissions(tool === "bash" || ["write", "edit"].includes(tool));
    const needWrite =
      grants.length > 0 ||
      ["write", "edit"].includes(tool) ||
      (tool === "bash" && (requested?.write?.length ?? 0) > 0);
    if (needWrite && loaded.limits?.write === false)
      throw Error("requested write access exceeds hard limits");
    const extraNetwork = requestedHosts.some(
      (host) =>
        !permission.network.length ||
        !permission.network.every((group) => networkScopeWithin(host, group)),
    );
    const review = grants.length > 0 || (needWrite && !permission.write) || extraNetwork;
    decision = {
      ...decision,
      permissions: {
        write: needWrite || permission.write,
        network:
          requiredNetwork.length || tool === "codex_search"
            ? [requestedHosts]
            : extraNetwork
              ? permission.network.length
                ? permission.network.map((group) => [...new Set([...group, ...requestedHosts])])
                : [requestedHosts]
              : permission.network,
      },
      ...(grants.length ? { writeGrants: grants } : {}),
    };
    return review
      ? { ...decision, verdict: "ask", reason: "requested resources require approval" }
      : decision;
  } catch (error) {
    return { verdict: "deny", ruleIds: ["resources"], reason: (error as Error).message };
  }
}
function decideUncapped(
  tool: string,
  input: CallInput,
  loaded?: LoadedPolicy,
  defaultNetwork: string[] = [],
): Decision {
  if (!loaded) return { verdict: "deny", reason: "policy unavailable" };
  if (tool === "codemode") {
    const denied = loaded.policy.deny.find((rule) => rule.tool === tool && !rule.match);
    if (denied)
      return {
        verdict: "deny",
        ruleIds: [ruleLabel(loaded.policy, "deny", denied)],
        reason: "deny rule",
      };
    const allowed = loaded.policy.allow.find((rule) => rule.tool === tool && !rule.match);
    return allowed
      ? {
          verdict: "allow",
          ruleIds: [ruleLabel(loaded.policy, "allow", allowed)],
          permissions: localPermissions(),
          reason: "codemode wrapper rule",
        }
      : { verdict: "deny", ruleIds: [], reason: "unmatched codemode wrapper" };
  }
  if (!effects.has(tool)) {
    const denied = loaded.policy.deny.find((rule) => rule.tool === tool);
    if (denied)
      return {
        verdict: "deny",
        ruleIds: [ruleLabel(loaded.policy, "deny", denied)],
        reason: "deny rule",
      };
    const allowed = loaded.policy.allow.find((rule) => rule.tool === tool);
    return allowed
      ? {
          verdict: "allow",
          ruleIds: [ruleLabel(loaded.policy, "allow", allowed)],
          permissions: rulePermissions(allowed, loaded, false, defaultNetwork),
          reason: "tool name rule",
        }
      : {
          verdict: "ask",
          ruleIds: [],
          permissions: localPermissions(),
          reason: "unmatched registered tool",
        };
  }
  if (tool === "bash") return decideBash(input?.command, loaded);
  const writing = ["write", "edit"].includes(tool);
  let target: string;
  try {
    target = canonicalWritePath(input?.path ?? ".", loaded.project);
  } catch (error) {
    return { verdict: "deny", ruleIds: ["scope"], reason: (error as Error).message };
  }
  const inside = (root: string) => {
    const r = root.endsWith("/**") ? root.slice(0, -3) : root;
    const canonical = canonicalWritePath(r, loaded.project);
    return [r, canonical].some(
      (root) => target === root || target.startsWith(root.endsWith("/") ? root : root + path.sep),
    );
  };
  const fs = loaded.filesystem;
  const temp = loaded.tempIsolation;
  const within = (root: string, value: string) =>
    value === root || value.startsWith(root.endsWith("/") ? root : root + path.sep);
  if (
    temp &&
    ((within(temp.base, target) &&
      !within(temp.own, target) &&
      !(!writing && (temp.resourceReadAllow ?? []).some((root) => within(root, target)))) ||
      (writing && within(temp.launchDir, target)))
  )
    return { verdict: "deny", ruleIds: ["temp-scope"], reason: "path outside agent temp subtree" };
  if ((writing ? fs.writeDeny : fs.readDeny).some(inside))
    return { verdict: "deny", ruleIds: ["scope"], reason: "path outside permitted scope" };
  const matches = (rule: Rule) =>
    !rule.match ||
    (Object.keys(rule.match).every((key) => key === "paths") &&
      (!rule.match.paths || rule.match.paths === (writing ? "write" : "read")));
  const deny = loaded.policy.deny.find((r) => r.tool === tool && matches(r));
  if (deny)
    return {
      verdict: "deny",
      ruleIds: [ruleLabel(loaded.policy, "deny", deny)],
      reason: "deny rule",
    };
  const allow = loaded.policy.allow.find((r) => r.tool === tool && matches(r));
  if (!allow)
    return {
      verdict: "ask",
      ruleIds: [],
      permissions: localPermissions(writing),
      reason: "unmatched file call",
    };
  return {
    verdict: "allow",
    ruleIds: [ruleLabel(loaded.policy, "allow", allow)],
    permissions: { ...rulePermissions(allow, loaded, writing), network: [] },
    reason: "file rule",
  };
}

export const inputHash = (tool: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([tool, input]))
    .digest("hex");
function freezeDecision<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDecision(child);
  }
  return value;
}
export class Bindings {
  #values = new Map<string, { sha256: string; decision: Decision; cwd?: string }>();
  put(id: string, tool: string, input: unknown, decision: Decision, cwd?: string) {
    if (this.#values.has(id)) throw Error("duplicate call id");
    this.#values.set(
      id,
      Object.freeze({
        sha256: inputHash(tool, input),
        decision: freezeDecision(structuredClone(decision)),
        ...(cwd === undefined ? {} : { cwd: realpathSync(cwd) }),
      }),
    );
  }
  take(id: string, tool: string, input: unknown, cwd?: string) {
    const binding = this.#values.get(id);
    this.#values.delete(id);
    if (!binding || binding.sha256 !== inputHash(tool, input))
      throw Error("input differs from the decided call");
    if (binding.cwd !== undefined && (cwd === undefined || realpathSync(cwd) !== binding.cwd))
      throw Error("execution directory differs from the decided call");
    return binding;
  }
  clear() {
    this.#values.clear();
  }
  delete(id: string) {
    this.#values.delete(id);
  }
}
