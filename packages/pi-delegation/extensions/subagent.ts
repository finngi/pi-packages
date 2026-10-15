import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChildLaunchService, Communication } from "pi-contracts";
import {
  SESSION_SETUP_CONTRIBUTIONS,
  type SessionSetupContributionRequest,
  USAGE_EVENT,
} from "pi-contracts";
import type { ArtifactResult } from "../lib/subagent/artifacts.ts";
import { BackgroundProcesses, installAccounting, newSemanticId } from "pi-runtime";
import {
  discoverResourcePackages,
  type ResourcePackage,
  resourcePackageKeywords,
} from "pi-resources/discovery";
import { selectedSkills, resourceApplies, selectedAgents } from "pi-resources/selection";
import { resourcePickerControls } from "pi-resources/picker";
import { savedInstructionContext } from "pi-resources/instructions";
import { installSessionSetup } from "pi-resources/session-setup";
import { Type } from "typebox";
import { backgroundService } from "../lib/background/service.ts";
import {
  discover,
  discoverAgents as discoverAgentDirectory,
  projectLevels,
} from "../lib/subagent/agents.ts";
import {
  type AgentPreview,
  agentCatalogue,
  cataloguePrompt,
  publicAgentPreview,
} from "../lib/subagent/catalogue.ts";
import { launchChild, restrictionSpec } from "../lib/subagent/child-launch.ts";
import {
  messageDescription,
  messageParameters,
  registerChildMessaging,
} from "../lib/subagent/child-messaging.ts";
import { resolveContext, taskFileText, transcript } from "../lib/subagent/context.ts";
import { archiveDialogueReplies, pageDialogueResponse } from "../lib/subagent/history-page.ts";
import { newAgentId } from "../lib/subagent/identity.ts";
import {
  agentEnvelope,
  escapeXml,
  MESSAGE_BRIDGE,
  validateMessage,
} from "../lib/subagent/messages.ts";
import { ResponseOffers } from "../lib/subagent/owned-waiter.ts";
import { PendingResults } from "../lib/subagent/pending-results.ts";
import { renderSubagentReply } from "../lib/subagent/reply-renderer.ts";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
} from "../lib/subagent/resource-browser.ts";
import type { ResourceEntry } from "../lib/subagent/resource-browser.ts";
import { resolveSettings } from "../lib/subagent/settings.ts";
import { createNativeLauncher } from "../lib/subagent/native-launcher.ts";

export default function (pi: ExtensionAPI) {
  installAccounting(pi);
  let childProcesses: BackgroundProcesses | undefined;
  const stopChildProcesses = () => childProcesses?.killAll();
  const childTransport = () =>
    backgroundService(pi.events, () => {
      if (!childProcesses) {
        childProcesses = new BackgroundProcesses();
        process.once("exit", stopChildProcesses);
      }
      return childProcesses;
    });
  if (process.env.PI_SUBAGENT === "1") {
    const bound = JSON.parse(process.env.PI_SUBAGENT_CONTEXT ?? "null") as
      | (Communication & { workspace: string })
      | null;
    if (!bound) throw Error("Missing child communication binding");
    registerChildMessaging(pi, bound);
    return;
  }
  const setup = installSessionSetup(pi);
  let packageResources: { packs: ResourcePackage[]; problems: string[] } = {
    packs: [],
    problems: [],
  };
  let agentPathsSnapshot: Map<string, string> | undefined;
  pi.registerMessageRenderer("subagent-dialogue-reply", renderSubagentReply);
  pi.registerMessageRenderer("agent-message", renderSubagentReply);
  let generation = 0,
    closed = true;
  type ChildWorker = Awaited<ReturnType<typeof launchChild>>;
  type ChildSnapshot = ReturnType<ChildWorker["dialogue"]["snapshot"]>;
  interface ArtifactView {
    id: string;
    directory: string;
    files: string[];
    omitted: string[];
    owned: boolean;
    scope: ArtifactResult["scope"];
    externalEffects: ArtifactResult["externalEffects"];
    fileCount: number;
    omittedCount: number;
    moreFiles: number;
    moreOmitted: number;
    truncatedPaths: number;
    discarded?: boolean;
  }
  interface ClosedHistory {
    id: string;
    workerId: string;
    agent: string;
    closedAt: number;
    expiresAt: number;
    snapshot: ChildSnapshot;
    artifacts?: ArtifactView;
    bytes: number;
  }
  const CLOSED_HISTORY_TTL_MS = 30 * 60 * 1000;
  const CLOSED_HISTORY_MAX_ENTRIES = 4;
  const CLOSED_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
  const closedHistories = new Map<string, ClosedHistory>();
  const workers = new Map<string, ChildWorker>();
  const offers = new ResponseOffers((name, value) => pi.events.emit(name, value));
  const sessionTrust = new Set<string>();
  const publicIds = new Map<string, string>();
  const names = new Map<string, string>();
  const pending = new PendingResults<any>((item) =>
    Buffer.byteLength(
      agentEnvelope("result", item.id, item.text, {
        sequence: item.sequence,
        requestIds: item.requestIds,
        truncated: item.truncated === true,
      }),
      "utf8",
    ),
  );
  const pendingReadOffsets = new Map<string, number>();
  const previews = new Map<string, AgentPreview>();
  let parentId = "",
    parentContext: ExtensionContext | undefined,
    parentCanWake = true,
    agentSelectionSnapshot: { names?: Set<string>; error?: string } | undefined;
  const previewDiagnostics = new Map<string, string>();
  const errorText = (error: unknown) => {
    try {
      const message = error instanceof Error ? error.message : String(error);
      return typeof message === "string" ? message : String(message);
    } catch {
      return "Child operation failed with an unreadable error";
    }
  };
  const artifactView = (artifacts: ArtifactResult | undefined): ArtifactView | undefined => {
    if (!artifacts) return undefined;
    const previewPaths = (paths: string[]) =>
      paths.slice(0, 8).map((path) => Array.from(path).slice(0, 128).join(""));
    const files = previewPaths(artifacts.files);
    const omitted = previewPaths(artifacts.omitted);
    return {
      id: artifacts.id,
      directory: artifacts.directory,
      files,
      omitted,
      owned: artifacts.owned,
      scope: artifacts.scope,
      externalEffects: artifacts.externalEffects,
      fileCount: artifacts.files.length,
      omittedCount: artifacts.omitted.length,
      moreFiles: Math.max(0, artifacts.files.length - files.length),
      moreOmitted: Math.max(0, artifacts.omitted.length - omitted.length),
      truncatedPaths:
        artifacts.files.slice(0, 8).filter((path) => Array.from(path).length > 128).length +
        artifacts.omitted.slice(0, 8).filter((path) => Array.from(path).length > 128).length,
    };
  };
  const compactSnapshot = (snapshot: ChildSnapshot): ChildSnapshot => ({
    ...snapshot,
    failure: snapshot.failure?.slice(0, 512),
    failureRequestIds: snapshot.failureRequestIds.slice(0, 8).map((id) => id.slice(0, 64)),
  });
  const pruneClosedHistories = (now = Date.now()) => {
    for (const [id, history] of closedHistories)
      if (history.expiresAt <= now) closedHistories.delete(id);
    const totalBytes = () =>
      [...closedHistories.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (
      closedHistories.size > CLOSED_HISTORY_MAX_ENTRIES ||
      totalBytes() > CLOSED_HISTORY_MAX_BYTES
    ) {
      const oldest = closedHistories.keys().next().value as string | undefined;
      if (!oldest) break;
      closedHistories.delete(oldest);
    }
  };
  const rememberClosedHistory = (
    worker: ChildWorker,
    snapshot: ChildSnapshot,
    artifacts: ArtifactResult | undefined,
  ) => {
    const identity = actor(worker);
    const archived = archiveDialogueReplies(compactSnapshot(snapshot));
    const now = Date.now();
    const artifactSummary = artifactView(artifacts);
    const history: ClosedHistory = {
      id: identity.id,
      workerId: worker.id,
      agent: identity.name,
      closedAt: now,
      expiresAt: now + CLOSED_HISTORY_TTL_MS,
      snapshot: archived,
      ...(artifactSummary ? { artifacts: artifactSummary } : {}),
      bytes: 0,
    };
    history.bytes = Buffer.byteLength(JSON.stringify(history), "utf8");
    closedHistories.delete(history.id);
    closedHistories.set(history.id, history);
    pruneClosedHistories();
    const retained = closedHistories.get(history.id);
    if (!retained)
      throw new Error("Closed agent reply history exceeded the session retention limit");
    return retained;
  };
  const historySummary = (history: ClosedHistory | undefined, snapshot: ChildSnapshot) => ({
    available: history !== undefined,
    closedAt: history ? new Date(history.closedAt).toISOString() : null,
    expiresAt: history ? new Date(history.expiresAt).toISOString() : null,
    retainedFrom: snapshot.retainedFrom,
    lostReplies: snapshot.lostReplies,
    replyCursor: snapshot.replyCursor,
  });
  const closedHistoryFor = (id: string) => {
    pruneClosedHistories();
    return closedHistories.get(id);
  };
  let parentPromptOptions:
    | {
        cwd: string;
        contextFiles?: Array<{ path: string; content: string }>;
      }
    | undefined;
  const parentStaticContext = (ctx: ExtensionContext) => {
    if (!parentPromptOptions) return undefined;
    const instructions = savedInstructionContext(pi.events, ctx);
    return {
      originalCwd: parentPromptOptions.cwd,
      files: (parentPromptOptions.contextFiles ?? []).map(({ path, content }) => ({
        path,
        content,
      })),
      ...(instructions === undefined ? {} : { instructions }),
    };
  };
  const nativeLauncher = createNativeLauncher(
    pi,
    () => {
      if (!parentContext) throw Error("Parent context unavailable");
      return parentContext;
    },
    fileURLToPath(import.meta.url),
  );
  const launcher = (): ChildLaunchService => nativeLauncher;
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    pi.appendEntry("pi-subagents.event.v1", { version: 1, type, ...fields });
  const identify = (ctx: ExtensionContext) => {
    parentContext = ctx;
    if (parentId) return;
    const saved = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-subagents.identity.v1")
      .at(-1) as any;
    parentId = saved?.data?.agentId ?? newAgentId();
    if (!saved) pi.appendEntry("pi-subagents.identity.v1", { agentId: parentId, name: "main" });
  };
  const lookup = (id: string) => workers.get(publicIds.get(id) ?? id);
  const actor = (worker: Awaited<ReturnType<typeof launchChild>>) => ({
    id: worker.prepared.communication?.id ?? worker.id,
    name: names.get(worker.id) ?? "general-purpose",
  });
  const roster = () => [
    { id: parentId, name: "main", status: parentContext?.isIdle() ? "idle" : "busy" },
    ...[...workers.values()].map((worker) => ({
      ...actor(worker),
      status: worker.dialogue.snapshot().status,
    })),
  ];
  const takeResults = () => {
    if (closed || !pending.hasEntries) return;
    const { results, omitted, unlistedOmittedReplies } = pending.take();
    pendingReadOffsets.clear();
    for (const item of results)
      event("result.delivered", { from: item.id, to: parentId, sequence: item.sequence });
    for (const gap of omitted)
      event("result.delivery_gap", {
        agentId: gap.id,
        firstSequence: gap.firstSequence,
        lastSequence: gap.lastSequence,
        count: gap.count,
      });
    const deliveryGaps = omitted.map((gap) => ({
      ...gap,
      after: Math.max(0, gap.firstSequence - 1),
    }));
    const notices = deliveryGaps.map(
      (gap) =>
        `<delivery_gap agent_id="${escapeXml(gap.id)}" agent="${escapeXml(gap.agent)}" count="${gap.count}" first="${gap.firstSequence}" last="${gap.lastSequence}">Automatic delivery omitted ${gap.count} earlier ${gap.count === 1 ? "reply" : "replies"} to keep the parent queue bounded. Inspect retained history with subagent_check({id: "${escapeXml(gap.id)}", after: ${gap.after}}) before deciding the work is complete.</delivery_gap>`,
    );
    if (unlistedOmittedReplies > 0) {
      event("result.delivery_gap_overflow", { count: unlistedOmittedReplies });
      notices.push(
        `<delivery_gap unlisted_replies="${unlistedOmittedReplies}">At least ${unlistedOmittedReplies} additional replies were omitted from automatic delivery, but their individual agent cursors no longer fit in the bounded gap summary. Inspect active children with agent_list and subagent_check, or use subagent_check with a recently closed agent ID.</delivery_gap>`,
      );
    }
    return {
      customType: "subagent-dialogue-reply",
      content: [
        ...notices,
        ...results.map((item) =>
          agentEnvelope("result", item.id, item.text, {
            sequence: item.sequence,
            requestIds: item.requestIds,
            truncated: item.truncated === true,
          }),
        ),
      ].join("\n\n"),
      display: true,
      details:
        results.length === 1 && deliveryGaps.length === 0 && unlistedOmittedReplies === 0
          ? results[0]
          : { results, deliveryGaps, unlistedOmittedReplies },
    };
  };
  const flush = () => {
    if (!pending.hasEntries || !parentCanWake || !parentContext?.isIdle()) return;
    const message = takeResults();
    if (message) pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
  };
  const route = async (
    from: string,
    name: string,
    value: unknown,
    origin: { emittedAt?: string; sourceRequestIds: string[] } = {
      emittedAt: new Date().toISOString(),
      sourceRequestIds: [],
    },
  ) => {
    const message = validateMessage(value);
    if (message.to === from)
      throw Error("Use your own context directly; agent_message addresses another session");
    if (message.kind === "progress" && message.to !== parentId)
      throw Error(
        "Routine progress can only be sent to the parent; use question or message for actionable coordination with a child or sibling",
      );
    const messageId = newSemanticId("message");
    if (message.to === parentId) {
      event("message.accepted", { from, to: message.to, messageId });
      pi.sendMessage(
        {
          customType: "agent-message",
          content: agentEnvelope(message.kind, from, message.message, origin),
          display: true,
          details: {
            id: from,
            agent: name,
            kind: message.kind,
            sourceRequestIds: origin.sourceRequestIds,
            ...(origin.emittedAt ? { emittedAt: origin.emittedAt } : {}),
            text: message.message,
            messageId,
          },
        },
        { deliverAs: message.mode, triggerTurn: message.kind !== "progress" },
      );
      event("message.delivered", { from, to: message.to, messageId, mode: message.mode });
      return {
        accepted: true,
        message_id: messageId,
        to: message.to,
        mode: message.mode,
        kind: message.kind,
        trigger_turn: message.kind !== "progress",
      };
    }
    const target = lookup(message.to);
    if (!target || !current(target, generation))
      throw Error("Recipient agent is unknown, closed or revoked");
    let offer: ReturnType<ResponseOffers["offer"]> | undefined;
    const ack = await target.dialogue.message(
      agentEnvelope(message.kind, from, message.message, origin),
      message.mode,
      (requestId) => {
        if (from === parentId && parentContext)
          offer = offers.offer(
            target.dialogue,
            requestId,
            parentContext.sessionManager.getSessionId(),
            `${parentContext.sessionManager.getSessionId()}:${target.prepared.id}:g${generation}`,
            () => current(target, generation),
          );
      },
    );
    if (ack.disposition === "handled") offer?.release();
    event("message.accepted", { from, to: message.to, messageId, requestId: ack.requestId });
    event("message.delivered", { from, to: message.to, messageId, requestId: ack.requestId });
    return {
      accepted: true,
      message_id: messageId,
      to: message.to,
      request_id: ack.requestId,
      ...(ack.disposition !== "handled" && offer?.accepted ? { wait_id: offer.waitId } : {}),
    };
  };
  const skills = () =>
    pi
      .getCommands()
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.replace(/^skill:/, ""),
        description: c.description,
        path: c.sourceInfo.path,
        source: c.sourceInfo,
      }));
  const settingsManager = (ctx: ExtensionContext) =>
    SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  const discoverAgents = (ctx: ExtensionContext) => {
    const store = new ProjectTrustStore(getAgentDir());
    const found = discover(
      join(getAgentDir(), "agents"),
      projectLevels(ctx.cwd, homedir()),
      (root) =>
        sessionTrust.has(root) ||
        store.get(root) === true ||
        (root === resolve(ctx.cwd) &&
          ctx.isProjectTrusted() &&
          hasTrustRequiringProjectResources(root)),
      parseFrontmatter,
    );
    const resources = packageResources;
    found.problems.push(...resources.problems);
    for (const pack of resources.packs)
      for (const directory of pack.agents) {
        const loaded = discoverAgentDirectory(directory, parseFrontmatter, pack.root);
        found.problems.push(...loaded.problems);
        found.warnings.push(...loaded.warnings);
        for (const agent of loaded.agents) {
          if (found.agents.some((current) => current.name === agent.name)) {
            found.problems.push(`${agent.filePath}: duplicate agent name from resource pack`);
            continue;
          }
          found.agents.push({
            ...agent,
            source: "pack",
            catalogueOnly: true,
            packName: pack.name,
            packKeywords: resourcePackageKeywords(pack),
          });
        }
      }
    return found;
  };
  const refreshAgentSelection = (ctx: ExtensionContext) => {
    const found = discoverAgents(ctx);
    const selected = selectedAgents(
      settingsManager(ctx),
      found.agents,
      undefined,
      ctx.mode === "tui",
    );
    agentSelectionSnapshot = {
      names: new Set(selected.agents.map((agent) => agent.name)),
      ...(selected.error ? { error: selected.error } : {}),
    };
  };
  const findAgents = (ctx: ExtensionContext) => {
    const found = discoverAgents(ctx);
    const selected = setup.selection("agents");
    if (selected !== undefined) {
      found.agents = found.agents.filter(
        (agent) =>
          selected.includes(agent.name) && agentPathsSnapshot?.get(agent.name) === agent.filePath,
      );
      return found;
    }
    // Without a session override (including after reset), resolve the latest saved defaults.
    // Session births/resumes keep explicit snapshots, so saving defaults cannot rewrite them.
    refreshAgentSelection(ctx);
    if (agentSelectionSnapshot?.error) {
      found.problems.push(agentSelectionSnapshot.error);
      found.agents = [];
    } else if (agentSelectionSnapshot?.names) {
      found.agents = found.agents.filter((agent) => agentSelectionSnapshot!.names!.has(agent.name));
    } else {
      found.agents = found.agents.filter((agent) => !agent.catalogueOnly);
    }
    return found;
  };
  const settings = (
    agent: Parameters<typeof resolveSettings>[0],
    ctx: ExtensionContext,
    model?: string,
  ) =>
    ctx.modelRegistry.getAvailableOfType("chat").then((available) => {
      // New children use saved personal/project choices, never this parent's session override.
      const choices = skills().map((skill) => ({
        ...skill,
        description: skill.description ?? "",
        toggleable: true,
        defaultSelected: true,
      }));
      const inheritedSkills = selectedSkills(
        settingsManager(ctx),
        choices,
        false,
        undefined,
        false,
      ).map((skill) => skill.name);
      const resolved = resolveSettings(
        agent,
        {
          model: ctx.model,
          thinking: pi.getThinkingLevel(),
          available: [...available],
          tools: pi.getActiveTools(),
          skills: inheritedSkills,
          availableSkills: choices
            .filter((skill) => resourceApplies(settingsManager(ctx), "skills", skill.name, false))
            .map((skill) => skill.name),
        },
        model,
      );
      return resolved;
    });
  const refreshPreviews = async (ctx: ExtensionContext) => {
    previews.clear();
    const found = findAgents(ctx),
      available = [];
    const modelSelections = new Map<string, { model: string; locked: boolean }>();
    const models = await ctx.modelRegistry.getAvailableOfType("chat").catch(() => {
      found.problems.push("Subagent model availability is unavailable");
      return [];
    });
    for (const agent of found.agents) {
      try {
        const resolved = await settings(agent, ctx);
        found.warnings.push(
          ...(resolved.warnings ?? []).map((warning) => `${agent.name}: ${warning}`),
        );
        const spec = {
          ...restrictionSpec(agent, "Preview capabilities", resolved),
          communication: {
            id: "pending-agent-workspace",
            name: agent.name,
            parentId,
            parentName: "main",
          },
        };
        const preview = publicAgentPreview(await launcher().describeChild(spec));
        previews.set(agent.name, preview);
        previewDiagnostics.delete(agent.name);
        available.push(agent);
        modelSelections.set(agent.name, {
          model: `${resolved.model.provider}/${resolved.model.id}`,
          locked: !!agent.model && agent.model !== "inherit",
        });
      } catch (error) {
        previewDiagnostics.set(agent.name, errorText(error));
        found.problems.push(`${agent.name}: capabilities unavailable`);
      }
    }
    return { found, available, modelSelections, models };
  };
  pi.on("before_agent_start", async (input, ctx) => {
    identify(ctx);
    if (!agentSelectionSnapshot) refreshAgentSelection(ctx);
    parentCanWake = true;
    // Keep Pi's mutable options object; later before_agent_start handlers may add context files.
    parentPromptOptions = input.systemPromptOptions;
    const { found, available, modelSelections, models } = await refreshPreviews(ctx);
    input.systemPromptOptions.sections.agents =
      cataloguePrompt("", available, previews, modelSelections, models).trim() +
      (found.problems.length || found.warnings.length
        ? `\nAgent discovery reported ${found.problems.length} problem(s) and ${found.warnings.length} resource warning(s). Run /agents to inspect diagnostics.`
        : "");
    input.systemPromptOptions.sections.agent_id = escapeXml(parentId);
  });
  pi.on("turn_end", (input, ctx) => {
    parentContext = ctx;
    parentCanWake = input.outcome === "completed";
    if (!parentCanWake) return;
    const message = takeResults();
    if (message)
      return { entries: [{ type: "custom_message" as const, ...message }], continue: true };
  });
  pi.on("agent_settled", (input, ctx) => {
    parentContext = ctx;
    if (input.aborted) {
      parentCanWake = false;
      return;
    }
    flush();
  });
  const current = (worker: Awaited<ReturnType<typeof launchChild>>, token: number) =>
    !closed &&
    generation === token &&
    workers.get(worker.id) === worker &&
    worker.dialogue.snapshot().status !== "closed" &&
    (worker.prepared.isCurrent?.() ?? true);
  const cleanup = async (reason = "session_reset") => {
    for (const worker of workers.values())
      if (worker.dialogue.snapshot().status === "busy")
        pi.events.emit(USAGE_EVENT, {
          id: `${worker.id}:interrupted`,
          kind: "child",
          source: actor(worker).id,
          label: actor(worker).name,
          incomplete: true,
        });
    closed = true;
    generation++;
    offers.clear();
    await Promise.allSettled(
      [...workers.values()].map(async (worker) => {
        await worker.close();
        event("agent.closed", { agentId: actor(worker).id, reason });
      }),
    );
    await childProcesses?.close();
    process.removeListener("exit", stopChildProcesses);
    childProcesses = undefined;
    workers.clear();
    publicIds.clear();
    names.clear();
    pending.clear();
    pendingReadOffsets.clear();
    closedHistories.clear();
    previews.clear();
    sessionTrust.clear();
  };
  const refreshResources = async (ctx: ExtensionContext) => {
    packageResources = await discoverResourcePackages(
      settingsManager(ctx),
      ctx.cwd,
      getAgentDir(),
      skills().map((skill) => skill.source),
    );
    agentPathsSnapshot = undefined;
    agentPathsSnapshot = new Map(
      discoverAgents(ctx).agents.map((agent) => [agent.name, agent.filePath]),
    );
    refreshAgentSelection(ctx);
  };
  pi.on("session_start", async (_input, ctx) => {
    await cleanup("session_start");
    agentSelectionSnapshot = undefined;
    previewDiagnostics.clear();
    parentId = "";
    identify(ctx);
    closed = false;
    await refreshResources(ctx);
  });
  pi.on("session_shutdown", () => cleanup("session_shutdown"));
  pi.on("resources_discover", (_input, ctx) => {
    refreshAgentSelection(ctx);
  });
  pi.on("session_tree", async (_input, ctx) => {
    await cleanup("session_tree");
    closed = false;
  });
  pi.events.on(SESSION_SETUP_CONTRIBUTIONS, (value: unknown) => {
    const request = value as SessionSetupContributionRequest;
    if (request?.version !== 1) return;
    const ctx = request.ctx,
      manager = settingsManager(ctx);
    const found = discoverAgents(ctx),
      selected = selectedAgents(manager, found.agents, undefined, ctx.mode === "tui");
    request.contribute({
      kind: "agents",
      candidates: found.agents
        .filter((agent) => agentPathsSnapshot?.get(agent.name) === agent.filePath)
        .map((agent) => ({
          kind: "agents",
          id: agent.name,
          name: agent.name,
          description: agent.description,
          nativeDefault: !agent.catalogueOnly,
          model: agent.model ?? "inherit",
          globalDefaultable:
            agent.source !== "project" &&
            packageResources.packs.find((pack) => pack.name === agent.packName)
              ?.globalDefaultable !== false,
          modelLocked: !!agent.model && agent.model !== "inherit",
          ...(agent.packName ? { packName: agent.packName, keywords: agent.packKeywords } : {}),
        })),
      selected: selected.agents.map((agent) => agent.name),
    });
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "session_setup" || event.isError || event.input.op === "list") return;
    identify(ctx);
    const { available, modelSelections } = await refreshPreviews(ctx);
    const receipt = {
      ...(event.details as Record<string, unknown>),
      effectivePreviews: available.map((agent) => ({
        id: agent.name,
        ...previews.get(agent.name)!,
        model: modelSelections.get(agent.name)!.model,
        locked: modelSelections.get(agent.name)!.locked,
      })),
      capabilityDiagnostics: [...previewDiagnostics.keys()].map((id) => ({
        id,
        message: "Capabilities unavailable; use /agents to inspect diagnostics.",
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  });
  const selectionArgs = (args: string) => {
    const match = /^(enable|disable|none|all|inherit|inspect)(?:\s+(.+))?$/.exec(args.trim());
    return match ? { action: match[1], name: match[2]?.trim() } : undefined;
  };
  pi.registerCommand("agents", {
    description:
      "Select agents for this session; Ctrl+S saves project defaults; Ctrl+Shift+S saves personal defaults",
    async handler(args, ctx) {
      const command = args.trim();
      if (/^trust(?:\s|$)/.test(command)) {
        const root = resolve(command.slice(5).trim() || ctx.cwd);
        if (!projectLevels(ctx.cwd, homedir()).some((level) => level.root === root))
          throw Error("Trust directory must be a discovered ancestor agent level");
        if (!ctx.hasUI) throw Error("Agent trust requires explicit interactive confirmation");
        if (
          await ctx.ui.confirm(
            "Trust agent definitions?",
            `Load repository-controlled system instructions from ${root}?`,
          )
        ) {
          sessionTrust.add(root);
          agentPathsSnapshot = new Map(
            discoverAgents(ctx).agents.map((agent) => [agent.name, agent.filePath]),
          );
          refreshAgentSelection(ctx);
          setup.restore(ctx, true);
        }
      }
      const full = discoverAgents(ctx);
      const manager = settingsManager(ctx);
      let current = selectedAgents(manager, full.agents, undefined, ctx.mode === "tui");
      const sessionNames = setup.selection("agents");
      if (sessionNames)
        current = {
          agents: full.agents.filter((agent) => sessionNames.includes(agent.name)),
          configured: true,
        };
      let selectionChanged = false;
      const action = selectionArgs(command);
      if (action) {
        const names = new Set(current.agents.map((agent) => agent.name));
        if (action.action === "all") {
          setup.execute({ op: "apply", agents: full.agents.map((agent) => agent.name) }, ctx);
          selectionChanged = true;
        } else if (action.action === "none") {
          setup.execute({ op: "apply", agents: [] }, ctx);
          selectionChanged = true;
        } else if (action.action === "inherit") {
          setup.execute({ op: "reset", kinds: ["agents"] }, ctx);
          selectionChanged = true;
        } else if (action.action === "enable" || action.action === "disable") {
          if (!action.name || !full.agents.some((agent) => agent.name === action.name))
            throw Error(`Unknown or untrusted named agent "${action.name ?? ""}"`);
          if (action.action === "enable") names.add(action.name);
          else names.delete(action.name);
          setup.execute({ op: "apply", agents: [...names].sort() }, ctx);
          selectionChanged = true;
        } else if (action.action === "inspect" && !action.name) {
          throw Error("Use /agents inspect NAME");
        }
      }
      if (selectionChanged) current = { agents: findAgents(ctx).agents, configured: true };
      const found = findAgents(ctx);
      const diagnostics = [
        ...new Set([
          ...full.problems,
          ...full.ignored,
          ...full.overrides,
          ...(current.error ? [current.error] : []),
          ...found.problems,
          ...full.warnings,
          ...found.warnings,
          ...[...previewDiagnostics].map(([name, error]) => `${name}: ${error}`),
        ]),
      ];
      if (diagnostics.length && (command || !ctx.hasUI))
        ctx.ui.notify(diagnostics.join("\n\n"), "warning");
      const rows = await Promise.all(
        full.agents.map(async (agent) => {
          try {
            return `${agent.name} — ${agent.description}\n${agent.filePath} (${agent.source})\nValidated request (unset resources inherit): ${JSON.stringify({ ...(await settings(agent, ctx)), tools: agent.tools ?? "inherit", skills: agent.skills ?? "inherit", conversation: agent.context ?? "none" })}`;
          } catch (e) {
            return `${agent.name}: ${e instanceof Error ? e.message : String(e)}\n${agent.filePath}`;
          }
        }),
      );
      let selected = action?.action === "inspect" ? (action.name ?? "") : "";
      if (!action && !/^trust(?:\s|$)/.test(command)) selected = command;
      if (!selected && !action && ctx.hasUI) {
        const browserEntries: ResourceEntry[] = full.agents.map((agent) => {
          return {
            id: agent.name,
            name: agent.name,
            description: agent.description,
            keywords: [agent.model, ...(agent.tools ?? []), agent.source, agent.packKeywords]
              .filter(Boolean)
              .join(" "),
            selected: found.agents.some((item) => item.name === agent.name),
            globalDefaultable:
              agent.source !== "project" &&
              packageResources.packs.find((pack) => pack.name === agent.packName)
                ?.globalDefaultable !== false,
            badge: agent.packName ?? agent.source,
            preview: async () => {
              let fields: Array<{ label: string; value: string }>;
              try {
                const resolved = await settings(agent, ctx);
                const spec = {
                  ...restrictionSpec(agent, "Preview capabilities", resolved),
                  communication: {
                    id: "pending-agent-workspace",
                    name: agent.name,
                    parentId,
                    parentName: "main",
                  },
                };
                const capabilities = publicAgentPreview(await launcher().describeChild(spec));
                const scope = capabilities.scope;
                fields = [
                  {
                    label: "Model",
                    value: `${resolved.model.provider}/${resolved.model.id} · ${resolved.thinking ?? "inherited"}${agent.model && agent.model !== "inherit" ? " · fixed" : " · choose per launch"}`,
                  },
                  { label: "Tools", value: capabilities.tools.join(", ") || "none" },
                  { label: "Child skills", value: resolved.skills.join(", ") || "none" },
                  ...(resolved.warnings?.length
                    ? [{ label: "Warnings", value: resolved.warnings.join("\n") }]
                    : []),
                  { label: "History", value: String(agent.context ?? "none") },
                  ...Object.entries(scope).map(([key, value]) => ({
                    label:
                      key === "workspaceModes" ? "Workspaces" : key[0].toUpperCase() + key.slice(1),
                    value: Array.isArray(value) ? value.join(", ") : String(value),
                  })),
                ];
              } catch (error) {
                fields = [
                  { label: "Capabilities unavailable", value: errorText(error) },
                  { label: "Requested model", value: agent.model ?? "inherit parent model" },
                  {
                    label: "Requested tools",
                    value: agent.tools?.join(", ") ?? "inherit available tools",
                  },
                ];
              }
              return {
                fields,
                source: agent.filePath,
                body: agent.body,
              };
            },
          };
        });
        await showResourceBrowser(ctx, {
          title: "Agents",
          ...resourceBrowserNavigation(pi, "agents"),
          selectionScope: "session",
          defaultsScope: "project",
          notice: diagnostics.join("\n\n"),
          entries: browserEntries,
          ...resourcePickerControls({
            ctx,
            setup,
            entries: browserEntries,
            members: (entry) => [
              {
                kind: "agents",
                id: entry.id,
                nativeDefault: !full.agents.find((agent) => agent.name === entry.id)?.catalogueOnly,
                globalDefaultable: entry.globalDefaultable,
              },
            ],
          }),
        });
        return;
      }
      const target = full.agents.find((agent) => agent.name === selected);
      if (selected && !target) throw Error(`Unknown or untrusted named agent "${selected}"`);
      const index = full.agents.findIndex((agent) => agent.name === selected);
      ctx.ui.notify(
        index >= 0
          ? rows[index]
          : full.agents
              .map(
                (agent) =>
                  `${found.agents.some((item) => item.name === agent.name) ? "[x]" : "[ ]"} ${agent.name} — ${agent.description}`,
              )
              .join("\n") || "No trusted named agents are available.",
        "info",
      );
    },
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Launch a named agent after reviewing its advertised tools and scope. Returns its agent ID, workspace and effective tools. Acknowledgements are not results.",
    promptSnippet: "Launch a named agent with the advertised tools and workspace scope.",
    parameters: Type.Object({
      agent: Type.String(),
      task: Type.String(),
      model: Type.Optional(
        Type.String({
          description:
            "Authenticated model alias or provider/model[:thinking]. Omitted uses the agent default. A model set in the agent definition cannot be overridden.",
        }),
      ),
      conversation: Type.Optional(Type.String()),
      workspace: Type.Optional(
        Type.Union([Type.Literal("scratch"), Type.Literal("project")], {
          description: "Defaults to scratch. Project uses the parent directory directly.",
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (closed || signal?.aborted) throw Error("Agent session is unavailable");
      const token = generation,
        found = findAgents(ctx),
        agent = found.agents.find((a) => a.name === params.agent);
      if (!agent)
        throw Error(
          `Agent "${params.agent}" unavailable. Available named agents: ${agentCatalogue(found.agents)}. Run /agents to inspect discovery and trust diagnostics.`,
        );
      identify(ctx);
      const advertised = previews.get(agent.name);
      const communication = { id: newAgentId(), name: agent.name, parentId, parentName: "main" };
      let effective: Awaited<ReturnType<typeof settings>>;
      let spec: Record<string, unknown>;
      try {
        effective = await settings(agent, ctx, params.model);
        spec = {
          ...restrictionSpec(agent, "Preview capabilities", effective, parentStaticContext(ctx)),
          communication,
        };
      } catch (error) {
        previewDiagnostics.set(agent.name, errorText(error));
        throw new Error(`Could not prepare ${agent.name}: ${errorText(error)}`);
      }
      let preview: AgentPreview;
      try {
        preview = publicAgentPreview(await launcher().describeChild(spec));
        previewDiagnostics.delete(agent.name);
      } catch (error) {
        previewDiagnostics.set(agent.name, errorText(error));
        throw new Error(
          `Could not inspect ${agent.name} capabilities. Run /agents to inspect diagnostics.`,
        );
      }
      if (!advertised || JSON.stringify(preview) !== JSON.stringify(advertised)) {
        previews.set(agent.name, preview);
        throw Error(
          `Review tools and scope before launching ${agent.name}: ${JSON.stringify(preview)}. Retry after reviewing this result.`,
        );
      }
      const conversation = resolveContext(params.conversation, agent.context);
      const messages = ctx.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      const shared = transcript(messages, conversation);
      const task = shared ? taskFileText(params.task, shared) : `<task>\n${params.task}\n</task>`;
      let worker: Awaited<ReturnType<typeof launchChild>>;
      try {
        worker = await launchChild({
          launcher: launcher(),
          transport: childTransport(),
          onSelect: async ({ title, options, signal: childSignal }) => {
            if (!ctx.hasUI || closed || generation !== token) return undefined;
            const signal = ctx.signal ? AbortSignal.any([childSignal, ctx.signal]) : childSignal;
            signal.throwIfAborted();
            const answer = await ctx.ui.select(
              `${agent.name} (${communication.id}): ${title}`,
              options,
              { signal },
            );
            signal.throwIfAborted();
            return !closed &&
              generation === token &&
              answer !== undefined &&
              options.includes(answer)
              ? answer
              : undefined;
          },
          spec: {
            ...restrictionSpec(agent, task, effective, parentStaticContext(ctx)),
            communication,
            workspace: params.workspace ?? "scratch",
          },
          artifactDirectory: join(
            process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
            "subagent-results",
            ctx.sessionManager.getSessionId(),
          ),
          onUsage: (record) => {
            if (!closed && generation === token)
              pi.events.emit(USAGE_EVENT, {
                ...record,
                source: communication.id,
                ownerSessionId: ctx.sessionManager.getSessionId(),
                label: record.kind === "classifier" ? `${agent.name} classifier` : agent.name,
              });
          },
          isCurrent: () => !closed && generation === token,
          onReply: (reply) => {
            if (!current(worker, token) || offers.ownsReply(worker.id, reply)) return;
            const result = {
              ...reply,
              id: communication.id,
              agent: agent.name,
              kind: "result",
            };
            const dropped = pending.add(`${worker.id}:${reply.sequence}`, result);
            for (const omitted of dropped) {
              pendingReadOffsets.delete(`${worker.id}:${omitted.sequence}`);
              event("result.dropped", {
                agentId: omitted.id,
                sequence: omitted.sequence,
                reason: "pending delivery capacity",
              });
            }
            event("result.recorded", {
              from: communication.id,
              sequence: reply.sequence,
              requestIds: reply.requestIds,
            });
            flush();
          },
          onMessage: async (request, sourceRequestIds) => {
            const response = { type: "extension_ui_response", id: request.id, value: "" };
            try {
              if (
                !current(worker, token) ||
                typeof request.id !== "string" ||
                request.method !== "select" ||
                JSON.stringify(request.options) !== JSON.stringify(["Deliver"])
              )
                throw Error("Agent communication request is unavailable");
              const value = JSON.parse(String(request.title).slice(MESSAGE_BRIDGE.length));
              const { emittedAt, ...frame } = value;
              if (
                emittedAt !== undefined &&
                (typeof emittedAt !== "string" ||
                  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(emittedAt) ||
                  !Number.isFinite(Date.parse(emittedAt)))
              )
                throw Error("Invalid agent message origin timestamp");
              const receipt =
                value.operation === "list" && Object.keys(value).join(",") === "operation"
                  ? { accepted: true, agents: roster() }
                  : await route(communication.id, agent.name, frame, {
                      emittedAt,
                      sourceRequestIds,
                    });
              response.value = JSON.stringify(receipt);
            } catch (error) {
              response.value = JSON.stringify({ accepted: false, error: String(error) });
            }
            return response;
          },
          onFailure: () => {
            if (worker) {
              offers.releaseWorker(worker.id);
              event("agent.failed", { agentId: communication.id });
            }
          },
        });
      } catch (error) {
        previewDiagnostics.set(agent.name, errorText(error));
        throw new Error(`Could not start ${agent.name}. Run /agents to inspect diagnostics.`);
      }
      workers.set(worker.id, worker);
      publicIds.set(communication.id, worker.id);
      names.set(worker.id, agent.name);
      event("agent.started", { agentId: communication.id, name: agent.name, parentId });
      let offer: ReturnType<ResponseOffers["offer"]> | undefined;
      let abortClose: Promise<unknown> | undefined;
      const abort = () => {
        offer?.release();
        abortClose ??= worker.close();
        // The awaited startup catch below retries failed cleanup and records diagnostics.
        // Attach a rejection handler here because abort can race that catch.
        void abortClose.catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!current(worker, token) || signal?.aborted) throw Error("Agent session expired");
        const ack = await worker.start(task, (requestId) => {
          offer = offers.offer(
            worker.dialogue,
            requestId,
            ctx.sessionManager.getSessionId(),
            `${ctx.sessionManager.getSessionId()}:${worker.prepared.id}:g${token}`,
            () => current(worker, token),
          );
        });
        if (!current(worker, token) || signal?.aborted) throw Error("Agent session expired");
        if (ack.disposition === "handled") offer?.release();
        const waitId = ack.disposition !== "handled" && offer?.accepted ? offer.waitId : undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                agent_id: communication.id,
                name: agent.name,
                status: "started",
                workspace: worker.prepared.cwd,
                workspace_mode: worker.prepared.workspaceKind ?? "scratch",
                tools: worker.prepared.effectiveResources?.tools ?? preview.tools,
                skills: effective.skills,
                ...(effective.warnings?.length ? { warnings: effective.warnings } : {}),
                scope: preview.scope,
                request_id: ack.requestId,
                ...(waitId ? { wait_id: waitId } : {}),
              }),
            },
          ],
          details: {
            id: communication.id,
            ...(effective.warnings?.length ? { warnings: effective.warnings } : {}),
            requestId: ack.requestId,
            waitId,
            effective: {
              tools: worker.prepared.effectiveResources?.tools ?? effective.tools ?? preview.tools,
              model: effective.model,
              thinking: effective.thinking,
              conversation,
            },
            goalWait: waitId
              ? "accepted"
              : ack.disposition === "handled"
                ? "handled"
                : "not-registered",
          },
        };
      } catch (error) {
        offer?.release();
        let diagnostic = errorText(error);
        let cleanupComplete = false;
        if (abortClose) {
          try {
            await abortClose;
            cleanupComplete = true;
          } catch (closeError) {
            diagnostic += `; abort cleanup: ${errorText(closeError)}`;
          }
        }
        try {
          if (!cleanupComplete) {
            await worker.close();
            cleanupComplete = true;
          }
        } catch (closeError) {
          diagnostic += `; cleanup: ${errorText(closeError)}`;
        }
        if (cleanupComplete) {
          workers.delete(worker.id);
          publicIds.delete(communication.id);
          names.delete(worker.id);
        }
        previewDiagnostics.set(agent.name, diagnostic);
        throw new Error(
          cleanupComplete
            ? `Could not start ${agent.name}. Run /agents to inspect diagnostics.`
            : `Could not start ${agent.name}; cleanup did not finish. Use agent_list and subagent_check to inspect the retained child, then subagent_close to retry cleanup. Run /agents for diagnostics.`,
        );
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
  pi.registerTool({
    name: "agent_list",
    label: "Agent sessions",
    description: "List reachable agent sessions with their IDs, definition names and states.",
    promptSnippet: "List reachable agent IDs, names and states.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      identify(ctx);
      const value = { agents: roster() };
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
  pi.registerTool({
    name: "agent_message",
    label: "Message agent",
    description: messageDescription,
    promptSnippet: "Send progress, questions or coordination to an agent ID.",
    parameters: messageParameters,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      identify(ctx);
      const value = await route(parentId, "main", params);
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
  for (const action of ["check", "cancel", "close"] as const)
    pi.registerTool({
      name: `subagent_${action}`,
      label: `Subagent ${action}`,
      description:
        action === "check"
          ? "Read child state and bounded pages of numbered replies. Recently closed agents remain readable for a short time."
          : "Stop the agent and return a scratch collection or project reference; external effects are untracked. Reply history remains readable with subagent_check for a short time. Set discard to delete owned collected artifacts.",
      promptSnippet:
        action === "check"
          ? "Inspect an agent state and a bounded page of retained replies."
          : "Stop an agent and collect its workspace artifacts.",
      parameters:
        action === "check"
          ? Type.Object({
              id: Type.String(),
              after: Type.Optional(Type.Integer({ minimum: 0 })),
              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
              replySequence: Type.Optional(Type.Integer({ minimum: 1 })),
              textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
            })
          : Type.Object({
              id: Type.String(),
              discard: Type.Optional(Type.Boolean()),
            }),
      async execute(_id, rawParams) {
        const params = rawParams as {
          id: string;
          after?: number;
          limit?: number;
          replySequence?: number;
          textOffset?: number;
          discard?: boolean;
        };
        let worker = lookup(params.id);
        let history = closedHistoryFor(params.id);
        if (!worker && !history) throw Error("Unknown agent or its closed history has expired");
        if (action !== "check") {
          if (worker) {
            offers.releaseWorker(worker.id);
            const artifacts = await worker.close();
            const discarded = params.discard === true && artifacts?.owned === true;
            if (discarded && artifacts)
              await rm(artifacts.directory, { recursive: true, force: true });
            history = rememberClosedHistory(worker, worker.dialogue.snapshot(), artifacts);
            if (discarded && history.artifacts) history.artifacts.discarded = true;
            workers.delete(worker.id);
            publicIds.delete(actor(worker).id);
            names.delete(worker.id);
            event(action === "cancel" ? "agent.cancelled" : "agent.closed", {
              agentId: params.id,
            });
            worker = undefined;
          } else if (params.discard && history?.artifacts?.owned) {
            await rm(history.artifacts.directory, { recursive: true, force: true });
            history.artifacts.discarded = true;
          }
          if (!history) throw Error("Closed agent history is unavailable");
          const snapshot = history.snapshot;
          const visible = {
            id: history.id,
            agent: history.agent,
            status: snapshot.status,
            ...(snapshot.failure
              ? {
                  failure: snapshot.failure.slice(0, 512),
                  ...(snapshot.failure.length > 512 ? { failureTruncated: true } : {}),
                }
              : {}),
            retryable: snapshot.retryable,
            failureRequestIds: snapshot.failureRequestIds,
            pendingRequests: snapshot.pendingRequests,
            replyCursor: snapshot.replyCursor,
            retainedFrom: snapshot.retainedFrom,
            lostReplies: snapshot.lostReplies,
            ...(snapshot.usageSummary ? { usageSummary: snapshot.usageSummary } : {}),
            closedHistory: historySummary(history, snapshot),
            ...(history.artifacts ? { artifacts: history.artifacts } : {}),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(visible) }],
            details: visible,
          };
        }
        const snapshot = worker?.dialogue.snapshot() ?? history!.snapshot;
        const workerId = worker?.id ?? history!.workerId;
        const state = {
          id: params.id,
          agent: (worker ? actor(worker).name : history!.agent).slice(0, 128),
          status: snapshot.status,
          ...(snapshot.failure
            ? {
                failure: snapshot.failure.slice(0, 512),
                ...(snapshot.failure.length > 512 ? { failureTruncated: true } : {}),
              }
            : {}),
          retryable: snapshot.retryable,
          failureRequestIds: snapshot.failureRequestIds.slice(0, 8).map((id) => id.slice(0, 64)),
          pendingRequests: snapshot.pendingRequests,
          replyCursor: snapshot.replyCursor,
          retainedFrom: snapshot.retainedFrom,
          lostReplies: snapshot.lostReplies,
          ...(snapshot.usageSummary ? { usageSummary: snapshot.usageSummary } : {}),
          closedHistory: historySummary(history, snapshot),
        };
        const visible = pageDialogueResponse(snapshot.replies, params, state);
        for (const reply of visible.replies) {
          const pendingKey = `${workerId}:${reply.sequence}`;
          if (!pending.has(pendingKey)) {
            pendingReadOffsets.delete(pendingKey);
            continue;
          }
          const coveredThrough = pendingReadOffsets.get(pendingKey) ?? 0;
          const chunkEnd = reply.textOffset + Buffer.byteLength(reply.text, "utf8");
          if (reply.textOffset <= coveredThrough && chunkEnd >= coveredThrough) {
            const nextCoveredThrough = Math.max(coveredThrough, chunkEnd);
            pendingReadOffsets.set(pendingKey, nextCoveredThrough);
            const pendingTextBytes = pending.textBytes(pendingKey) ?? reply.textBytes;
            if (
              !reply.textTruncated &&
              nextCoveredThrough >= reply.textBytes &&
              nextCoveredThrough >= pendingTextBytes &&
              pending.delete(pendingKey)
            ) {
              pendingReadOffsets.delete(pendingKey);
              event("result.consumed", {
                agentId: params.id,
                sequence: reply.sequence,
                via: "check",
              });
            }
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify(visible) }],
          details: visible,
        };
      },
    });
}
