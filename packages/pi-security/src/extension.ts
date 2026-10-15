import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  BashToolInput,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { HUMAN_INPUT, SECURITY_PRESENCE, USAGE_EVENT } from "pi-contracts";
import { installAccounting } from "pi-runtime";
import type { TSchema } from "typebox";
import type { FileClient } from "./file-protocol.ts";
import { protectRuntime } from "./runtime-protection.ts";
import type { SearchSpec } from "./search-capability.ts";
import type { SecurityService, ShellSpec } from "./service.ts";
import type {
  CallInput,
  ChildSpec,
  ExecutionPermissions,
  EffectTool,
  FetchLease,
  LoadedPolicy,
  RpcSelect,
  WriteGrant,
} from "./types.ts";

interface ServiceRequest<T> {
  version: number;
  respond(value: T): void;
}
interface ShellTransport {
  extensionPath: string;
  startShell(spec: ShellSpec & { foreground?: boolean }): Promise<AgentToolResult<unknown>>;
}

import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createAskResolver } from "./ask-resolver.ts";
import { createBackgroundJobs } from "./background-jobs.ts";
import { forwardChildAsk, handleChildAsk } from "./child-ask.ts";
import { resolveChildAuth, resolveClassifierAuth } from "./child-auth.ts";
import { createChildLauncher, loadChildLaunch } from "./child-launch.ts";
import { childTools } from "./child-resources.ts";
import { classify } from "./classifier.ts";
import { assistantDecisionBeforeTool, recentUserMessages } from "./classifier-context.ts";
import { compatibility, launchOptions } from "./compatibility.ts";
import { securityFailure as failed } from "./errors.ts";
import { createFetchProxy } from "./fetch-proxy.ts";
import { createFileClient } from "./file-client.ts";
import { createFileToolDefinitions } from "./file-tools.ts";
import { Bindings, capDecision, decide, inputHash } from "./gate.ts";
import { attachWriteGrants } from "./write-grants.ts";
import { sandboxCommand } from "./linux-executor.ts";
import { createMcpCapability } from "./mcp-capability.ts";
import { assertPermissions } from "./permissions.ts";
import { hostCapabilitiesFromEnvironment } from "./host-capabilities.ts";
import { loadPolicy } from "./policy.ts";
import { compileProfileAsync as compileProfile } from "./profile-compiler.ts";
import { createSearchCapabilities } from "./search-capability.ts";
import { createTempScope } from "./temp-scope.ts";
import { effectToolOwnershipError, ownsEffectTools } from "./tool-ownership.ts";
import { wallScope } from "./wall-scope.ts";
import { shellOperations, wrapShell, wrapShellAsync } from "./wrap-shell.ts";

const names = ["read", "write", "edit", "ls", "find", "grep", "bash"];
const self = fileURLToPath(import.meta.url);

/** Stock Pi extension entry point. Launch with --no-builtin-tools. */
export default function security(pi: ExtensionAPI) {
  installAccounting(pi);

  const options = launchOptions();
  pi.events.on(SECURITY_PRESENCE, (value) =>
    (value as { respond(active: boolean): void }).respond(options.activation === "active"),
  );
  const cwd = process.cwd();
  const bindings = new Bindings();
  let loaded: LoadedPolicy | undefined;
  let failure = "policy not loaded";
  let ownerValid = false;
  const assertPolicyCurrent = (policy: LoadedPolicy) => {
    if (!ownerValid || loaded !== policy)
      throw Error("execution belongs to an ended security session");
  };
  let policyPath: string | undefined;
  let resolver: ReturnType<typeof createAskResolver> | undefined;
  let manualResolver: ReturnType<typeof createAskResolver> | undefined;
  let proxy: ReturnType<typeof createFetchProxy> | undefined;
  let jobs: ReturnType<typeof createBackgroundJobs> | undefined;
  let tempScope: Awaited<ReturnType<typeof createTempScope>> | undefined;
  const mcp = createMcpCapability({
    getLoaded: () => loaded,
    getUnavailableReason: () => failure,
    isCurrent: () => ownerValid,
    enabled: () => mcpOptIn && pi.getFlag("security-mcp") === true,
    isRegisteredOwner: (name) => ownsEffectTools(pi.getAllTools(), [name], self),
  });
  const mcpOptIn =
    options.activation === "active" &&
    options.placement === "host" &&
    process.env.PI_SUBAGENT !== "1" &&
    !process.env.PI_POLICY_LAUNCH;
  let childLauncher: ReturnType<typeof createChildLauncher> | undefined;
  let resolverContext: ExtensionContext | undefined;
  const audit = (event: string, fields: Record<string, unknown>, ctx: ExtensionContext) => {
    try {
      pi.appendEntry("pi-security.audit.v1", {
        event,
        policyHash: loaded?.sha256?.slice(0, 12),
        ...fields,
      });
      return true;
    } catch {
      loaded = undefined;
      ownerValid = false;
      failure = "audit unavailable";
      try {
        ctx.ui.notify("pi-security audit unavailable; effect tools are blocked.", "error");
      } catch {}
      return false;
    }
  };
  const searchCapabilities = createSearchCapabilities({
    bindings,
    getLoaded: () => (ownerValid ? loaded : undefined),
  });
  const userMessages: string[] = [];
  let authorityEpoch = 0;
  const invalidateAuthority = () => {
    authorityEpoch++;
    resolver?.invalidate();
    manualResolver?.invalidate();
    bindings.clear();
  };
  const currentAuthority = (policy: LoadedPolicy) => {
    const epoch = authorityEpoch;
    return () => {
      assertPolicyCurrent(policy);
      if (epoch !== authorityEpoch)
        throw Error("user instructions changed before execution; request approval again");
    };
  };
  const compat = compatibility({
    placement: options.placement,
    initialized: () => !!loaded && ownerValid,
  });
  if (options.activation === "active") {
    for (const [name, type] of [
      ["permissions", "string"],
      ["auto-mode-model", "string"],
      ["no-sandbox", "boolean"],
      ...(mcpOptIn
        ? [["security-mcp", "boolean"] as const, ["security-codemode", "boolean"] as const]
        : []),
    ] as const)
      pi.registerFlag(name, { type, description: "pi-security launch compatibility" });
    pi.events.on("permissions:service", (data) => {
      const request = data as ServiceRequest<typeof compat>;
      if (request?.version === 1 && typeof request.respond === "function") request.respond(compat);
    });
  }
  const prepareShell = async (spec: ShellSpec) => {
    if (
      !spec ||
      Object.keys(spec).some((key) => !["toolCallId", "input", "cwd", "signal"].includes(key))
    )
      throw Error("invalid shell preparation request");
    const { toolCallId, input, cwd: executionCwd, signal } = spec;
    if (options.activation !== "active" || options.placement !== "host" || !loaded || !ownerValid)
      throw Error("shell preparation unavailable");
    if (signal?.aborted) throw Error("aborted");
    const executionPolicy = loaded;
    const binding = bindings.take(toolCallId, "bash", input, executionCwd || cwd);
    const assertAuthority = currentAuthority(executionPolicy);
    let released = false;
    const assertCurrent = () => {
      if (released) throw Error("prepared shell was released");
      assertAuthority();
    };
    let lease: FetchLease | undefined, directory: string | undefined;
    try {
      if (
        binding.decision.permissions?.execution !== "host" &&
        (binding.decision.permissions?.network.length ?? 0) > 0
      ) {
        proxy ??= createFetchProxy({ hosts: executionPolicy.policy.resources.network });
        lease = await (await proxy).lease(binding.decision.permissions!.network);
      }
      const wrapped = await wrapShellAsync(
        input.command!,
        binding.decision.permissions!,
        executionPolicy,
        {
          policyPath,
          extensionPath: self,
          writeGrants: binding.decision.writeGrants,
          fetchLease: lease,
          envAssign: lease?.env,
          assertCurrent,
        },
        signal,
      );
      if (wrapped.execution === "host") {
        assertCurrent();
        return {
          argv: [...wrapped.argv],
          env: wrapped.env,
          cwd: binding.cwd!,
          execution: "host" as const,
          assertCurrent,
          async release() {
            released = true;
          },
        };
      }
      directory = await mkdtemp(
        path.join(executionPolicy.tempIsolation?.launchDir ?? executionPolicy.tmp, "prepared-"),
      );
      const profilePath = path.join(directory, "command.sb");
      await writeFile(profilePath, wrapped.profile, { mode: 0o600 });
      assertCurrent();
      return {
        argv: sandboxCommand(wrapped, profilePath),
        env: wrapped.env,
        cwd: binding.cwd!,
        assertCurrent,
        async release() {
          if (released) return;
          released = true;
          await lease?.release();
          await rm(directory!, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await lease?.release();
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };
  pi.events.on(HUMAN_INPUT, (value) => {
    const input = value as { version?: unknown; sessionId?: unknown; message?: unknown } | null;
    if (
      process.env.PI_SUBAGENT === "1" ||
      input?.version !== 1 ||
      !resolverContext ||
      typeof input.sessionId !== "string" ||
      !input.sessionId.trim() ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.sessionId !== resolverContext?.sessionManager.getSessionId()
    )
      return;
    invalidateAuthority();
    userMessages.push(input.message);
  });
  pi.on("input", (event) => {
    if (
      process.env.PI_SUBAGENT !== "1" &&
      ["interactive", "rpc"].includes(event.source) &&
      typeof event.text === "string" &&
      !event.text.startsWith("!")
    ) {
      invalidateAuthority();
      userMessages.push(event.text);
    }
  });
  const clients = new Map<string, Promise<FileClient>>();
  const grantedClients = new Set<Promise<FileClient>>();
  const clientForPermissions = async (
    permissions: ExecutionPermissions,
    writeGrants: WriteGrant[] = [],
  ): Promise<FileClient> => {
    if (!loaded) throw Error("file permissions unavailable");
    assertPermissions(permissions, loaded);
    if (permissions.network.length) throw Error("file helpers do not use network permissions");
    const mode = permissions.write ? "write" : "read-only";
    if (writeGrants.length) {
      const executionPolicy = loaded;
      const pending = createFileClient({
        loaded: executionPolicy,
        mode,
        wrapShell,
        compileProfile,
        policyPath,
        extensionPath: self,
        writeGrants,
      }).then(async (client) => {
        const close = client.close.bind(client);
        client.close = async () => {
          try {
            await close();
          } finally {
            grantedClients.delete(pending);
          }
        };
        if (!ownerValid || loaded !== executionPolicy) {
          await client.close();
          throw Error("file helper belongs to an ended security session");
        }
        return client;
      });
      grantedClients.add(pending);
      void pending.catch(() => grantedClients.delete(pending));
      return pending;
    }
    if (!clients.has(mode))
      clients.set(
        mode,
        createFileClient({
          loaded,
          mode,
          wrapShell,
          compileProfile,
          policyPath,
          extensionPath: self,
        }),
      );
    return clients.get(mode)!;
  };
  pi.on("session_shutdown", async () => {
    ownerValid = false;
    bindings.clear();
    await Promise.allSettled([...grantedClients].map(async (client) => (await client).close()));
    userMessages.length = 0;
    resolverContext = undefined;
    searchCapabilities.close();
    mcp.clear();
    bindings.clear();
    ownerValid = false;
    loaded = undefined;
    resolver?.close();
    manualResolver?.close();
    const cleanupErrors: unknown[] = [];
    let deferredProcessResources:
      | {
          proxy?: ReturnType<typeof createFetchProxy>;
          tempScope?: Awaited<ReturnType<typeof createTempScope>>;
        }
      | undefined;
    try {
      const shutdownState = (await jobs?.close()) ?? { activeJobs: [], pendingStarts: 0 };
      if (shutdownState.activeJobs.length || shutdownState.pendingStarts) {
        deferredProcessResources = { proxy, tempScope };
        proxy = undefined;
        tempScope = undefined;
        const waitingFor = [
          ...shutdownState.activeJobs,
          ...(shutdownState.pendingStarts
            ? [
                `${shutdownState.pendingStarts} pending launch${shutdownState.pendingStarts === 1 ? "" : "es"}`,
              ]
            : []),
        ];
        cleanupErrors.push(
          new Error(
            `Background work ${waitingFor.join(", ")} did not settle during shutdown; sandbox resources remain active until it does`,
          ),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!deferredProcessResources) {
      try {
        if (proxy) await (await proxy).close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const clientResults = await Promise.allSettled(
      [...clients.values()].map(async (client) => (await client).close()),
    );
    cleanupErrors.push(
      ...clientResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    clients.clear();
    try {
      await childLauncher?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (deferredProcessResources) {
      void jobs!
        .whenIdle()
        .then(async () => {
          const results = await Promise.allSettled([
            (async () => {
              if (deferredProcessResources?.proxy)
                await (await deferredProcessResources.proxy).close();
            })(),
            (async () => {
              await deferredProcessResources?.tempScope?.close();
            })(),
          ]);
          for (const result of results)
            if (result.status === "rejected")
              process.stderr.write(
                `[pi-security] deferred background cleanup failed: ${(result.reason as Error).message}\n`,
              );
        })
        .catch((error) => {
          process.stderr.write(
            `[pi-security] deferred background cleanup failed: ${(error as Error).message}\n`,
          );
        });
    } else {
      try {
        await tempScope?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Security session cleanup failed");
  });

  pi.on("session_start", async (_event, ctx) => {
    ownerValid = false;
    bindings.clear();
    userMessages.length = 0;
    searchCapabilities.revoke();
    mcp.clear();
    try {
      if (options.activation === "active") {
        const mode = pi.getFlag("permissions");
        if (mode !== undefined && !["auto", "manual"].includes(String(mode)))
          throw Error("permissions mode must be auto or manual");
        if (pi.getFlag("no-sandbox") && options.placement !== "wall")
          throw Error("no-sandbox requires preselected wall");
      }
      const tools = pi.getAllTools();
      const ownershipError = await effectToolOwnershipError(tools, names, self);
      if (options.activation === "active" && options.placement === "host" && ownershipError)
        throw Error(ownershipError);
      ownerValid = true;
      let tmp = process.env.PI_SECURITY_TMP;
      policyPath =
        process.env.PI_SECURITY_POLICY ||
        path.join(
          process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME!, ".pi", "agent"),
          "policy.json",
        );
      if (process.env.PI_SUBAGENT === "1" || process.env.PI_POLICY_LAUNCH) {
        loaded = await loadChildLaunch({ env: process.env, loadPolicy });
        tempScope = await createTempScope({
          base: loaded.tempIsolation!.base,
          sessionTmp: loaded!.tmp,
          launchDir: loaded.tempIsolation!.launchDir,
          retainSessionTmpOnClose: true,
        });
      } else {
        if (tmp) {
          tmp = await realpath(tmp);
          await chmod(tmp, 0o700);
          tempScope = await createTempScope({ base: tmp, sessionTmp: tmp });
        } else tempScope = await createTempScope();
        loaded = await loadPolicy(policyPath, {
          project: ctx.cwd || cwd,
          tmp: tempScope.tmp,
          capabilities: hostCapabilitiesFromEnvironment(),
        });
        await protectRuntime(loaded, self);
        loaded.tempIsolation = {
          base: tempScope.base,
          own: loaded!.tmp,
          launchDir: tempScope.launchDir,
        };
      }
      if (options.activation === "active" && options.placement === "host")
        childLauncher = createChildLauncher({
          parentLoaded: loaded,
          tempScope,
          extensionPath: self,
          ...(options.transport === "extensions"
            ? {
                processExtension: () => {
                  let transport: ShellTransport | undefined;
                  pi.events.emit("pi-security:transport:v1", {
                    version: 1,
                    respond(value: ShellTransport) {
                      if (transport) throw Error("duplicate security transports");
                      transport = value;
                    },
                  });
                  if (!transport?.extensionPath)
                    throw Error(
                      "child shell transport unavailable; load pi-background before delegation",
                    );
                  return transport.extensionPath;
                },
              }
            : {}),
          piCliPath: fileURLToPath(
            new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
          ),
          fixtureProviderExtension: process.env.PI_SECURITY_CHILD_FIXTURE_EXTENSION,
          resolveAuth: (selected, options) =>
            resolveChildAuth(resolverContext!.modelRegistry, selected, options),
          resolveClassifierAuth: (requested, options) =>
            resolveClassifierAuth(resolverContext!.modelRegistry, requested, options),
          parentResources: async () => {
            let bridge: { extensionPath?: string } | undefined;
            pi.events.emit("pi-subagents:bridge:v1", {
              version: 1,
              respond: (value: { extensionPath?: string }) => {
                if (bridge) throw Error("duplicate child messaging bridge");
                bridge = value;
              },
            });
            const communicationExtension =
              bridge?.extensionPath &&
              (await ownsEffectTools(
                pi.getAllTools(),
                ["agent_message", "agent_list"],
                bridge.extensionPath,
              ))
                ? bridge.extensionPath
                : undefined;
            const registry = resolverContext?.modelRegistry;
            const models = registry?.getAvailableOfType
              ? await registry.getAvailableOfType("chat")
              : (registry?.getAvailable() ?? []);
            return {
              tools: pi.getActiveTools().filter((x) => childTools.includes(x)),
              skills: pi
                .getCommands()
                .filter((x) => x.source === "skill")
                .map((x) => ({ name: x.name.slice(6), path: x.sourceInfo?.path })),
              model: resolverContext?.model
                ? { provider: resolverContext.model.provider, id: resolverContext.model.id }
                : undefined,
              models,
              thinking: pi.getThinkingLevel(),
              communicationExtension,
              userMessages: [...(loaded!.authorization?.userMessages ?? userMessages)],
            };
          },
        });
      if (options.activation === "active" && options.placement === "host")
        jobs = createBackgroundJobs({
          prepare: async ({ command, decision, signal }) => {
            const executionPolicy = loaded!;
            const assertCurrent = currentAuthority(executionPolicy);
            let lease: FetchLease | undefined;
            try {
              if (
                decision.permissions?.execution !== "host" &&
                (decision.permissions?.network.length ?? 0) > 0
              ) {
                proxy ??= createFetchProxy({ hosts: executionPolicy.policy.resources.network });
                lease = await (await proxy).lease(decision.permissions!.network);
              }
              assertPolicyCurrent(executionPolicy);
              return {
                assertCurrent,
                profileRoot: executionPolicy.tempIsolation?.launchDir,
                ...(await wrapShellAsync(
                  command,
                  decision.permissions!,
                  executionPolicy,
                  {
                    writeGrants: decision.writeGrants,
                    policyPath,
                    extensionPath: self,
                    fetchLease: lease,
                    envAssign: lease?.env,
                    assertCurrent: currentAuthority(executionPolicy),
                  },
                  signal,
                )),
                release: () => lease?.release(),
              };
            } catch (error) {
              await lease?.release();
              throw error;
            }
          },
        });
      if (options.activation === "shadow") {
        if (audit("initialized", {}, ctx)) compat.started();
        return;
      }
      const override = pi.getFlag("auto-mode-model");
      if (typeof override === "string" && override) loaded!.policy.classifier.model = override;
      const selectedMode = pi.getFlag("permissions");
      if (!loaded.launchId && ["auto", "manual"].includes(String(selectedMode)))
        loaded!.policy.mode = selectedMode as "auto" | "manual";
      if (!loaded.launchId)
        userMessages.push(...recentUserMessages(ctx.sessionManager.getBranch()));
      resolverContext = ctx;
      resolver = createAskResolver({
        policy: loaded!.policy,
        authority: (call) => ({
          userMessages: [...(loaded!.authorization?.userMessages ?? userMessages)],
          depth: loaded!.agentDepth ?? 0,
          ...(loaded!.childTask === undefined ? {} : { childTask: loaded!.childTask }),
          assistantDecision: assistantDecisionBeforeTool(
            resolverContext!.sessionManager.getBranch(),
            call,
          ),
        }),
        classify: async (view, options) => {
          const registry = resolverContext!.modelRegistry;
          const requested = options.model;
          const matches = (model: { id: string; provider: string }) =>
            model.id === requested || `${model.provider}/${model.id}` === requested;
          const native = registry.getModelsOfType("classifier").find(matches);
          const model = native ?? registry.getAll().find(matches);
          const client = model
            ? native
              ? { classify: registry.classify.bind(registry) }
              : { complete: registry.complete.bind(registry) }
            : undefined;
          const started = performance.now();
          let captured = false;
          const usageSessionId = resolverContext!.sessionManager.getSessionId(),
            usageId = `${usageSessionId}:classifier:${randomUUID()}`;
          const publishUsage = (usage?: import("@earendil-works/pi-ai").Usage) => {
            captured = true;
            pi.events.emit(USAGE_EVENT, {
              id: usageId,
              ownerSessionId: usageSessionId,
              kind: "classifier",
              source: usageSessionId,
              label: requested,
              model: requested,
              usage,
            });
          };
          const result = await classify(view, { ...options, model, client }, publishUsage);
          if (!captured && client) publishUsage();
          if (
            !audit(
              "classification",
              {
                toolName: view.tool,
                classifierModel: requested,
                verdict: result.verdict,
                reasonCode: result.reasonCode,
                localChild: Boolean(loaded?.launchId),
                elapsedMs: Math.round(performance.now() - started),
              },
              resolverContext!,
            )
          )
            return { verdict: "unsure", reasonCode: "audit-unavailable", labels: [] };
          return result;
        },
      });
      manualResolver = createAskResolver({
        policy: { ...loaded!.policy, mode: "manual" },
        authority: () => ({ userMessages: [...userMessages], depth: loaded!.agentDepth ?? 0 }),
      });
      if (loaded.resources) pi.setActiveTools(loaded.resources.tools);
      else if (mcpOptIn && pi.getFlag("security-codemode") === true) {
        const codemode = pi.getAllTools().find((tool) => tool.name === "codemode");
        if (codemode?.sourceInfo?.path !== "builtin:codemode" || codemode.exposure !== "model-only")
          throw Error("--security-codemode requires stock builtin:codemode");
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "codemode"])]);
      }
      if (audit("initialized", {}, ctx)) compat.started();
    } catch (error) {
      loaded = undefined;
      failure = String((error as Error)?.message || error);
      audit("unavailable", {}, ctx);
      ctx.ui.notify(
        `pi-security could not initialize: ${failure} Effect tools are blocked.`,
        "error",
      );
    }
  });
  pi.events.on("pi-security:service:v1", (data) => {
    const request = data as ServiceRequest<SecurityService>;
    if (
      options.activation !== "active" ||
      !loaded ||
      !ownerValid ||
      !childLauncher ||
      request?.version !== 1 ||
      typeof request.respond !== "function"
    )
      return;
    request.respond({
      version: 1,
      prepareShell,
      prepareSearch: (spec: SearchSpec) => searchCapabilities.prepareSearch(spec),
      describeChild: (spec: ChildSpec) => childLauncher!.describeChild(spec),
      getAgentContext: () =>
        loaded!.communication ? { ...loaded!.communication, workspace: loaded!.tmp } : undefined,
      prepareChildLaunch: (spec: ChildSpec) => childLauncher!.prepareChildLaunch(spec),
      async handleChildAsk(launchId: string, request: RpcSelect) {
        const launch = childLauncher!.launches.get(launchId);
        return handleChildAsk({
          request,
          launch,
          parentCheck: async (call) => {
            const child = decide(call.toolName, call.input, launch!.childLoaded);
            const parent = decide(call.toolName, call.input, { ...loaded!, project: launch!.cwd });
            if (child.verdict === "deny") return child;
            if (parent.verdict === "deny") return parent;
            return { ...child, verdict: "ask", reason: "child unmatched call" };
          },
          parentResolve: async (call, decision) =>
            capDecision(
              loaded!.launchId
                ? await forwardChildAsk({
                    call,
                    decision,
                    childLoaded: loaded!,
                    ctx: resolverContext,
                  })
                : await manualResolver!.resolve(
                    { ...call, agentName: launch!.childLoaded.communication?.name },
                    decision,
                    resolverContext,
                  ),
              launch!.childLoaded,
            ),
        });
      },
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    resolverContext = ctx;
    const approvalEpoch = authorityEpoch;
    if (options.activation === "shadow") {
      if (!loaded) return { block: true, reason: `pi-security: ${failure}` };
      const decision = decide(event.toolName, event.input, loaded);
      if (
        !audit(
          "shadow",
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            verdict: decision.verdict,
            permissions: decision.permissions ?? null,
            ruleIds: decision.ruleIds ?? [],
            inputHash: inputHash(event.toolName, event.input).slice(0, 12),
            extraWritePathCount: decision.writeGrants?.length ?? 0,
          },
          ctx,
        )
      )
        return { block: true, reason: `pi-security: ${failure}` };
      return;
    }
    const toolInfo = pi.getAllTools().find((tool) => tool.name === event.toolName);
    if (!toolInfo) return { block: true, reason: "pi-security: unknown tool" };
    if (event.toolName === "powershell")
      return {
        block: true,
        reason: "pi-security: native PowerShell is disabled; no confined executor is available",
      };
    const mcpTool = mcp.isMcpTool(event.toolName, toolInfo);
    const mcpResource = [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ].includes(event.toolName);
    if (mcpTool || mcpResource) {
      if (!mcpOptIn || pi.getFlag("security-mcp") !== true)
        return {
          block: true,
          reason: "pi-security: native MCP requires explicit --security-mcp opt-in",
        };
      if (!ownerValid || !loaded) return { block: true, reason: `pi-security: ${failure}` };
      if (mcpTool && !mcp.isOwnedMcpTool(event.toolName, toolInfo))
        return { block: true, reason: "pi-security: unowned or spoofed MCP namespace" };
      if (mcpResource && !mcp.isResourceTool(event.toolName, toolInfo))
        return { block: true, reason: "pi-security: unowned MCP resource tool" };
      if (!(await ownsEffectTools(pi.getAllTools(), [event.toolName], self)))
        return { block: true, reason: "pi-security: MCP tool registration source is not owned" };
      if (toolInfo.exposure === "hidden")
        return { block: true, reason: "pi-security: hidden MCP tool" };
      if (
        mcpResource &&
        (typeof (event.input as Record<string, unknown>).server !== "string" ||
          (event.toolName === "read_mcp_resource" &&
            typeof (event.input as Record<string, unknown>).uri !== "string"))
      )
        return {
          block: true,
          reason:
            "pi-security: MCP resource operation requires an explicit server and resource URI",
        };
    }
    if (!ownerValid || !loaded) return { block: true, reason: `pi-security: ${failure}` };
    if (loaded!.communication && ["agent_message", "agent_list"].includes(event.toolName)) {
      if (
        !loaded.resources?.tools.includes(event.toolName) ||
        !(await ownsEffectTools(
          pi.getAllTools(),
          [event.toolName],
          loaded!.communication.extensionPath,
        ))
      )
        return { block: true, reason: "pi-security: unbound agent communication tool" };
      if (!audit("communication", { toolCallId: event.toolCallId, toolName: event.toolName }, ctx))
        return { block: true, reason: "pi-security: audit unavailable" };
      return;
    }
    if (options.placement === "wall") await wallScope(event.toolName, event.input, loaded);
    if (loaded.resources && !loaded.resources.tools.includes(event.toolName))
      return { block: true, reason: "pi-security: tool outside child selected resources" };
    const executionPolicy = loaded;
    let adapterHosts: string[] = [];
    try {
      if (mcpTool || mcpResource) adapterHosts = mcp.requiredNetwork(event.toolName, event.input);
    } catch (error) {
      return { block: true, reason: `pi-security: ${(error as Error).message}` };
    }
    const checked = decide(
      event.toolName,
      event.input,
      { ...executionPolicy, project: ctx.cwd },
      adapterHosts,
    );
    const writeGrants = checked.writeGrants ?? [];
    let decision = checked;
    if (decision.verdict === "ask")
      decision =
        loaded.launchId && loaded!.policy.mode === "manual"
          ? await forwardChildAsk({ call: event, decision, childLoaded: loaded, ctx })
          : await resolver!.resolve({ ...event, cwd: ctx.cwd }, decision, ctx);
    if (!ownerValid || loaded !== executionPolicy)
      return { block: true, reason: "pi-security: approval belongs to an ended session" };
    if (approvalEpoch !== authorityEpoch)
      return {
        block: true,
        reason: "pi-security: user instructions changed during approval; request approval again",
      };
    decision = attachWriteGrants(capDecision(decision, executionPolicy), writeGrants);
    if (
      !audit(
        "decision",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          verdict: decision.verdict,
          permissions: decision.permissions ?? null,
          ruleIds: decision.ruleIds ?? [],
          inputHash: inputHash(event.toolName, event.input).slice(0, 12),
          extraWritePathCount: writeGrants.length,
        },
        ctx,
      )
    )
      return { block: true, reason: `pi-security: ${failure}` };
    if (decision.verdict !== "allow")
      return {
        block: true,
        reason: `pi-security: ${decision.reason} [${decision.ruleIds?.join(",") || "-"}]`,
      };
    bindings.put(
      event.toolCallId,
      event.toolName,
      event.input,
      decision,
      names.includes(event.toolName) ? ctx.cwd : undefined,
    );
    if (mcpTool || mcpResource) {
      try {
        if (mcpResource) {
          const method =
            event.toolName === "read_mcp_resource"
              ? "resources/read"
              : event.toolName === "list_mcp_resource_templates"
                ? "resources/templates/list"
                : "resources/list";
          mcp.issueResource(
            event.toolCallId,
            event.toolName,
            method,
            event.input as Record<string, unknown>,
            toolInfo,
            decision.permissions!,
          );
        } else
          mcp.issue(event.toolCallId, event.toolName, event.input, toolInfo, decision.permissions!);
      } catch (error) {
        bindings.delete(event.toolCallId);
        return { block: true, reason: `pi-security: ${(error as Error).message}` };
      }
    }
  });
  pi.on("tool_execution_end", (event) => {
    bindings.delete(event.toolCallId);
    mcp.revoke(event.toolCallId);
    searchCapabilities.release(event.toolCallId);
  });
  pi.on("tool_result", (event) => {
    searchCapabilities.release(event.toolCallId);
    mcp.revoke(event.toolCallId);
    bindings.delete(event.toolCallId);
    if (["write", "edit", "bash"].includes(event.toolName)) resolver?.clearCache();
  });

  if (options.activation === "shadow" || options.placement === "wall") return;
  const definitions: Record<string, EffectTool> = {
    ...createFileToolDefinitions({ cwd, clientForPermissions }),
    bash: createBashToolDefinition(cwd) as unknown as EffectTool,
  };
  for (const name of names) {
    const original = definitions[name];
    const parameters =
      name === "bash"
        ? {
            ...original.parameters,
            properties: {
              ...(original.parameters as TSchema & { properties: Record<string, TSchema> })
                .properties,
              background: { type: "boolean", description: "Start a session-owned background job" },
              permissions: {
                type: "object",
                additionalProperties: false,
                properties: {
                  execution: {
                    type: "string",
                    enum: ["sandbox", "host"],
                    description:
                      "Defaults to sandbox. Host requests approval to run this exact command outside Pi's per-command sandbox, using the invoked harness's own authentication and controls. Do not combine host with write/network grants.",
                  },
                  write: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Writable files or existing directory trees needed by this command.",
                  },
                  network: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Network hosts needed by this command, or * for arbitrary public destinations. Additional access is reviewed for approval.",
                  },
                },
                description: "Request additional resources for this exact execution.",
              },
            },
          }
        : original.parameters;
    pi.registerTool({
      ...original,
      ...(name === "bash"
        ? {
            promptGuidelines: [
              ...(original.promptGuidelines ?? []),
              ...(process.platform === "darwin"
                ? [
                    "Use pgrep -fl 'PATTERN' for process inspection on macOS; setuid ps and top cannot run inside Seatbelt.",
                  ]
                : []),
              "For authorized Codex/Pi calls needing native login or IPC, request permissions.execution=host; do not request writes to the harness configuration directory.",
            ],
          }
        : {}),
      parameters,
      defaultActive: !["ls", "find", "grep"].includes(name),
      async execute(id, input: CallInput, signal, onUpdate, ctx) {
        let lease: FetchLease | undefined;
        let fileExecution = false;
        try {
          if (!ownerValid || !loaded) return failed(failure);
          if (loaded.resources && !loaded.resources.tools.includes(name))
            return failed("tool outside child selected resources");
          if (name === "bash" && options.transport === "extensions") {
            let transport: ShellTransport | undefined;
            pi.events.emit("pi-security:transport:v1", {
              version: 1,
              respond: (value: ShellTransport) => {
                if (transport) throw Error("duplicate security transports");
                transport = value;
              },
            });
            if (!transport)
              throw Error("session process transport unavailable; load pi-background");
            const result = await transport.startShell({
              foreground: input.background !== true,
              toolCallId: id,
              input,
              cwd: ctx.cwd || cwd,
              signal,
            });
            const processDetails = result.details as
              | { id?: string; running?: boolean; yielded?: boolean }
              | undefined;
            if (
              !audit(
                "execution",
                {
                  toolCallId: id,
                  toolName: name,
                  exitCode:
                    (result.structuredContent as { exit_code?: number } | undefined)?.exit_code ??
                    null,
                  processId: processDetails?.id,
                  running: processDetails?.running,
                  yielded: processDetails?.yielded,
                },
                ctx,
              )
            )
              return failed(failure);
            return result;
          }
          const executionPolicy = loaded;
          const binding = bindings.take(id, name, input, ctx.cwd);
          const assertCurrent = currentAuthority(executionPolicy);
          if (name !== "bash") {
            fileExecution = true;
            return await original.execute(id, input, signal, onUpdate, {
              ...ctx,
              cwd: binding.cwd,
              securityPermissions: binding.decision.permissions,
              securityWriteGrants: binding.decision.writeGrants,
            } as ExtensionToolContext);
          }
          if (input.background === true) {
            const job = await jobs!.start({
              command: input.command!,
              cwd: binding.cwd!,
              decision: binding.decision,
              signal,
              timeout: input.timeout as number | undefined,
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ id: job.id }) }],
              details: {
                id: job.id,
                execution: binding.decision.permissions?.execution ?? "sandbox",
              },
            };
          }
          if (
            binding.decision.permissions?.execution !== "host" &&
            (binding.decision.permissions?.network.length ?? 0) > 0
          ) {
            proxy ??= createFetchProxy({ hosts: executionPolicy.policy.resources.network });
            lease = await (await proxy).lease(binding.decision.permissions!.network);
          }
          const definition = createBashToolDefinition(binding.cwd!, {
            operations: shellOperations(executionPolicy, binding.decision.permissions!, {
              assertCurrent,
              writeGrants: binding.decision.writeGrants,
              policyPath,
              extensionPath: self,
              fetchLease: lease,
              envAssign: lease?.env,
            }),
            exposeSessionEnvironment: false,
          });
          const result = await definition.execute(
            id,
            input as BashToolInput,
            signal,
            onUpdate as Parameters<typeof definition.execute>[3],
            { ...ctx, cwd: binding.cwd! },
          );
          if (
            !audit(
              "execution",
              {
                toolCallId: id,
                toolName: name,
                ruleIds: binding.decision.ruleIds,
                permissions: binding.decision.permissions!,
                exitCode:
                  (result.structuredContent as { exit_code?: number } | undefined)?.exit_code ??
                  null,
              },
              ctx,
            )
          )
            return failed(failure);
          return {
            ...result,
            details: {
              ...result.details,
              execution: binding.decision.permissions?.execution ?? "sandbox",
            },
          };
        } catch (error) {
          if (fileExecution) throw error;
          return failed((error as Error)?.message || String(error));
        } finally {
          bindings.delete(id);
          await lease?.release();
        }
      },
    });
  }
  if (options.transport !== "extensions")
    pi.registerTool({
      name: "background_process",
      label: "Background process",
      description: "List, read, inspect or cancel owned sandboxed jobs",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["list", "status", "read", "cancel"] },
        },
        required: ["action"],
        additionalProperties: false,
      } as TSchema,
      async execute(id, input: { action: string; id?: string }) {
        try {
          if (!loaded || !jobs) return failed(failure);
          bindings.take(id, "background_process", input);
          if (input.action !== "list" && !input.id) throw Error("A process ID is required");
          const value =
            input.action === "list"
              ? jobs.list()
              : input.action === "cancel"
                ? await jobs.cancel(input.id!)
                : input.action === "read"
                  ? jobs.read(input.id!)
                  : input.action === "status"
                    ? jobs.status(input.id!)
                    : (() => {
                        throw Error("invalid job action");
                      })();
          return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
        } catch (error) {
          return failed((error as Error).message);
        } finally {
          bindings.delete(id);
        }
      },
    });
  if (mcpOptIn) {
    createMcpExtension({
      loadConfig: (ctx) => {
        if (
          pi.getFlag("security-mcp") === true &&
          !pi.getAllTools().some((tool) => tool.name === "tool_search")
        )
          return {
            servers: [],
            errors: ["--security-mcp requires the host-loaded builtin tool_search"],
            autoEnableCodemode: false,
          };
        return mcp.loadConfig(ctx);
      },
      createTransport: (entry, cwd, authProvider) =>
        mcp.transport(entry as never, cwd, authProvider),
    })(mcp.wrapApi(pi));
  }
}
