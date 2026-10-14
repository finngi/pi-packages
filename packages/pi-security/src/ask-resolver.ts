import { MAX_CLASSIFIER_BYTES } from "./classifier-context.ts";
import type {
  AskContext,
  AskResolverOptions,
  Classification,
  ClassifierView,
  Decision,
  ToolCall,
} from "./types.ts";

export const escapeDisplay = (value: unknown) =>
  String(value).replace(
    /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const deny = (decision: Decision, reason: string): Decision => ({
  verdict: "deny",
  ruleIds: decision.ruleIds || [],
  reason,
});
const valid = (value: Classification | undefined): value is Classification =>
  !!value &&
  ["allow", "deny", "unsure"].includes(value.verdict) &&
  typeof value.reasonCode === "string" &&
  Array.isArray(value.labels) &&
  value.labels.every((x) =>
    [
      "read.project",
      "exec.project-code",
      "net.fetch",
      "vcs.publish",
      "persist.config",
      "destroy.data",
    ].includes(x),
  );
export function createAskResolver({ policy, classify, authority }: AskResolverOptions) {
  let closed = false,
    uiFailed = false,
    queue: Promise<unknown> = Promise.resolve(),
    active: AbortController | undefined;
  let authorityEpoch = 0;
  const cache = new Map<string, Promise<Classification>>();
  const resolved = (decision: Decision, reason: string): Decision => ({
    ...decision,
    verdict: "allow",
    reason,
  });
  async function manual(call: ToolCall, decision: Decision, ctx?: AskContext): Promise<Decision> {
    const epoch = authorityEpoch;
    if (closed || uiFailed) return deny(decision, "resolver closed or UI unavailable");
    if (!ctx?.hasUI || typeof ctx.ui?.select !== "function") return deny(decision, "no UI");
    const choices = ["Allow", "Deny"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    active = new AbortController();
    try {
      const agent = call.agentName
        ? `Approval requested by ${call.agentName.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} agent\n`
        : "";
      const title = escapeDisplay(
        `${agent}${call.toolName} ${JSON.stringify(call.input)}${decision.writeGrants?.length ? "\nRequested write scope: " + JSON.stringify(decision.writeGrants.map(({ path, kind, createParents }) => ({ path, kind, createParents }))) : ""}\nPermissions: ${JSON.stringify(decision.permissions)}; rules ${(decision.ruleIds || []).join(",")}; ${decision.reason}`,
      );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          uiFailed = true;
          active?.abort();
          reject(Error("human timeout"));
        }, policy.approvalTimeoutSec * 1000);
      });
      const cancel = new Promise<never>((_, reject) =>
        active!.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }),
      );
      const answer = await Promise.race([
        ctx.ui.select(title, choices, {
          signal: active!.signal,
          timeout: policy.approvalTimeoutSec * 1000,
        }),
        timeout,
        cancel,
      ]);
      if (epoch !== authorityEpoch)
        return deny(decision, "user instructions changed during approval");
      if (closed || answer === undefined || !choices.includes(answer) || answer === "Deny")
        return deny(decision, "human denied or cancelled");
      return resolved(decision, "human approved");
    } catch {
      if (epoch !== authorityEpoch)
        return deny(decision, "user instructions changed during approval");
      uiFailed = true;
      return deny(decision, "human timeout or UI error");
    } finally {
      clearTimeout(timer);
      active = undefined;
    }
  }
  return {
    async resolve(call: ToolCall, decision: Decision, ctx?: AskContext): Promise<Decision> {
      const epoch = authorityEpoch;
      if (decision.verdict !== "ask") return decision;
      if (closed) return deny(decision, "resolver closed");
      if (policy.mode === "manual") {
        const result = queue.then(() =>
          epoch === authorityEpoch
            ? manual(call, decision, ctx)
            : deny(decision, "user instructions changed before approval"),
        );
        queue = result.catch(() => undefined);
        return result;
      }
      if (policy.mode !== "auto") return deny(decision, "invalid mode");
      try {
        const a = authority(call);
        const view: ClassifierView = {
          tool: call.toolName,
          input: call.input,
          cwd: call.cwd,
          permissions: decision.permissions!,
          ...(decision.writeGrants?.length
            ? {
                writeGrants: decision.writeGrants.map(({ path, kind, createParents }) => ({
                  path,
                  kind,
                  createParents,
                })),
              }
            : {}),
          depth: a.depth,
          userMessages: a.userMessages || [],
          ...(a.childTask === undefined ? {} : { childTask: a.childTask }),
          ...(a.assistantDecision === undefined ? {} : { assistantDecision: a.assistantDecision }),
        };
        const key = JSON.stringify(view);
        if (Buffer.byteLength(key) > MAX_CLASSIFIER_BYTES)
          return deny(decision, "classifier oversize");
        if (!cache.has(key))
          cache.set(
            key,
            (async () => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  Promise.resolve().then(() => classify!(view, policy.classifier)),
                  new Promise<Classification>((resolve) => {
                    timer = setTimeout(
                      () => resolve({ verdict: "unsure", reasonCode: "timeout", labels: [] }),
                      policy.classifier.timeoutSec * 1000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            })(),
          );
        const result = await cache.get(key);
        if (epoch !== authorityEpoch)
          return deny(decision, "user instructions changed during approval");
        if (closed || !valid(result) || result.verdict !== "allow")
          return deny(
            decision,
            `classifier ${valid(result) ? result.reasonCode + (result.note ? ": " + escapeDisplay(result.note) : "") : "invalid-response"}`,
          );
        return resolved(
          decision,
          `classifier ${result.reasonCode}${result.note ? ": " + escapeDisplay(result.note) : ""}`,
        );
      } catch {
        return deny(decision, "classifier error");
      }
    },
    clearCache() {
      cache.clear();
    },
    invalidate() {
      authorityEpoch++;
      active?.abort();
      cache.clear();
    },
    close() {
      closed = true;
      active?.abort();
      cache.clear();
    },
  };
}
