import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_SERVICE,
  SESSION_SETUP_STATE,
  type SessionSetupCandidate,
  type SessionSetupContribution,
  type SessionSetupOverrides,
  type SessionSetupRequest,
  type SessionSetupService,
} from "pi-contracts";
import { ResourceSearch } from "pi-resource-browser/search";
import { Type } from "typebox";

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
} from "pi-contracts";

const kinds = ["packages", "skills", "agents", "instructions", "tools"] as const;
const selections = ["skills", "agents", "instructions", "tools"] as const;
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
    if (missing.length)
      throw Error(
        `Unknown or unavailable ${kind} IDs: ${missing.join(", ")}${
          kind === "packages"
            ? ". Use a native package name already loaded in this session. New package groups need pi install then reload/start; -e can add native resources for a new invocation. Ordinary changes require idle /reload, security/runtime changes or running children require a staged restart. No selection was changed."
            : ""
        }`,
      );
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
  let service: SessionSetupService;
  const selection = (kind: (typeof selections)[number]) =>
    overrides[kind] === undefined ? undefined : [...overrides[kind]!];
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
  const restore = (ctx: ExtensionContext, refreshUniverse = false, captureDefaults = false) => {
    const currentSessionId = ctx.sessionManager.getSessionId();
    if (sessionId !== currentSessionId) {
      sessionId = currentSessionId;
      baseTools = pi.getActiveTools();
      resourceUniverse = undefined;
    }
    if (refreshUniverse) resourceUniverse = undefined;
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === SESSION_SETUP_STATE);
    try {
      const contributions = collect(ctx);
      let next: SessionSetupOverrides = {};
      let restoredBase = baseTools;
      if (entry?.type === "custom") {
        const data = entry.data as {
          version?: number;
          overrides?: SessionSetupOverrides;
          baseTools?: string[];
        };
        if (
          data?.version !== 1 ||
          !data.overrides ||
          typeof data.overrides !== "object" ||
          Array.isArray(data.overrides) ||
          Object.keys(data.overrides).some(
            (key) => !selections.includes(key as (typeof selections)[number]),
          )
        )
          throw Error("Invalid session setup entry");
        next = planSessionSetup(
          validateSessionSetupRequest({ ...data.overrides, op: "apply" }),
          {},
          contributions,
        );
        if (data.baseTools) restoredBase = ids(data.baseTools, "baseTools");
      }
      if (!entry && captureDefaults) {
        for (const kind of ["skills", "agents", "instructions"] as const)
          next[kind] = contributions
            .filter((value) => value.kind === kind)
            .flatMap((value) => value.selected);
        next = planSessionSetup({ op: "apply", ...next }, {}, contributions);
        // Save resource choices at session birth; later personal defaults must not rewrite a resumed session.
        pi.appendEntry(SESSION_SETUP_STATE, {
          version: 1,
          overrides: next,
          baseTools: restoredBase,
        });
      }
      setTools(restoredBase);
      setTools(next.tools ?? restoredBase);
      baseTools = restoredBase;
      overrides = next;
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
  pi.on("resources_discover", (_event, ctx) => restore(ctx, true, true));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  service = {
    version: 1,
    inspect: collect,
    restore,
    selection,
    execute(input: unknown, ctx: ExtensionContext) {
      const request = validateSessionSetupRequest(input),
        contributions = collect(ctx);
      if (request.op !== "list") {
        ids(baseTools, "baseTools");
        const next = planSessionSetup(request, overrides, contributions),
          previousTools = pi.getActiveTools();
        try {
          if (
            (request.op === "reset" && (!request.kinds || request.kinds.includes("tools"))) ||
            request.tools !== undefined
          )
            setTools(next.tools ?? baseTools);
          pi.appendEntry(SESSION_SETUP_STATE, { version: 1, overrides: next, baseTools });
          overrides = next;
          restoreError = undefined;
        } catch (error) {
          pi.setActiveTools(previousTools);
          throw error;
        }
      }
      const selected = Object.fromEntries(
        selections.map((kind) => [
          kind,
          kind === "tools"
            ? pi.getActiveTools()
            : (overrides[kind] ??
              contributions
                .filter((value) => value.kind === kind)
                .flatMap((value) => value.selected)),
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
            "Native active-tool selection applies immediately; CLI activation eligibility is checked on apply, with atomic rollback if native filters refuse names. Security and deferred/codemode callability are unchanged.",
          resources:
            "Public skill/manual invocation and agent lookup change immediately. Skill descriptions and selected instructions in parent prompts refresh only on the next submitted parent run. Package selections replace skills/agents/instructions with public members plus explicit same-call IDs; tools are unchanged by packages.",
          packages: `Only already-loaded native package resources are selected, through registered resource kinds: ${
            contributions
              .filter((value) => value.kind !== "packages" && value.kind !== "tools")
              .map((value) => value.kind)
              .join(", ") || "none"
          }. Missing providers are not activated and their content is not selected. Package groups require configured native sources; -e native skills remain individually selectable. New packages use pi install. Ordinary executable changes require idle /reload; security/runtime replacement or running children require a staged restart. No installation or reload occurs in this tool.`,
          children:
            "Existing prepared children are unchanged. New child roles/private skills use the current lookup; inherited selected instructions remain the current parent-run snapshot until the next parent run.",
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
