import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_LAUNCH_CONTRIBUTIONS,
  type ChildLaunchContributionRequest,
  HUMAN_INPUT,
  type HumanInput,
  USAGE_EVENT,
} from "pi-contracts";
import { installAccounting } from "pi-runtime/accounting";
import { classify } from "../lib/classifier.ts";
import { assistantDecisionBeforeTool, recentUserMessages } from "../lib/classifier-context.ts";
import { type PermissionPolicy, permissionPolicy, permissionRule } from "../lib/policy.ts";

/** Native tool-call gate; approved tools retain ordinary host access. */
export default function permissions(pi: ExtensionAPI) {
  installAccounting(pi);
  pi.registerFlag("permissions-policy", {
    type: "string",
    description: "Trusted permission policy JSON (default: user agent directory/permissions.json)",
  });
  let policy: PermissionPolicy | undefined;
  let context: ExtensionContext | undefined;
  let inheritedUsers: string[] | undefined;
  let failure = "not initialized";
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const childSession = process.env.PI_SUBAGENT === "1";
  const userMessages = (ctx: ExtensionContext) =>
    childSession ? (inheritedUsers ?? []) : recentUserMessages(ctx.sessionManager.getBranch());
  pi.events.on(HUMAN_INPUT, (value) => {
    const input = value as HumanInput;
    if (
      childSession ||
      input?.version !== 1 ||
      input.sessionId !== context?.sessionManager.getSessionId() ||
      typeof input.message !== "string"
    )
      return;
    epoch++;
    pi.appendEntry("pi-permissions.human-input.v1", { message: input.message });
  });
  pi.events.on(CHILD_LAUNCH_CONTRIBUTIONS, (value) => {
    const request = value as ChildLaunchContributionRequest;
    if (request?.version !== 1) return;
    if (!policy) {
      request.reject(`pi-permissions: ${failure}`);
      return;
    }
    request.contribute({
      extension: fileURLToPath(import.meta.url),
      env: {
        PI_CHILD_EXTENSION_PERMISSIONS: JSON.stringify({
          policy,
          userMessages: userMessages(request.ctx),
        }),
      },
    });
  });
  pi.on("input", () => {
    epoch++;
  });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    epoch++;
    policy = undefined;
    inheritedUsers = undefined;
    const file = pi.getFlag("permissions-policy") || path.join(getAgentDir(), "permissions.json");
    try {
      const inherited = childSession && process.env.PI_CHILD_EXTENSION_PERMISSIONS;
      if (inherited) {
        const value = JSON.parse(inherited);
        if (
          !Array.isArray(value?.userMessages) ||
          value.userMessages.some((text: unknown) => typeof text !== "string")
        )
          throw Error("inherited user messages must be strings");
        policy = permissionPolicy(value.policy);
        inheritedUsers = value.userMessages;
      } else {
        policy = permissionPolicy(JSON.parse(await readFile(String(file), "utf8")));
      }
    } catch (error) {
      failure = `cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    const deny = (reason: string) => ({
      block: true as const,
      reason: `pi-permissions: ${reason}`,
    });
    if (!policy) return deny(failure);
    const decision = permissionRule(event.toolName, event.input, policy);
    if (decision.verdict === "deny") return deny(decision.reason);
    if (decision.verdict === "allow") return;
    const startedEpoch = epoch;
    if (policy.mode === "manual") {
      if (!ctx.hasUI)
        return deny(
          "manual approval requires an approval-capable client; configure auto mode when no approval UI is available",
        );
      const approve = async () => {
        if (startedEpoch !== epoch)
          return deny("user instructions changed before approval; retry the action");
        const answer = await ctx.ui.select(
          `Allow ${event.toolName}?\n${JSON.stringify(event.input)}`,
          ["Allow once", "Deny"],
          { signal: ctx.signal },
        );
        return answer === "Allow once" && startedEpoch === epoch
          ? undefined
          : deny("approval denied, cancelled, or superseded by new user instructions");
      };
      const result = queue
        .then(approve)
        .catch(() => deny("manual approval UI failed; action blocked"));
      queue = result.catch(() => undefined);
      return result;
    }
    const registry = ctx.modelRegistry;
    const requested = policy.classifier.model;
    const matches = (model: { id: string; provider: string }) =>
      model.id === requested || `${model.provider}/${model.id}` === requested;
    const native = registry.getModelsOfType("classifier").find(matches);
    const model = native ?? registry.getAll().find(matches);
    if (!model)
      return deny(
        `classifier model ${requested} is unavailable; configure an available model or add an allow rule`,
      );
    const entries = ctx.sessionManager.getBranch();
    const users = userMessages(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const receiptId = `${sessionId}:classifier:${randomUUID()}`;
    const receipt = (usage?: import("@earendil-works/pi-ai").Usage) => {
      pi.events.emit(USAGE_EVENT, {
        id: receiptId,
        ownerSessionId: sessionId,
        kind: "classifier",
        source: sessionId,
        label: requested,
        model: requested,
        usage,
      });
    };
    const result = await classify(
      {
        tool: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
        userMessages: users,
        ...(childSession ? { childTask: recentUserMessages(entries).join("\n\n") } : {}),
        assistantDecision: assistantDecisionBeforeTool(entries, event),
      },
      {
        model,
        timeoutSec: policy.classifier.timeoutSec,
        signal: ctx.signal,
        client: native
          ? { classify: registry.classify.bind(registry) }
          : { complete: registry.complete.bind(registry) },
      },
      receipt,
    );
    if (result.reasonCode === "oversize")
      return deny(
        "classifier context exceeds 64 KiB; use manual approval or start a new session with the current request",
      );
    if (startedEpoch !== epoch)
      return deny("user instructions changed during classification; retry the action");
    if (result.verdict !== "allow")
      return deny(
        `classifier ${result.reasonCode}${result.note ? `: ${result.note}` : "; check the configured model, provider authentication, and user request"}`,
      );
  });
}
