import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SESSION_SETUP_CONTRIBUTIONS, type SessionSetupContributionRequest } from "pi-contracts";
import { showResourceBrowser, resourceBrowserNavigation } from "pi-resource-browser";
import {
  assertSafeProjectSettingsLocation,
  configuredSkillChoices,
  discoverResourcePackages,
  filterPromptSkills,
  type GlobalSelectionSnapshot,
  installSessionSetup,
  type ResourcePackage,
  resourcePackageKeywords,
  selectedSkills,
  type SkillChoice,
  writeGlobalResourceSelection,
  writeProjectSkillSelection,
} from "pi-runtime";
import { registerPackagePicker } from "../lib/package-picker.ts";

/** Session-only selection of native loaded resources. Importing shared helpers has no effect. */
export default function (pi: ExtensionAPI) {
  // Children already receive an explicit public/private skill set from their launcher.
  if (process.env.PI_SUBAGENT === "1") return;
  const setup = installSessionSetup(pi);
  let packageResources: { packs: ResourcePackage[]; problems: string[] } = {
    packs: [],
    problems: [],
  };
  let nativeSkillDefaults: Set<string> | undefined;
  let skillChoicesSnapshot: SkillChoice[] = [],
    metadataRegistered = false;
  let skillIdentities = new Map<string, { dev: number; ino: number }>();
  let skillDefaultsSnapshot: GlobalSelectionSnapshot = { present: false };
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
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
  const personalSkillDefault = (skill: SkillChoice) => {
    // Native project/CLI selection can expose a member excluded by the personal package filters.
    if (
      skill.defaultSelected &&
      skills().find((loaded) => loaded.name === skill.name)?.source.scope !== "user"
    )
      return false;
    const pack = packageResources.packs.find((pack) => pack.name === skill.packName);
    return pack?.globalDefaultable !== false;
  };
  const settingsManager = (ctx: ExtensionContext) =>
    SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  const refreshDefaultSnapshots = (ctx: ExtensionContext) => {
    const global = settingsManager(ctx).getGlobalSettings() as {
      subagents?: { agents?: string[]; skills?: string[] };
    };
    skillDefaultsSnapshot = {
      present: Object.hasOwn(global.subagents ?? {}, "skills"),
      names: global.subagents?.skills,
    };
  };
  const selectedPublicSkills = (ctx: ExtensionContext) => {
    const manager = settingsManager(ctx);
    const choices = currentSkillChoices(ctx);
    const selected = setup.selection("skills");
    if (selected !== undefined) {
      const missing = selected.filter((name) => !choices.some((choice) => choice.name === name));
      if (missing.length)
        throw Error(
          `Selected skills are no longer registered or unchanged: ${missing.join(", ")}. Reload resources.`,
        );
      return choices.filter((choice) => selected.includes(choice.name));
    }
    return selectedSkills(manager, choices, false, skillDefaultsSnapshot);
  };
  const currentSkillChoices = (ctx: ExtensionContext) => {
    const registered = skills();
    return skillChoicesSnapshot.filter((choice) => {
      try {
        if (
          metadataRegistered &&
          !registered.some(
            (skill) =>
              skill.name === choice.name &&
              resolve(ctx.cwd, skill.path) === resolve(ctx.cwd, choice.path),
          )
        )
          return false;
        const info = statSync(choice.path),
          identity = skillIdentities.get(choice.path);
        if (!identity || !info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino)
          return false;
        const actual = loadSkills({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          skillPaths: [choice.path],
          includeDefaults: false,
        }).skills;
        return actual.some((skill) => skill.name === choice.name && skill.filePath === choice.path);
      } catch {
        return false;
      }
    });
  };
  pi.on("session_start", async (_input, ctx) => {
    packageResources = await discoverResourcePackages(
      settingsManager(ctx),
      ctx.cwd,
      getAgentDir(),
      skills().map((skill) => skill.source),
    );
    // Native resources are loaded before resources_discover; catalogue registration must not widen defaults.
    nativeSkillDefaults = new Set(skills().map((skill) => resolve(ctx.cwd, skill.path)));
    metadataRegistered = false;
    skillChoicesSnapshot = configuredSkillChoices(
      settingsManager(ctx),
      ctx.cwd,
      getAgentDir(),
      skills().map((skill) => ({ name: skill.name, path: skill.path })),
      false,
      nativeSkillDefaults,
      packageResources.packs,
    );
    skillIdentities = new Map(
      skillChoicesSnapshot.map((skill) => {
        const { dev, ino } = statSync(skill.path);
        return [skill.path, { dev, ino }];
      }),
    );
    refreshDefaultSnapshots(ctx);
  });
  pi.on("resources_discover", (_input, ctx) => {
    try {
      const choices = currentSkillChoices(ctx);
      metadataRegistered = true;
      return { skillPaths: choices.map((skill) => skill.path) };
    } catch (error) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Could not load selected skills; inspect /skills before continuing. (${errorText(error)})`,
          "warning",
        );
      return { skillPaths: [] };
    }
  });
  pi.on("input", (event, ctx) => {
    const match = /^\/skill:([^\s]+)(?:\s|$)/.exec(event.text);
    if (!match) return;
    try {
      const selected = new Set(selectedPublicSkills(ctx).map((skill) => skill.name));
      if (selected.has(match[1]!)) return;
      ctx.ui.notify(
        `Skill "${match[1]}" is not selected for this session. Use /skills to choose it.`,
        "warning",
      );
      return { action: "handled" as const };
    } catch (error) {
      ctx.ui.notify(
        `Could not validate skill selection: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return { action: "handled" as const };
    }
  });
  pi.on("before_agent_start", (input, ctx) => {
    try {
      input.systemPromptOptions.skills = filterPromptSkills(
        input.systemPromptOptions.skills ?? [],
        selectedPublicSkills(ctx),
      );
    } catch (error) {
      input.systemPromptOptions.skills = [];
      if (ctx.hasUI)
        ctx.ui.notify(
          `Could not validate selected skills; no skills were added to the prompt. Run /skills to inspect settings. (${errorText(error)})`,
          "warning",
        );
    }
  });
  pi.events.on(SESSION_SETUP_CONTRIBUTIONS, (value: unknown) => {
    const request = value as SessionSetupContributionRequest;
    if (request?.version !== 1 || typeof request.contribute !== "function") return;
    const ctx = request.ctx,
      manager = settingsManager(ctx);
    const choices = currentSkillChoices(ctx);
    let selectedSkillIds: string[] = [];
    try {
      selectedSkillIds = selectedSkills(manager, choices, false, skillDefaultsSnapshot).map(
        (skill) => skill.name,
      );
    } catch {}
    request.contribute({
      kind: "skills",
      candidates: choices.map((skill) => ({
        kind: "skills",
        id: skill.name,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        globalDefaultable: personalSkillDefault(skill),
        ...(skill.manualOnly ? { manualOnly: true } : {}),
        ...(skill.packName ? { packName: skill.packName, keywords: skill.packKeywords } : {}),
      })),
      selected: selectedSkillIds,
    });
    request.contribute({
      kind: "packages",
      candidates: packageResources.packs.map((pack) => ({
        kind: "packages",
        id: pack.name,
        name: pack.name,
        description: pack.description,
        keywords: resourcePackageKeywords(pack),
        globalDefaultable: pack.globalDefaultable,
      })),
      selected: [],
    });
  });
  const persistSkillSelection = async (
    ctx: ExtensionCommandContext,
    selected: ReturnType<typeof selectedSkills>,
  ) => {
    if (!ctx.isProjectTrusted())
      throw Error("Project resource selection requires a trusted project");
    await ctx.waitForIdle();
    await assertSafeProjectSettingsLocation(ctx.cwd);
    await writeProjectSkillSelection(
      ctx.cwd,
      selected.filter((skill) => !skill.defaultSelected).map((skill) => skill.path),
      selected.map((skill) => skill.name),
    );
  };
  const changeSavedDefault = async (
    ctx: ExtensionCommandContext,
    kind: "skills",
    id: string,
    enabled: boolean,
    scope: "project" | "global",
    choices: SkillChoice[] = [],
  ) => {
    const current = (setup.execute({ op: "list" }, ctx).selected as Record<string, string[]>)[kind];
    const latest = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const global =
      (latest.getGlobalSettings() as { subagents?: { agents?: string[]; skills?: string[] } })
        .subagents ?? {};
    const project =
      (latest.getProjectSettings() as { subagents?: { agents?: string[]; skills?: string[] } })
        .subagents ?? {};
    const names = new Set(
      scope === "global" ? (global[kind] ?? []) : (project[kind] ?? global[kind] ?? []),
    );
    if (enabled) names.add(id);
    else names.delete(id);
    if (scope === "global")
      await writeGlobalResourceSelection(getAgentDir(), kind, [...names].sort());
    else
      await persistSkillSelection(
        ctx,
        choices.filter((choice) => names.has(choice.name)),
      );
    setup.execute({ op: "apply", [kind]: current }, ctx);
  };
  const currentSkillChoicesForPackages = (names: string[]) =>
    skillChoicesSnapshot
      .filter((skill) => names.includes(skill.name) && !skill.defaultSelected)
      .map((skill) => skill.path);
  registerPackagePicker(
    pi,
    setup,
    () => packageResources.problems,
    (names) => currentSkillChoicesForPackages(names),
  );
  const selectionArgs = (args: string) => {
    const match = /^(enable|disable|none|all|inherit|inspect)(?:\s+(.+))?$/.exec(args.trim());
    return match ? { action: match[1], name: match[2]?.trim() } : undefined;
  };
  pi.registerCommand("skills", {
    description:
      "Select skills for this session; Ctrl+S saves project defaults; Ctrl+Shift+S saves personal defaults",
    async handler(args, ctx) {
      const command = args.trim();
      const action = selectionArgs(command);
      const repairingInvalidProjectSelection =
        action?.action === "none" || action?.action === "all" || action?.action === "inherit";
      const manager = settingsManager(ctx);
      const loaded = skills().map((skill) => ({ name: skill.name, path: skill.path }));
      const choices = configuredSkillChoices(
        manager,
        ctx.cwd,
        getAgentDir(),
        loaded,
        repairingInvalidProjectSelection,
        nativeSkillDefaults,
        packageResources.packs,
      );
      const selected = selectedSkills(
        manager,
        choices,
        repairingInvalidProjectSelection,
        skillDefaultsSnapshot,
      );
      const selectedNames = new Set(
        setup.selection("skills") ?? selected.map((skill) => skill.name),
      );
      const skillDefaults =
        (manager.getProjectSettings() as { subagents?: { skills?: string[] } }).subagents?.skills ??
        [];
      if (action) {
        let next = new Map(
          choices
            .filter((skill) => selectedNames.has(skill.name) && skill.toggleable)
            .map((skill) => [skill.name, skill]),
        );
        if (action.action === "none") next.clear();
        else if (action.action === "all")
          next = new Map(
            choices.filter((skill) => skill.toggleable).map((skill) => [skill.name, skill]),
          );
        else if (action.action === "inherit") {
          setup.execute({ op: "reset", kinds: ["skills"] }, ctx);
          return;
        } else if (action.action === "enable" || action.action === "disable") {
          const choice = choices.find((skill) => skill.name === action.name && skill.toggleable);
          if (!choice) throw Error(`Unknown selectable public skill "${action.name ?? ""}"`);
          if (action.action === "enable") next.set(choice.name, choice);
          else next.delete(choice.name);
        } else if (action.action === "inspect" && !action.name) {
          throw Error("Use /skills inspect NAME");
        } else if (action.action !== "inspect") {
          throw Error(`Unsupported skill selection command: ${action.action}`);
        }
        if (action.action !== "inspect") {
          setup.execute({ op: "apply", skills: [...next.keys()] }, ctx);
          return;
        }
      }
      let inspectName = action?.action === "inspect" ? action.name : undefined;
      if (!action && command) inspectName = command;
      if (!inspectName && !action && ctx.hasUI && choices.length) {
        await showResourceBrowser(ctx, {
          title: "Skills",
          ...resourceBrowserNavigation(pi, "skills"),
          selectionScope: "session",
          defaultsScope: "project",
          defaultsInherited: !Object.hasOwn(
            (manager.getProjectSettings() as { subagents?: { skills?: string[] } }).subagents ?? {},
            "skills",
          ),
          entries: choices.map((skill) => ({
            id: skill.name,
            name: skill.name,
            description: skill.description,
            keywords: `${skill.manualOnly ? "manual command" : "model skill"} ${skill.packKeywords ?? ""}`,
            selected: selectedNames.has(skill.name),
            defaultSelected: skillDefaults.includes(skill.name),
            globalDefaultSelected: (
              (manager.getGlobalSettings() as { subagents?: { skills?: string[] } }).subagents
                ?.skills ?? []
            ).includes(skill.name),
            globalDefaultable: personalSkillDefault(skill),
            toggleable: skill.toggleable,
            badge: skill.packName ?? (skill.manualOnly ? "manual" : undefined),
            preview: async () => {
              const { body, frontmatter } = parseFrontmatter(await readFile(skill.path, "utf8"));
              const invocation =
                frontmatter["disable-model-invocation"] === true
                  ? "Manual command only"
                  : "Description advertised when selected";
              return {
                fields: [{ label: "Invocation", value: invocation }],
                source: skill.path,
                body,
              };
            },
          })),
          toggle: async (entry, enabled) => {
            const next = new Set(selectedNames);
            if (enabled) next.add(entry.id);
            else next.delete(entry.id);
            setup.execute({ op: "apply", skills: [...next].sort() }, ctx);
            selectedNames.clear();
            for (const name of next) selectedNames.add(name);
          },
          setDefault: (entry, enabled, scope) =>
            changeSavedDefault(ctx, "skills", entry.id, enabled, scope, choices),
          saveGlobalDefaults: async (entries) =>
            writeGlobalResourceSelection(
              getAgentDir(),
              "skills",
              entries.filter((entry) => entry.selected).map((entry) => entry.id),
            ),
          saveDefaults: async (entries) =>
            persistSkillSelection(
              ctx,
              choices.filter((skill) =>
                entries.some((entry) => entry.id === skill.name && entry.selected),
              ),
            ),
        });
        return;
      }
      if (inspectName) {
        const skill = choices.find((item) => item.name === inspectName);
        if (!skill) throw Error(`Unknown public skill "${inspectName}"`);
        ctx.ui.notify(`${skill.name} — ${skill.description}\n${skill.path}`, "info");
        return;
      }
      const rows = [
        ...choices.map(
          (skill) =>
            `${selectedNames.has(skill.name) ? "[x]" : "[ ]"} ${skill.name} — ${skill.description}\n${skill.path}`,
        ),
      ];
      ctx.ui.notify(rows.join("\n\n") || "No public skills are available.", "info");
    },
  });
}
