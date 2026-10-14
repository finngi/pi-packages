import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { emptyUsage } from "pi-runtime/usage";
import { markTransparentProvider } from "pi-runtime/provider-transfer";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalState } from "./goal.ts";
import { budgetStopReason } from "./presentation.ts";
import type { GoalRequests, RequestAuthority } from "./usage.ts";

export interface CurrentGoalScope {
  goal?: GoalState;
  sessionId: string;
  branchToken: string;
  disarmed: boolean;
}
export function admissionReason(
  scope: CurrentGoalScope,
  request?: RequestAuthority,
  now = Date.now(),
): string | undefined {
  if (!request?.goal) return;
  if (
    scope.sessionId !== request.sessionId ||
    scope.branchToken !== request.branchToken ||
    scope.goal?.id !== request.goal.id ||
    scope.goal?.revision !== request.goal.revision
  )
    return "goal authority changed before dispatch";
  // A run that started while this exact goal revision was active may finish its
  // current turn after the deadline. `runGoal` is cleared at every agent_start,
  // so this exception cannot authorize a later run. agent_before_settle still
  // prevents automatic goal-driven continuation after expiry.
  const finishingExpiredRun =
    scope.goal.status === "expired" &&
    scope.goal.deadlineAt !== undefined &&
    scope.goal.deadlineAt <= now;
  if (scope.goal.status !== "active" && !finishingExpiredRun) return `goal is ${scope.goal.status}`;
  if (!finishingExpiredRun && scope.goal.deadlineAt !== undefined && scope.goal.deadlineAt <= now)
    return "goal deadline expired";
  if (scope.disarmed && !finishingExpiredRun)
    return "goal continuation is disarmed; use /goal resume";
  return budgetStopReason(scope.goal);
}
/** Public provider registration keeps the admission fence local to this Pi runtime. */
export class GoalAdmission {
  private readonly installed = new Set<object>();
  private readonly originals = new Map<
    string,
    {
      original: Provider;
      wrapper: Provider;
      config?: ReturnType<ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]>;
      native?: Provider;
      configuredStream?: Provider["streamSimple"];
    }
  >();
  private readonly pi: ExtensionAPI;
  private readonly requests: GoalRequests;
  private readonly current: () => CurrentGoalScope;
  constructor(pi: ExtensionAPI, requests: GoalRequests, current: () => CurrentGoalScope) {
    this.pi = pi;
    this.requests = requests;
    this.current = current;
  }
  dispose(ctx: ExtensionContext) {
    if (typeof ctx.modelRegistry?.getRegisteredNativeProvider !== "function") return;
    for (const [id, { wrapper, config, native, configuredStream }] of this.originals) {
      // A later provider registration belongs to its own owner and must survive cleanup.
      const currentConfig = ctx.modelRegistry.getRegisteredProviderConfig?.(id);
      if (configuredStream) {
        if (currentConfig?.streamSimple !== configuredStream) continue;
      } else if (ctx.modelRegistry.getRegisteredNativeProvider(id) !== wrapper) continue;
      this.pi.unregisterProvider(id);
      if (config)
        this.pi.registerProvider(
          id,
          configuredStream
            ? ({ ...currentConfig, streamSimple: config.streamSimple } as any)
            : (config as any),
        );
      else if (native) this.pi.registerProvider(native);
    }
    this.originals.clear();
    this.installed.clear();
  }
  install(ctx: ExtensionContext) {
    const registry = ctx.modelRegistry;
    // Minimal extension fixtures have no model catalog; real Pi always supplies it.
    if (!registry || typeof registry.getAll !== "function") return;
    for (const id of new Set(registry.getAll().map((model) => model.provider))) {
      let config = registry.getRegisteredProviderConfig?.(id);
      const prior = this.originals.get(id);
      if (this.installed.has(registry.getRegisteredNativeProvider(id) as object)) continue;
      if (prior?.configuredStream && config?.streamSimple === prior.configuredStream) {
        const apis = new Set(
          registry
            .getAll()
            .filter((model) => model.provider === id && model.api !== "pi-virtual")
            .map((model) => model.api),
        );
        if (config.api === prior.config?.api && apis.size === 1 && apis.has(config.api!)) continue;
        // A changed API/loadout needs a fresh guard, without nesting the previous guard.
        this.pi.unregisterProvider(id);
        this.pi.registerProvider(id, {
          ...config,
          streamSimple: prior.config?.streamSimple,
        } as any);
        this.originals.delete(id);
        this.installed.delete(prior.wrapper);
        config = registry.getRegisteredProviderConfig(id);
      }
      const original = registry.getProvider(id);
      if (!original) throw Error(`Goal admission provider is unavailable: ${id}`);
      const guard = (
        messages: readonly any[],
        options?: { sessionId?: string; signal?: AbortSignal },
      ) => {
        options?.signal?.throwIfAborted();
        const request = this.requests.find(messages, options?.sessionId, options?.signal);
        if (!request) return; // Summaries, children, classifiers and warming have no main-call receipt.
        const reason = admissionReason(this.current(), request);
        if (reason) return reason;
        this.requests.dispatch(request);
      };
      const wrapper = {
        ...original,
        stream: ((model: any, context: any, options: any) => {
          const reason = guard(context.messages, options);
          return reason
            ? stoppedGoalStream(model, reason)
            : original.stream(model, context, options);
        }) as typeof original.stream,
        streamSimple: ((model: any, context: any, options: any) => {
          const reason = guard(context.messages, options);
          return reason
            ? stoppedGoalStream(model, reason)
            : original.streamSimple(model, context, options);
        }) as typeof original.streamSimple,
      };
      const native = registry.getRegisteredNativeProvider(id);
      markTransparentProvider(wrapper, { native, config });
      const apis = new Set(
        original
          .getModels()
          .filter((model) => model.api !== "pi-virtual")
          .map((model) => model.api),
      );
      // A configured stream already services both stream methods. Preserve its
      // config registration so later partial registrations retain their merge semantics.
      const configuredStream =
        config?.streamSimple && config.api && apis.size === 1 && apis.has(config.api)
          ? wrapper.streamSimple
          : undefined;
      if (configuredStream)
        this.pi.registerProvider(id, { ...config, streamSimple: configuredStream } as any);
      else this.pi.registerProvider(wrapper);
      this.installed.add(wrapper);
      this.originals.set(id, { original, wrapper, config, native, configuredStream });
    }
  }
}

function stoppedGoalStream(model: Model<Api>, reason: string) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `Goal continuation stopped: ${reason}.` }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "aborted" as const,
    errorMessage: `Goal continuation stopped: ${reason}.`,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "aborted", error: message });
    stream.end();
  });
  return stream;
}
