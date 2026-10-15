import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_SERVICE,
  SESSION_SETUP_STATE,
  type SessionSetupCandidate,
  type SessionSetupContribution,
  type SessionSetupOverrides,
  type SessionSetupRequest,
  type SessionSetupService,
  type SessionSetupResourceKind,
  type SessionSetupResourceState,
  type SessionSetupSelectionState,
} from "pi-contracts";
import { ResourceSearch } from "pi-resource-browser/search";
import { Type } from "typebox";
import {
  readResourceSelection,
  readResourceModes,
  resolveResourceSelection,
  resolveResourceMode,
  resourceModeState,
  resourceSelectionState,
  type ResourceSelectionValue,
  type ResourceModes,
} from "./resource-selection.ts";

export {
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_SERVICE,
  SESSION_SETUP_STATE,
  type SessionSetupCandidate,
  type SessionSetupContribution,
  type SessionSetupContributionRequest,
  type SessionSetupKind,
  type SessionSetupOverrides,
  type SessionSetupRequest,
  type SessionSetupSelectionKind,
  type SessionSetupService,
  type SessionSetupResourceKind,
  type SessionSetupResourceState,
  type SessionSetupSelectionState,
} from "pi-contracts";

const kinds = ["packages", "skills", "agents", "instructions", "tools"] as const;
const selections = ["skills", "agents", "instructions", "tools"] as const;
const resources = ["skills", "agents", "instructions"] as const;
type ResourceStates = Partial<Record<SessionSetupResourceKind, Record<string, boolean>>>;
type ResourceSessionModes = Partial<Record<SessionSetupResourceKind, ResourceModes>>;
const ids = (value: unknown, label: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > 250 ||
    value.some(
      (id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 512,
    ) ||
    new Set(value).size !== value.length
  )
    throw Error(`${label} must be at most 250 unique exact IDs of at most 512 characters`);
  return [...value];
};
export function validateSessionSetupRequest(value: unknown): SessionSetupRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("session_setup expects an object");
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some((key) => !["op", "query", "kinds", "limit", ...kinds].includes(key))
  )
    throw Error("Unknown session_setup field");
  if (!["list", "apply", "reset"].includes(request.op as string))
    throw Error("Unknown session_setup operation");
  if (
    request.query !== undefined &&
    (typeof request.query !== "string" || request.query.length > 4096)
  )
    throw Error("query must be a string of at most 4096 characters");
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 50)
  )
    throw Error("limit must be between 1 and 50");
  if (
    request.kinds !== undefined &&
    ids(request.kinds, "kinds").some((kind) => !kinds.includes(kind as (typeof kinds)[number]))
  )
    throw Error("Unknown resource kind");
  for (const kind of kinds) if (request[kind] !== undefined) ids(request[kind], kind);
  if (request.op !== "apply" && kinds.some((kind) => request[kind] !== undefined))
    throw Error("Only apply accepts resource selections");
  return structuredClone(request) as unknown as SessionSetupRequest;
}

export function planSessionSetup(
  request: SessionSetupRequest,
  current: SessionSetupOverrides,
  contributions: SessionSetupContribution[],
): SessionSetupOverrides {
  const next = request.op === "reset" && !request.kinds ? {} : structuredClone(current);
  if (request.op === "reset" && request.kinds) {
    for (const kind of selections)
      if (request.kinds.includes(kind) || (kind !== "tools" && request.kinds.includes("packages")))
        delete next[kind];
  }
  const candidates = contributions.flatMap((value) => value.candidates);
  const known = (kind: (typeof kinds)[number], selected: string[]) => {
    const available = new Set(
      candidates.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.id),
    );
    const missing = selected.filter((id) => !available.has(id));
    if (missing.length) {
      const provider = {
        skills: "pi-resources",
        agents: "pi-delegation",
        instructions: "pi-context",
      }[kind as "skills" | "agents" | "instructions"];
      const recovery =
        provider && !contributions.some((value) => value.kind === kind)
          ? `. No ${kind} provider is loaded. Load ${provider} to retain these choices, or use session_setup reset to discard the saved override.`
          : "";
      throw Error(
        `Unknown or unavailable ${kind} IDs: ${missing.join(", ")}${recovery}${
          kind === "packages"
            ? ". Choose a package returned by session_setup list. Add new sources with pi install, then /reload while idle. Use -e for temporary packages in a new invocation. Executable extension changes or running children need a restart. No selection was changed."
            : ""
        }`,
      );
    }
  };
  if (request.op === "apply") {
    for (const kind of kinds) if (request[kind] !== undefined) known(kind, request[kind]!);
    const packs = request.packages && new Set(request.packages);
    for (const kind of selections) {
      if (packs && kind !== "tools" && contributions.some((value) => value.kind === kind))
        next[kind] = [
          ...new Set([
            ...candidates
              .filter(
                (candidate) =>
                  candidate.kind === kind && candidate.packName && packs.has(candidate.packName),
              )
              .map((candidate) => candidate.id),
            ...(request[kind] ?? []),
          ]),
        ];
      else if (request[kind] !== undefined) next[kind] = [...request[kind]!];
      if (next[kind] !== undefined) ids(next[kind], kind);
    }
  }
  for (const kind of selections)
    if (next[kind] !== undefined) {
      ids(next[kind], kind);
      known(kind, next[kind]!);
    }
  return next;
}

export function sessionSetupService(
  events: Pick<ExtensionAPI["events"], "emit">,
): SessionSetupService | undefined {
  const found: SessionSetupService[] = [];
  events.emit(SESSION_SETUP_SERVICE, {
    version: 1,
    respond: (service: SessionSetupService) => found.push(service),
  });
  if (found.length > 1) throw Error("Duplicate session setup service");
  return found[0];
}

/** Explicit parent installation; shared imports do not register resources or mutate sessions. */
export function installSessionSetup(pi: ExtensionAPI): SessionSetupService {
  const existing = sessionSetupService(pi.events);
  if (existing) return existing;
  let overrides: SessionSetupOverrides = {},
    baseTools: string[] = [],
    sessionId = "",
    restoreError: string | undefined;
  let resourceUniverse: SessionSetupCandidate[] | undefined;
  let states: ResourceStates = {};
  let initialized = false,
    interactive = false;
  let resolved: Partial<Record<SessionSetupResourceKind, string[]>> = {};
  let defaults: Record<
    "global" | "project",
    Partial<Record<SessionSetupResourceKind, ResourceSelectionValue>>
  > = { global: {}, project: {} };
  let defaultModes: Record<"global" | "project", ResourceSessionModes> = {
    global: {},
    project: {},
  };
  let nativeDefaults: Partial<Record<SessionSetupResourceKind, Record<string, boolean>>> = {};
  let service: SessionSetupService;
  const selection = (kind: (typeof selections)[number]) => {
    if (kind === "tools") return overrides.tools === undefined ? undefined : [...overrides.tools];
    return !initialized ? undefined : [...(resolved[kind] ?? [])];
  };
  const snapshotDefaults = (ctx: ExtensionContext) => {
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    defaults = { global: {}, project: {} };
    defaultModes = { global: {}, project: {} };
    for (const scope of ["global", "project"] as const)
      for (const kind of resources) {
        defaults[scope][kind] = structuredClone(readResourceSelection(manager, scope, kind));
        defaultModes[scope][kind] = structuredClone(readResourceModes(manager, scope, kind));
      }
    interactive = ctx.mode === "tui";
  };
  const state = (
    kind: SessionSetupResourceKind,
    id: string,
    nativeDefault = false,
  ): SessionSetupResourceState => {
    const sessionValue = {
      ...(overrides[kind] === undefined ? {} : { [id]: overrides[kind]!.includes(id) }),
      ...states[kind],
    };
    const chosen = resolveResourceSelection(
      defaults.global[kind],
      defaults.project[kind],
      id,
      nativeDefaults[kind]?.[id] ?? nativeDefault,
      sessionValue,
    );
    const mode = resolveResourceMode(defaultModes.global[kind], defaultModes.project[kind], id);
    return {
      sessionState: resourceSelectionState(sessionValue, id),
      projectState: chosen.projectState,
      globalState: chosen.globalState,
      selected: chosen.effective && (mode.mode !== "interactive" || interactive),
      effectiveSource: chosen.source,
      projectMode: resourceModeState(defaultModes.project[kind], id),
      globalMode: resourceModeState(defaultModes.global[kind], id),
      mode: mode.mode,
      modeSource: mode.source,
    };
  };
  const resolveSelections = () => {
    resolved = {};
    for (const kind of resources)
      resolved[kind] = (resourceUniverse ?? [])
        .filter((candidate) => candidate.kind === kind && state(kind, candidate.id).selected)
        .map((candidate) => candidate.id);
  };
  const persist = (nextOverrides = overrides, nextStates = states) => {
    pi.appendEntry(SESSION_SETUP_STATE, {
      version: 2,
      overrides: nextOverrides,
      states: nextStates,
      baseTools,
    });
  };
  pi.events.on(SESSION_SETUP_SERVICE, (value: any) => {
    if (value?.version === 1) value.respond(service);
  });
  const collect = (ctx: ExtensionContext): SessionSetupContribution[] => {
    const values: SessionSetupContribution[] = [];
    pi.events.emit(SESSION_SETUP_CONTRIBUTIONS, {
      version: 1,
      ctx,
      contribute: (value: SessionSetupContribution) => values.push(structuredClone(value)),
    });
    // A package groups resources supplied by the loaded providers. It does not require
    // the interactive picker (or delegation) to be installed.
    const declaredPackages = new Set(
      values
        .filter((value) => value.kind === "packages")
        .flatMap((value) => value.candidates.map((candidate) => candidate.id)),
    );
    const grouped = new Map<string, SessionSetupCandidate[]>();
    for (const value of values)
      if (value.kind !== "packages" && value.kind !== "tools")
        for (const candidate of value.candidates)
          if (candidate.packName && !declaredPackages.has(candidate.packName)) {
            const members = grouped.get(candidate.packName) ?? [];
            members.push(candidate);
            grouped.set(candidate.packName, members);
          }
    if (grouped.size)
      values.push({
        kind: "packages",
        candidates: [...grouped].map(([id, members]) => ({
          kind: "packages",
          id,
          name: id,
          description: `Available resources: ${[...new Set(members.map((member) => member.kind))].join(", ")}`,
          keywords: members
            .map((member) => `${member.name} ${member.description} ${member.keywords ?? ""}`)
            .join(" "),
          globalDefaultable: members.every((member) => member.globalDefaultable !== false),
        })),
        selected: [],
      });
    const activeTools = new Set(pi.getActiveTools());
    values.push({
      kind: "tools",
      candidates: pi
        .getAllTools()
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => ({
          kind: "tools",
          id: tool.name,
          name: tool.name,
          description: tool.description,
          exposure: tool.exposure,
          activation: activeTools.has(tool.name) ? "active" : "checked-on-apply",
        })),
      selected: [...activeTools],
    });
    const seen = new Set<string>();
    for (const value of values)
      for (const candidate of value.candidates) {
        const key = `${candidate.kind}:${candidate.id}`;
        if (candidate.kind !== value.kind || seen.has(key))
          throw Error("Duplicate or invalid session setup contribution");
        seen.add(key);
      }
    resourceUniverse ??= structuredClone(
      values.filter((value) => value.kind !== "tools").flatMap((value) => value.candidates),
    );
    for (const value of values)
      if (value.kind !== "tools") {
        const registered = resourceUniverse.filter((candidate) => candidate.kind === value.kind);
        value.candidates =
          value.kind === "skills"
            ? registered.filter((candidate) =>
                value.candidates.some(
                  (current) => current.id === candidate.id && current.path === candidate.path,
                ),
              )
            : value.candidates.filter((candidate) =>
                registered.some(
                  (initial) => initial.id === candidate.id && initial.path === candidate.path,
                ),
              );
        value.selected = value.selected.filter((id) =>
          value.candidates.some((candidate) => candidate.id === id),
        );
      }
    return values;
  };
  const tools = (selected: string[]) => [
    ...new Set([
      ...selected,
      ...(pi
        .getAllTools()
        .some((tool) => tool.name === "session_setup" && tool.exposure !== "hidden")
        ? ["session_setup"]
        : []),
    ]),
  ];
  const setTools = (selected: string[]) => {
    const desired = tools(selected);
    pi.setActiveTools(desired);
    const active = new Set(pi.getActiveTools());
    const missing = desired.filter((name) => !active.has(name));
    if (missing.length) throw Error(`Native tool activation refused: ${missing.join(", ")}`);
  };
  const restore = (ctx: ExtensionContext, refreshUniverse = false, restoreTools = true) => {
    const currentSessionId = ctx.sessionManager.getSessionId();
    const switched = sessionId !== currentSessionId;
    if (switched) {
      sessionId = currentSessionId;
      baseTools = pi.getActiveTools();
      resourceUniverse = undefined;
    }
    if (refreshUniverse || switched) {
      resourceUniverse = undefined;
      initialized = false;
    }
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === SESSION_SETUP_STATE);
    try {
      if (!initialized) snapshotDefaults(ctx);
      const contributions = collect(ctx);
      let next: SessionSetupOverrides = {};
      let nextStates: ResourceStates = {};
      let restoredBase = baseTools;
      if (entry?.type === "custom") {
        const data = entry.data as {
          version?: number;
          overrides?: SessionSetupOverrides;
          states?: ResourceStates;
          baseTools?: string[];
        };
        if (
          ![1, 2].includes(data?.version ?? 0) ||
          !data.overrides ||
          typeof data.overrides !== "object" ||
          Array.isArray(data.overrides)
        )
          throw Error("Invalid session setup entry");
        // Missing resource providers/candidates are ignored until they are discovered again.
        // Tool overrides still validate against the actual native registry.
        const request = validateSessionSetupRequest({ ...data.overrides, op: "apply" });
        next = {};
        for (const kind of selections) if (request[kind] !== undefined) next[kind] = request[kind];
        if (next.tools) planSessionSetup({ op: "apply", tools: next.tools }, {}, contributions);
        for (const kind of resources) {
          const saved = data.states?.[kind];
          if (
            saved !== undefined &&
            (!saved ||
              typeof saved !== "object" ||
              Array.isArray(saved) ||
              Object.entries(saved).some(([id, value]) => !id.trim() || typeof value !== "boolean"))
          )
            throw Error("Invalid session resource override");
          if (saved) nextStates[kind] = structuredClone(saved);
        }
        // Earlier entries may also record session types; those are ignored.
        if (data.baseTools) restoredBase = ids(data.baseTools, "baseTools");
      }
      if (restoreTools) {
        setTools(restoredBase);
        setTools(next.tools ?? restoredBase);
      }
      baseTools = restoredBase;
      overrides = next;
      states = nextStates;
      for (const contribution of contributions)
        if (resources.includes(contribution.kind as SessionSetupResourceKind)) {
          const kind = contribution.kind as SessionSetupResourceKind;
          nativeDefaults[kind] = Object.fromEntries(
            contribution.candidates.map((candidate) => [
              candidate.id,
              candidate.nativeDefault ?? contribution.selected.includes(candidate.id),
            ]),
          );
        }
      initialized = true;
      resolveSelections();
      restoreError = undefined;
    } catch (error) {
      // Removed registrations cannot remain in the reset ceiling. Never add new tools here.
      const available = new Set(
        pi
          .getAllTools()
          .filter((tool) => tool.exposure !== "hidden")
          .map((tool) => tool.name),
      );
      baseTools = baseTools.filter((name) => available.has(name));
      // Invalid branch state must not widen back to saved defaults; reset remains available.
      overrides = { skills: [], agents: [], instructions: [], tools: [] };
      states = {};
      initialized = true;
      resolveSelections();
      pi.setActiveTools(["session_setup"]);
      restoreError = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI)
        ctx.ui.notify(
          `Session setup restore failed closed: ${restoreError}. Use session_setup reset.`,
          "warning",
        );
    }
  };
  // Native package discovery finishes in session_start before this resource boundary.
  pi.on("resources_discover", (_event, ctx) => restore(ctx, true));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  service = {
    version: 1,
    inspect: collect,
    restore,
    selection,
    state,
    setState(kind, id, chosen, ctx) {
      service.setStates(kind, { [id]: chosen }, ctx);
    },
    setStates(kind, chosen, ctx) {
      if (Object.values(chosen).some((value) => !["inherit", "on", "off"].includes(value)))
        throw Error("Invalid session selection state");
      const candidates = collect(ctx)
        .flatMap((value) => value.candidates)
        .filter((candidate) => candidate.kind === kind);
      const missing = Object.keys(chosen).filter(
        (id) => !candidates.some((candidate) => candidate.id === id),
      );
      if (missing.length) throw Error(`Unknown or unavailable ${kind} ID: ${missing.join(", ")}`);
      const next = structuredClone(states),
        nextOverrides = structuredClone(overrides);
      next[kind] ??= {};
      if (nextOverrides[kind] !== undefined) {
        for (const candidate of candidates)
          if (!Object.hasOwn(next[kind]!, candidate.id))
            next[kind]![candidate.id] = nextOverrides[kind]!.includes(candidate.id);
        delete nextOverrides[kind];
      }
      for (const [id, value] of Object.entries(chosen))
        if (value === "inherit") delete next[kind]![id];
        else next[kind]![id] = value === "on";
      persist(nextOverrides, next);
      overrides = nextOverrides;
      states = next;
      resolveSelections();
    },
    refresh(ctx) {
      restore(ctx, true, false);
    },
    execute(input: unknown, ctx: ExtensionContext) {
      const request = validateSessionSetupRequest(input),
        contributions = collect(ctx);
      if (request.op !== "list") {
        ids(baseTools, "baseTools");
        const next = planSessionSetup(request, {}, contributions),
          previousTools = pi.getActiveTools();
        // Planning validates this request; sparse picker overrides in untouched kinds remain intact.
        for (const kind of selections)
          if (request.op === "apply" && next[kind] === undefined && overrides[kind] !== undefined)
            next[kind] = overrides[kind];
        const nextStates = structuredClone(states);
        for (const kind of resources) {
          const reset =
            request.op === "reset" &&
            (!request.kinds || request.kinds.includes(kind) || request.kinds.includes("packages"));
          if (
            reset ||
            (request.op === "apply" &&
              (request[kind] !== undefined ||
                (request.packages !== undefined &&
                  contributions.some((value) => value.kind === kind))))
          )
            delete nextStates[kind];
          if (request.op === "reset" && !reset && overrides[kind] !== undefined)
            next[kind] = overrides[kind];
        }
        if (
          request.op === "reset" &&
          request.kinds &&
          !request.kinds.includes("tools") &&
          overrides.tools !== undefined
        )
          next.tools = overrides.tools;
        try {
          if (
            (request.op === "reset" && (!request.kinds || request.kinds.includes("tools"))) ||
            request.tools !== undefined
          )
            setTools(next.tools ?? baseTools);
          persist(next, nextStates);
          overrides = next;
          states = nextStates;
          resolveSelections();
          restoreError = undefined;
        } catch (error) {
          pi.setActiveTools(previousTools);
          throw error;
        }
      }
      const selected = Object.fromEntries(
        selections.map((kind) => [
          kind,
          kind === "tools" ? pi.getActiveTools() : (selection(kind) ?? []),
        ]),
      );
      const candidates = new ResourceSearch(
        contributions
          .flatMap((value) => value.candidates)
          .filter((candidate) => !request.kinds || request.kinds.includes(candidate.kind)),
      )
        .search(request.query ?? "")
        .map((candidate) => {
          if (candidate.kind === "skills") return candidate;
          const { path: _path, ...metadata } = candidate;
          return metadata;
        });
      return {
        op: request.op,
        selected: selected as Record<(typeof selections)[number], string[]>,
        overrides: structuredClone(overrides),
        ...(restoreError ? { error: restoreError } : {}),
        candidates: candidates.slice(0, request.limit ?? 20),
        total: candidates.length,
        effects: {
          tools:
            "Tool selection is immediate. If Pi's CLI filters reject a tool, the previous selection is restored. Permissions and deferred/codemode access are unchanged.",
          resources:
            "Skill commands and agent lookup change immediately; the parent prompt refreshes on the next run. Package selections replace skill, agent and instruction selections with public package members plus individual IDs in this request. Package selection leaves tools unchanged; a tools array in this request applies separately.",
          packages: `Select public resources from configured packages already loaded here. Available resource types: ${
            contributions
              .filter((value) => value.kind !== "packages" && value.kind !== "tools")
              .map((value) => value.kind)
              .join(", ") || "none"
          }. Unloaded extensions stay off. Native skills loaded with -e can be selected individually. For new packages, use pi install followed by idle /reload; executable extension changes or running children need a restart. This tool does not install or reload.`,
          children:
            "Existing children keep their launch settings. New children use saved personal/project skill and instruction choices plus their agent bundle. Temporary parent guidance selections are not inherited. Task tools still follow the parent active tool selection.",
        },
      };
    },
  };
  pi.registerTool({
    name: "session_setup",
    label: "Session setup",
    description:
      "List available resource IDs or apply/reset session-only selections. Omitted arrays stay unchanged; [] clears. Tools apply immediately; prompt content refreshes on the next parent run. Saved defaults, installed packages, permissions and existing children are unchanged. session_setup stays available for recovery.",
    parameters: Type.Object(
      {
        op: Type.Union([Type.Literal("list"), Type.Literal("apply"), Type.Literal("reset")]),
        query: Type.Optional(Type.String()),
        kinds: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal("packages"),
              Type.Literal("skills"),
              Type.Literal("agents"),
              Type.Literal("instructions"),
              Type.Literal("tools"),
            ]),
          ),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        packages: Type.Optional(Type.Array(Type.String())),
        skills: Type.Optional(Type.Array(Type.String())),
        agents: Type.Optional(Type.Array(Type.String())),
        instructions: Type.Optional(Type.Array(Type.String())),
        tools: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    async execute(_id, input, _signal, _update, ctx) {
      const result = service.execute(input, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  return service;
}
