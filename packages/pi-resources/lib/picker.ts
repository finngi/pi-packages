import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResourceEntry, ResourceDefaultState, ResourceSessionMode } from "pi-resource-browser";
import {
  writeResourceDefaults,
  writeResourceMode,
  type ResourceKind,
} from "./resource-selection.ts";
import type { installSessionSetup } from "./session-setup.ts";

export interface PickerMember {
  kind: ResourceKind;
  id: string;
  nativeDefault?: boolean;
  globalDefaultable?: boolean;
}

/** One scope implementation for independent resources and package availability. */
export function resourcePickerControls(options: {
  ctx: ExtensionCommandContext;
  setup: ReturnType<typeof installSessionSetup>;
  entries: ResourceEntry[];
  members(entry: ResourceEntry): PickerMember[];
}) {
  const { ctx, setup, entries, members } = options;
  const aggregate = <T>(values: T[], mixed: T): T =>
    values.length > 0 && values.every((value) => value === values[0]) ? values[0]! : mixed;
  const refresh = () => {
    for (const entry of entries) {
      const states = members(entry).map((member) =>
        setup.state(member.kind, member.id, member.nativeDefault),
      );
      entry.selected = states.length > 0 && states.every((state) => state.selected);
      if (states.length > 1)
        entry.badge =
          states.some((state) => state.selected) && !entry.selected ? "partial" : undefined;
      entry.sessionState = aggregate(
        states.map((state) => state.sessionState),
        "mixed",
      );
      entry.projectState = aggregate(
        states.map((state) => state.projectState),
        "mixed",
      );
      entry.globalState = aggregate(
        states.map((state) => state.globalState),
        "mixed",
      );
      entry.sessionMode = aggregate(
        states.map((state) => state.sessionMode),
        "mixed",
      );
      entry.projectMode = aggregate(
        states.map((state) => state.projectMode),
        "mixed",
      );
      entry.globalMode = aggregate(
        states.map((state) => state.globalMode),
        "mixed",
      );
      entry.effectiveSource = aggregate(
        states.map((state) => state.effectiveSource),
        undefined,
      );
      entry.mode = aggregate(
        states.map((state) => state.mode),
        undefined,
      );
      entry.modeSource = aggregate(
        states.map((state) => state.modeSource),
        undefined,
      );
    }
  };
  const eligible = (entry: ResourceEntry, scope: "project" | "global") => {
    if (entry.defaultable === false || (scope === "global" && entry.globalDefaultable === false))
      throw Error("This resource cannot be saved at that scope");
    if (scope === "project" && !ctx.isProjectTrusted())
      throw Error("Saving defaults requires a trusted project");
    return members(entry).filter(
      (member) => scope !== "global" || member.globalDefaultable !== false,
    );
  };
  const saved = async (
    scope: "project" | "global",
    rows: ResourceEntry[],
    state?: ResourceDefaultState,
  ) => {
    if (scope === "project" && !ctx.isProjectTrusted())
      throw Error("Saving defaults requires a trusted project");
    const selections: Parameters<typeof writeResourceDefaults>[0]["selections"] = {};
    const targets = rows.flatMap((entry) => eligible(entry, scope));
    for (const member of targets) {
      const selection = (selections[member.kind] ??= {
        knownIds: [],
        values: {},
        ...(state === undefined ? { modes: {} } : {}),
      });
      selection.knownIds.push(member.id);
      selection.values[member.id] =
        state === undefined
          ? setup.state(member.kind, member.id, member.nativeDefault).selected
          : state === "inherit"
            ? undefined
            : state === "on";
      if (selection.modes)
        selection.modes[member.id] = setup.state(member.kind, member.id, member.nativeDefault).mode;
    }
    await writeResourceDefaults({ scope, selections, cwd: ctx.cwd, agentDir: getAgentDir() });
    await setup.refresh(ctx);
    refresh();
  };
  refresh();
  return {
    refresh,
    toggle: async (entry: ResourceEntry, selected: boolean) => {
      for (const member of members(entry))
        setup.setState(member.kind, member.id, selected ? "on" : "off", ctx);
      refresh();
    },
    setSession: async (entry: ResourceEntry, state: ResourceDefaultState) => {
      for (const member of members(entry)) setup.setState(member.kind, member.id, state, ctx);
      refresh();
    },
    setDefault: (entry: ResourceEntry, state: ResourceDefaultState, scope: "project" | "global") =>
      saved(scope, [entry], state),
    setMode: async (
      entry: ResourceEntry,
      mode: ResourceSessionMode,
      scope: "session" | "project" | "global",
    ) => {
      for (const member of scope === "session" ? members(entry) : eligible(entry, scope)) {
        if (scope === "session") setup.setMode(member.kind, member.id, mode, ctx);
        else
          await writeResourceMode({
            scope,
            kind: member.kind,
            id: member.id,
            mode,
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
          });
      }
      if (scope !== "session") await setup.refresh(ctx);
      refresh();
    },
    saveDefaults: (rows: ResourceEntry[]) => saved("project", rows),
    saveGlobalDefaults: (rows: ResourceEntry[]) => saved("global", rows),
  };
}
