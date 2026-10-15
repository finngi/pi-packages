import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionSetupContribution } from "pi-contracts";
import type { installSessionSetup } from "pi-runtime";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
  type ResourceEntry,
} from "./resource-browser.ts";
import {
  assertSafeProjectSettingsLocation,
  writeProjectResourceSelection,
  writeGlobalResourceDefaults,
} from "./resource-selection.ts";

const kinds = ["skills", "agents", "instructions"] as const;
type Selection = Record<(typeof kinds)[number], string[]>;

export function registerPackagePicker(
  pi: ExtensionAPI,
  setup: ReturnType<typeof installSessionSetup>,
  diagnostics: () => string[],
  skillPaths: (names: string[]) => string[],
  saved: (ctx: ExtensionContext) => void,
) {
  pi.registerCommand("packages", {
    description:
      "Select loaded package guidance for this session; Ctrl+S saves project defaults; Ctrl+Shift+S saves personal defaults",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const inspect = () => setup.inspect(ctx);
      const selected = (): Selection => setup.execute({ op: "list" }, ctx).selected as Selection;
      const members = (contributions: SessionSetupContribution[], id: string) =>
        Object.fromEntries(
          kinds.map((kind) => [
            kind,
            contributions
              .filter((value) => value.kind === kind)
              .flatMap((value) => value.candidates)
              .filter((candidate) => candidate.packName === id)
              .map((candidate) => candidate.id),
          ]),
        ) as Selection;
      const contributions = inspect();
      const current = selected();
      const project = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      }).getProjectSettings() as {
        subagents?: { skills?: string[]; agents?: string[] };
        localContext?: { instructions?: string[] };
      };
      const personal = SettingsManager.create(
        ctx.cwd,
        getAgentDir(),
      ).getGlobalSettings() as typeof project;
      const globalDefaults = {
        skills: personal.subagents?.skills ?? [],
        agents: personal.subagents?.agents ?? [],
        instructions: personal.localContext?.instructions ?? [],
      };
      const defaults = {
        skills: project.subagents?.skills ?? globalDefaults.skills,
        agents: project.subagents?.agents ?? globalDefaults.agents,
        instructions: project.localContext?.instructions ?? globalDefaults.instructions,
      };
      const entries: ResourceEntry[] = contributions
        .filter((value) => value.kind === "packages")
        .flatMap((value) => value.candidates)
        .map((pack) => {
          const grouped = members(contributions, pack.id);
          const total = kinds.reduce((sum, kind) => sum + grouped[kind].length, 0);
          const count = kinds.reduce(
            (sum, kind) => sum + grouped[kind].filter((id) => current[kind].includes(id)).length,
            0,
          );
          return {
            id: pack.id,
            name: pack.name.replace(/^@[^/]+\/pi-/, ""),
            description: pack.description,
            keywords: pack.keywords,
            selected: total > 0 && count === total,
            defaultSelected:
              total > 0 &&
              kinds.every((kind) => grouped[kind].every((id) => defaults[kind].includes(id))),
            globalDefaultSelected:
              total > 0 &&
              kinds.every((kind) => grouped[kind].every((id) => globalDefaults[kind].includes(id))),
            globalDefaultable: pack.globalDefaultable,
            toggleable: total > 0,
            badge: count > 0 && count < total ? "partial" : undefined,
            preview: async () => ({
              fields: [
                { label: "Package", value: pack.id },
                ...kinds.map((kind) => ({
                  label: kind[0].toUpperCase() + kind.slice(1),
                  value:
                    contributions
                      .filter((value) => value.kind === kind)
                      .flatMap((value) => value.candidates)
                      .filter((candidate) => grouped[kind].includes(candidate.id))
                      .map((candidate) => candidate.name)
                      .join(", ") || "none",
                })),
              ],
            }),
          };
        });
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
          const current = selected(),
            grouped = members(inspect(), entry.id);
          const next = Object.fromEntries(
            kinds.map((kind) => [
              kind,
              enabled
                ? [...new Set([...current[kind], ...grouped[kind]])]
                : current[kind].filter((id) => !grouped[kind].includes(id)),
            ]),
          ) as Selection;
          setup.execute({ op: "apply", ...next }, ctx);
          entry.badge = undefined;
        },
        setDefault: async (entry, enabled, scope) => {
          const current = selected();
          const latest = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
          });
          const global = latest.getGlobalSettings() as typeof project;
          const local = latest.getProjectSettings() as typeof project;
          const globalSets = {
            skills: global.subagents?.skills ?? [],
            agents: global.subagents?.agents ?? [],
            instructions: global.localContext?.instructions ?? [],
          };
          const localSets = {
            skills: local.subagents?.skills,
            agents: local.subagents?.agents,
            instructions: local.localContext?.instructions,
          };
          const grouped = members(inspect(), entry.id);
          const next = Object.fromEntries(
            kinds.map((kind) => {
              const names = new Set(
                scope === "global" ? globalSets[kind] : (localSets[kind] ?? globalSets[kind]),
              );
              for (const id of grouped[kind]) {
                if (enabled) names.add(id);
                else names.delete(id);
              }
              return [kind, [...names].sort()];
            }),
          ) as Selection;
          if (scope === "global") await writeGlobalResourceDefaults(getAgentDir(), next);
          else {
            if (!ctx.isProjectTrusted())
              throw Error("Saving package defaults requires a trusted project");
            await assertSafeProjectSettingsLocation(ctx.cwd);
            await writeProjectResourceSelection(ctx.cwd, next, skillPaths(next.skills));
            saved(ctx);
          }
          setup.execute({ op: "apply", ...current }, ctx);
        },
        saveGlobalDefaults: async () => {
          const available = inspect(),
            current = selected();
          const personal = Object.fromEntries(
            kinds.map((kind) => [
              kind,
              current[kind].filter((id) =>
                available.some(
                  (value) =>
                    value.kind === kind &&
                    value.candidates.some(
                      (candidate) => candidate.id === id && candidate.globalDefaultable !== false,
                    ),
                ),
              ),
            ]),
          ) as Selection;
          await writeGlobalResourceDefaults(getAgentDir(), personal);
          const skipped = kinds.reduce(
            (sum, kind) => sum + current[kind].length - personal[kind].length,
            0,
          );
          if (skipped)
            ctx.ui.notify(
              `${skipped} project-only resources kept in this session; excluded from personal defaults.`,
              "info",
            );
        },
        saveDefaults: async () => {
          if (!ctx.isProjectTrusted())
            throw Error("Saving package defaults requires a trusted project");
          await assertSafeProjectSettingsLocation(ctx.cwd);
          const next = selected();
          await writeProjectResourceSelection(ctx.cwd, next, skillPaths(next.skills));
          saved(ctx);
        },
      });
      // Session setup rebuilds prompt guidance on the next run; reloading would stop owned children.
    },
  });
}
