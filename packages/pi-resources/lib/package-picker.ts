import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionSetupCandidate } from "pi-contracts";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
  type ResourceEntry,
} from "pi-resource-browser";
import {
  readResourceSelection,
  resolveResourceSelection,
  writeResourceDefaults,
  type ResourceDefaultState,
  type ResourceKind,
  type installSessionSetup,
} from "pi-runtime";

const kinds = ["skills", "agents", "instructions"] as const;
type Selection = Record<ResourceKind, string[]>;
const aggregate = <T>(values: T[], mixed: T): T =>
  values.length && values.every((value) => value === values[0]) ? values[0] : mixed;

export function registerPackagePicker(
  pi: ExtensionAPI,
  setup: ReturnType<typeof installSessionSetup>,
  diagnostics: () => string[],
  skillPaths: (names: string[]) => string[],
) {
  pi.registerCommand("packages", {
    description:
      "Select package guidance for this session; save project or personal defaults explicitly",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const inspect = () => setup.inspect(ctx);
      const selected = (): Selection => setup.execute({ op: "list" }, ctx).selected as Selection;
      const contributions = inspect();
      const candidates = contributions
        .flatMap((value) => value.candidates)
        .filter((candidate) => kinds.includes(candidate.kind as ResourceKind));
      const members = (id: string) => candidates.filter((candidate) => candidate.packName === id);
      const supported = (selection: Selection) =>
        Object.fromEntries(
          kinds
            .filter((kind) => contributions.some((value) => value.kind === kind))
            .map((kind) => [kind, selection[kind]]),
        );
      const manager = () =>
        SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      const resolved = (candidate: SessionSetupCandidate, settings: SettingsManager) =>
        resolveResourceSelection(
          readResourceSelection(settings, "global", candidate.kind as ResourceKind),
          readResourceSelection(settings, "project", candidate.kind as ResourceKind),
          candidate.id,
          candidate.nativeDefault ?? false,
        );
      const entries: ResourceEntry[] = contributions
        .filter((value) => value.kind === "packages")
        .flatMap((value) => value.candidates)
        .map((pack) => ({
          id: pack.id,
          name: pack.name.replace(/^@[^/]+\/pi-/, ""),
          description: pack.description,
          keywords: pack.keywords,
          selected: false,
          toggleable: members(pack.id).length > 0,
          globalDefaultable:
            members(pack.id).length > 0 &&
            members(pack.id).every((member) => member.globalDefaultable !== false),
          preview: async () => ({
            fields: [
              { label: "Package", value: pack.id },
              ...kinds.map((kind) => ({
                label: kind[0].toUpperCase() + kind.slice(1),
                value:
                  members(pack.id)
                    .filter((candidate) => candidate.kind === kind)
                    .map((candidate) => candidate.name)
                    .join(", ") || "none",
              })),
            ],
          }),
        }));
      const refresh = () => {
        const settings = manager(),
          current = selected();
        for (const entry of entries) {
          const grouped = members(entry.id),
            states = grouped.map((candidate) => resolved(candidate, settings));
          const count = grouped.filter((candidate) =>
            current[candidate.kind as ResourceKind].includes(candidate.id),
          ).length;
          entry.selected = grouped.length > 0 && count === grouped.length;
          entry.badge = count > 0 && count < grouped.length ? "partial" : undefined;
          entry.projectState = aggregate(
            states.map((value) => value.projectState),
            "mixed" as ResourceDefaultState | "mixed",
          );
          entry.globalState = aggregate(
            states.map((value) => value.globalState),
            "mixed" as ResourceDefaultState | "mixed",
          );
          entry.defaultSelected = aggregate<boolean | undefined>(
            states.map((value) => value.effective),
            undefined,
          );
          entry.globalDefaultSelected = aggregate<boolean | undefined>(
            grouped.map(
              (candidate) =>
                resolveResourceSelection(
                  readResourceSelection(settings, "global", candidate.kind as ResourceKind),
                  undefined,
                  candidate.id,
                  candidate.nativeDefault ?? false,
                ).effective,
            ),
            undefined,
          );
        }
      };
      const save = async (
        scope: "project" | "global",
        state?: { id: string; value: ResourceDefaultState },
        saved?: ResourceEntry[],
      ) => {
        if (scope === "project" && !ctx.isProjectTrusted())
          throw Error("Saving package defaults requires a trusted project");
        const current = selected(),
          settings = manager();
        const changes = Object.fromEntries(
          kinds
            .filter((kind) => contributions.some((value) => value.kind === kind))
            .map((kind) => {
              const known = candidates.filter((candidate) => candidate.kind === kind);
              const eligible = known.filter(
                (candidate) =>
                  (scope !== "global" || candidate.globalDefaultable !== false) &&
                  (state !== undefined ||
                    saved === undefined ||
                    !candidate.packName ||
                    saved.some((entry) => entry.id === candidate.packName)),
              );
              const targets = state
                ? eligible.filter((candidate) => candidate.packName === state.id)
                : eligible;
              return [
                kind,
                {
                  snapshot: !state,
                  knownIds: known.map((candidate) => candidate.id),
                  values: Object.fromEntries(
                    targets.map((candidate) => [
                      candidate.id,
                      state
                        ? state.value === "inherit"
                          ? undefined
                          : state.value === "on"
                        : current[kind].includes(candidate.id),
                    ]),
                  ),
                  nativeDefaults: Object.fromEntries(
                    known.map((candidate) => [candidate.id, candidate.nativeDefault ?? false]),
                  ),
                  fallbackValues: Object.fromEntries(
                    known.map((candidate) => [
                      candidate.id,
                      resolveResourceSelection(
                        readResourceSelection(settings, "global", kind),
                        undefined,
                        candidate.id,
                        candidate.nativeDefault ?? false,
                      ).effective,
                    ]),
                  ),
                  ...(kind === "skills"
                    ? {
                        skillPaths: Object.fromEntries(
                          eligible.flatMap((candidate) =>
                            skillPaths([candidate.id]).map((path) => [candidate.id, path]),
                          ),
                        ),
                      }
                    : {}),
                },
              ];
            }),
        );
        await writeResourceDefaults({
          scope,
          selections: changes,
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
        });
        refresh();
      };
      refresh();
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Use session_setup to select package guidance in a headless session.",
          "info",
        );
        return;
      }
      await showResourceBrowser(ctx, {
        title: "Packages",
        ...resourceBrowserNavigation(pi, "packages"),
        entries,
        selectionScope: "session",
        defaultsScope: "project",
        notice: diagnostics().join("\n") || undefined,
        toggle: async (entry, enabled) => {
          const next = selected(),
            grouped = members(entry.id);
          for (const kind of kinds) {
            const ids = new Set(
              grouped
                .filter((candidate) => candidate.kind === kind)
                .map((candidate) => candidate.id),
            );
            next[kind] = enabled
              ? [...new Set([...next[kind], ...ids])]
              : next[kind].filter((id) => !ids.has(id));
          }
          setup.execute({ op: "apply", ...supported(next) }, ctx);
          refresh();
        },
        setDefault: async (entry, state, scope) => save(scope, { id: entry.id, value: state }),
        saveDefaults: async (saved) => save("project", undefined, saved),
        saveGlobalDefaults: async (saved) => save("global", undefined, saved),
      });
    },
  });
}
