import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_LAUNCH_CONTRIBUTIONS,
  type ChildLaunchContributionRequest,
  USAGE_EVENT,
} from "pi-contracts";
import { installAccounting } from "pi-runtime/accounting";
import { classify } from "../lib/classifier.ts";
import {
  assistantDecisionBeforeTool,
  newestUserMessages,
  recentUserMessages,
} from "../lib/classifier-context.ts";
import {
  DEFAULT_SETTINGS,
  decide,
  MODES,
  type Mode,
  type PermissionSettings,
  readSettings,
  sessionRule,
} from "../lib/policy.ts";

const MODE_ENTRY = "pi-permissions.mode";
const CHILD_ENV = "PI_CHILD_EXTENSION_PERMISSIONS";
// Linux rejects a single environment string over 128 KiB, so the child gets what the
// classifier can show rather than the whole conversation.
const CHILD_ENV_BYTES = 96 * 1024;

/** Checks each tool call against rules, then asks the user or a classifier model. */
export default function permissions(pi: ExtensionAPI) {
  installAccounting(pi);
  const childSession = process.env.PI_SUBAGENT === "1";
  let settings: PermissionSettings = DEFAULT_SETTINGS;
  let mode: Mode = DEFAULT_SETTINGS.mode;
  let sessionAllow: string[] = [];
  let rootUserMessages: string[] | undefined;
  let rootMessagesOmitted = false;
  // Bumped on every user message so an approval in flight cannot outlive a change of mind.
  let epoch = 0;
  let prompts: Promise<unknown> = Promise.resolve();

  const showMode = (ctx: ExtensionContext) =>
    ctx.ui.setStatus?.("pi-permissions", `permissions: ${mode}`);
  const block = (reason: string) => ({ block: true as const, reason: `pi-permissions: ${reason}` });

  pi.on("session_start", async (_event, ctx) => {
    epoch++;
    sessionAllow = [];
    rootUserMessages = undefined;
    rootMessagesOmitted = false;
    const inherited = childSession ? process.env[CHILD_ENV] : undefined;
    try {
      if (inherited) {
        const value = JSON.parse(inherited);
        settings = readSettings(value.settings);
        rootUserMessages = Array.isArray(value.userMessages)
          ? value.userMessages.filter((text: unknown) => typeof text === "string")
          : [];
        rootMessagesOmitted = value.userMessagesOmitted === true;
      } else {
        const global = SettingsManager.create(ctx.cwd, getAgentDir()).getGlobalSettings();
        settings = readSettings((global as { permissions?: unknown }).permissions);
      }
    } catch (error) {
      settings = DEFAULT_SETTINGS;
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`pi-permissions: ${message}; using ask mode`, "warning");
    }
    mode = settings.mode;
    // A mode chosen with /permissions earlier in this session survives resume.
    for (const entry of ctx.sessionManager.getBranch() as any[])
      if (
        entry?.type === "custom" &&
        entry.customType === MODE_ENTRY &&
        MODES.includes(entry.data?.mode)
      )
        mode = entry.data.mode;
    if (mode === "auto" && !settings.model && ctx.hasUI)
      ctx.ui.notify(
        "pi-permissions: auto mode needs permissions.model; unsure calls will ask",
        "warning",
      );
    showMode(ctx);
  });

  pi.on("input", () => {
    epoch++;
  });

  pi.registerCommand("permissions", {
    description: "Show or set how tool calls are approved: off, ask or auto",
    async handler(args, ctx) {
      const requested = args.trim();
      if (!requested) {
        const lines = [
          `Mode: ${mode}${mode === "auto" ? ` (${settings.model ?? "no model configured"})` : ""}`,
          `Allow: ${[...settings.allow, ...sessionAllow].join(", ") || "none"}`,
          `Deny: ${settings.deny.join(", ") || "none"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (!MODES.includes(requested as Mode)) {
        ctx.ui.notify("Usage: /permissions [off|ask|auto]", "warning");
        return;
      }
      mode = requested as Mode;
      pi.appendEntry(MODE_ENTRY, { mode });
      showMode(ctx);
      ctx.ui.notify(`Permissions: ${mode} for this session`, "info");
    },
  });

  pi.events.on(CHILD_LAUNCH_CONTRIBUTIONS, (value) => {
    const request = value as ChildLaunchContributionRequest;
    if (request?.version !== 1) return;
    const all = rootUserMessages ?? recentUserMessages(request.ctx.sessionManager.getBranch());
    let { kept, omitted } = newestUserMessages(all);
    const encode = () =>
      JSON.stringify({
        settings: { ...settings, mode, allow: [...settings.allow, ...sessionAllow] },
        userMessages: kept,
        userMessagesOmitted: omitted || rootMessagesOmitted,
      });
    let env = encode();
    // JSON escaping can still grow the text, so drop the oldest messages until it fits.
    while (Buffer.byteLength(env) > CHILD_ENV_BYTES && kept.length) {
      kept = kept.slice(1);
      omitted = true;
      env = encode();
    }
    request.contribute({ extension: fileURLToPath(import.meta.url), env: { [CHILD_ENV]: env } });
  });

  const askUser = (
    ctx: ExtensionContext,
    toolName: string,
    input: Record<string, unknown>,
    note: string,
  ) => {
    const started = epoch;
    const run = async () => {
      if (started !== epoch) return block("a new user message arrived; retry the call");
      const rule = sessionRule(toolName, input);
      const always =
        rule &&
        `Allow ${rule.startsWith("bash:") ? `"${rule.slice(5)}" commands` : toolName} for this session`;
      const detail = toolName === "bash" ? String(input.command) : JSON.stringify(input, null, 2);
      const answer = await ctx.ui.select(
        `${note ? `${note}\n\n` : ""}Allow ${toolName}?\n${detail}`,
        ["Allow once", ...(always ? [always] : []), "Deny"],
        { signal: ctx.signal },
      );
      if (started !== epoch) return block("a new user message arrived; retry the call");
      if (answer === always && rule) {
        sessionAllow.push(rule);
        return undefined;
      }
      return answer === "Allow once" ? undefined : block("the user denied this call");
    };
    // One dialog at a time when the model makes parallel calls.
    const result = prompts.then(run).catch(() => block("the approval prompt failed"));
    prompts = result.catch(() => undefined);
    return result;
  };

  const classifierModel = (ctx: ExtensionContext) => {
    const wanted = settings.model;
    if (!wanted) return undefined;
    const matches = (model: { id: string; provider: string }) =>
      model.id === wanted || `${model.provider}/${model.id}` === wanted;
    const native = ctx.modelRegistry.getModelsOfType("classifier").find(matches);
    if (native) return { model: native, native: true };
    const chat = ctx.modelRegistry.getAll().find(matches);
    return chat ? { model: chat, native: false } : undefined;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "off") return;
    const input = event.input as Record<string, unknown>;
    const rules = decide(event.toolName, input, {
      allow: [...settings.allow, ...sessionAllow],
      deny: settings.deny,
    });
    if (rules.verdict === "deny") return block(rules.reason);
    if (rules.verdict === "allow") return;

    const fallBack = (note: string) =>
      ctx.hasUI
        ? askUser(ctx, event.toolName, input, note)
        : block(`${note}; no one is available to ask`);
    if (mode === "ask") return fallBack("");

    const found = classifierModel(ctx);
    if (!found)
      return fallBack(`Classifier model ${settings.model ?? "(not configured)"} is unavailable`);
    const started = epoch;
    const entries = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const receiptId = `${sessionId}:classifier:${randomUUID()}`;
    const result = await classify(
      {
        tool: event.toolName,
        input,
        cwd: ctx.cwd,
        userMessages: rootUserMessages ?? recentUserMessages(entries),
        earlierUserMessagesOmitted: rootMessagesOmitted,
        ...(childSession ? { childTask: recentUserMessages(entries).join("\n\n") } : {}),
        assistantDecision: assistantDecisionBeforeTool(entries, event),
      },
      {
        ...found,
        client: ctx.modelRegistry,
        timeoutSec: settings.timeoutSec,
        signal: ctx.signal,
        onUsage: (usage?: Usage) =>
          pi.events.emit(USAGE_EVENT, {
            id: receiptId,
            ownerSessionId: sessionId,
            kind: "classifier",
            source: sessionId,
            label: settings.model,
            model: settings.model,
            usage,
          }),
      },
    );
    if (started !== epoch) return block("a new user message arrived; retry the call");
    if (result.verdict === "allow") return;
    if (result.verdict === "deny")
      return block(`the classifier blocked this call${result.reason ? `: ${result.reason}` : ""}`);
    return fallBack(`The classifier was unsure${result.reason ? `: ${result.reason}` : ""}`);
  });
}
