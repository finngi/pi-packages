import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_REFRESH,
  type SessionSetupContributionRequest,
  type SessionSetupRefreshRequest,
} from "pi-contracts";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
  type ResourceEntry,
} from "pi-resource-browser";
import {
  configuredSkillChoices,
  filterPromptSkills,
  selectedSkills,
  type SkillChoice,
} from "pi-resources/selection";
import {
  discoverResourcePackages,
  type ResourcePackage,
  resourcePackageKeywords,
} from "pi-resources/discovery";
import { installSessionSetup } from "pi-resources/session-setup";
import { resourcePickerControls } from "pi-resources/picker";
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
  let nativePersonalSkillPaths = new Set<string>();
  let skillChoicesSnapshot: SkillChoice[] = [];
  let skillIdentities = new Map<string, { dev: number; ino: number }>();
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
    const pack = packageResources.packs.find((pack) => pack.name === skill.packName);
    // Native metadata may label a CLI-enabled skill as user-scoped even when the personal
    // package excludes it. Only the resolver's enabled personal members are defaultable.
    if (pack)
      return pack.globalDefaultable !== false && !!pack.personalSkills?.includes(skill.path);
    return !skill.defaultSelected || nativePersonalSkillPaths.has(skill.path);
  };
  const settingsManager = (ctx: ExtensionContext) =>
    SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
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
    return selectedSkills(manager, choices, false, undefined, ctx.mode === "tui");
  };
  const currentSkillChoices = (ctx: ExtensionContext) => {
    const registered = skills();
    return skillChoicesSnapshot.filter((choice) => {
      try {
        if (
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
  const refreshResources = async (ctx: ExtensionContext) => {
    packageResources = await discoverResourcePackages(
      settingsManager(ctx),
      ctx.cwd,
      getAgentDir(),
      skills().map((skill) => skill.source),
    );
    // Only resources already loaded by native Pi can enter this session selection.
    nativePersonalSkillPaths = new Set(
      skills()
        .filter((skill) => skill.source.scope === "user")
        .map((skill) => skill.path),
    );
    skillChoicesSnapshot = configuredSkillChoices(
      ctx.cwd,
      getAgentDir(),
      skills().map((skill) => ({ name: skill.name, path: skill.path })),
      packageResources.packs,
    );
    skillIdentities = new Map();
    skillChoicesSnapshot = skillChoicesSnapshot.filter((skill) => {
      try {
        const { dev, ino } = statSync(skill.path);
        skillIdentities.set(skill.path, { dev, ino });
        return true;
      } catch {
        return false;
      }
    });
  };
  pi.on("session_start", async (_input, ctx) => refreshResources(ctx));
  pi.events.on(SESSION_SETUP_REFRESH, (value: unknown) => {
    const request = value as SessionSetupRefreshRequest;
    if (request?.version === 1 && typeof request.waitUntil === "function")
      request.waitUntil(refreshResources(request.ctx));
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
      selectedSkillIds = selectedSkills(manager, choices, false, undefined, ctx.mode === "tui").map(
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
        nativeDefault: skill.defaultSelected,
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
        nativeDefault: true,
      })),
      selected: [],
    });
  });
  registerPackagePicker(pi, setup, () => packageResources.problems);
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
      const available = new Set(
        setup
          .inspect(ctx)
          .find((value) => value.kind === "skills")
          ?.candidates.map((candidate) => candidate.id),
      );
      const choices = configuredSkillChoices(
        ctx.cwd,
        getAgentDir(),
        loaded,
        packageResources.packs,
      ).filter((choice) => available.has(choice.name));
      const selected = selectedSkills(
        manager,
        choices,
        repairingInvalidProjectSelection,
        undefined,
        ctx.mode === "tui",
      );
      const selectedNames = new Set(
        setup.selection("skills") ?? selected.map((skill) => skill.name),
      );
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
        const entries: ResourceEntry[] = choices.map((skill) => {
          return {
            id: skill.name,
            name: skill.name,
            description: skill.description,
            keywords: `${skill.manualOnly ? "manual command" : "model skill"} ${skill.packKeywords ?? ""}`,
            selected: selectedNames.has(skill.name),
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
          };
        });
        await showResourceBrowser(ctx, {
          title: "Skills",
          ...resourceBrowserNavigation(pi, "skills"),
          selectionScope: "session",
          defaultsScope: "project",
          entries,
          ...resourcePickerControls({
            ctx,
            setup,
            entries,
            members: (entry) => [
              {
                kind: "skills",
                id: entry.id,
                nativeDefault: choices.find((choice) => choice.name === entry.id)?.defaultSelected,
                globalDefaultable: entry.globalDefaultable,
              },
            ],
          }),
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
