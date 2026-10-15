/** Personal overlays and selected instructions, followed by eager context metadata cleanup. */

import { readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResourceEntry } from "pi-resource-browser";
import { showResourceBrowser, resourceBrowserNavigation } from "pi-resource-browser";
import {
  discoverResourcePackages,
  resourcePackageKeywords,
  readResourceFile,
  SESSION_SETUP_CONTRIBUTIONS,
  type SessionSetupContributionRequest,
  sessionSetupService,
  installSessionSetup,
} from "pi-runtime";
import { stripFrontmatter } from "../lib/frontmatter.ts";
import { instructionCatalogue } from "../lib/instruction-catalogue.ts";
import {
  catalogueInstructionId,
  effectiveInstructions,
  type InstructionSettings,
  instructionCataloguePaths,
  writeGlobalDefaults,
  writeProjectInstructions,
} from "../lib/instruction-selection.ts";
import {
  contextFilesDisabled,
  localFiles,
  localInstructionChoices,
  readCatalogueInstruction,
  selectedCatalogueInstructions,
  selectedLocalInstructions,
  selectedPackInstructions,
  unreadableLocalFiles,
  withLocalFiles,
} from "../lib/local-context.ts";
import { autoGitIgnoreEnabled, ignoreLocalFiles } from "../lib/local-ignore.ts";
import { compactPiDocumentation, renderInstructions } from "../lib/prompt.ts";

export default function (pi: ExtensionAPI) {
  const enabled = () => !contextFilesDisabled(process.argv);
  const setup = process.env.PI_SUBAGENT ? undefined : installSessionSetup(pi);
  let packageResources: Awaited<ReturnType<typeof discoverResourcePackages>> = {
    packs: [],
    problems: [],
  };
  let globalInstructionSnapshot: InstructionSettings | undefined;
  const refreshInstructionSnapshot = (cwd: string) => {
    globalInstructionSnapshot = SettingsManager.create(
      cwd,
      getAgentDir(),
    ).getGlobalSettings() as InstructionSettings;
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshInstructionSnapshot(ctx.cwd);
    packageResources = await discoverResourcePackages(
      SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }),
      ctx.cwd,
      getAgentDir(),
      pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.sourceInfo),
    );
  });

  pi.events.on(SESSION_SETUP_CONTRIBUTIONS, (value) => {
    const request = value as SessionSetupContributionRequest;
    if (request?.version !== 1 || typeof request.contribute !== "function") return;
    const { ctx } = request;
    const trusted = ctx.isProjectTrusted();
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
    const found = instructionCatalogue(
      globalInstructionSnapshot ?? (manager.getGlobalSettings() as InstructionSettings),
      manager.getProjectSettings() as InstructionSettings,
      ctx.cwd,
      getAgentDir(),
      trusted,
      enabled(),
      packageResources.packs,
    );
    request.contribute({
      kind: "instructions",
      candidates: found.candidates.map((candidate) => ({ kind: "instructions", ...candidate })),
      selected: found.selected,
    });
    if (ctx.hasUI && found.problems.length) ctx.ui.notify(found.problems.join("\n"), "warning");
  });

  pi.registerCommand("instructions", {
    description:
      "Select instructions for this session; Ctrl+S saves project defaults; Ctrl+Shift+S saves personal defaults",
    async handler(_args, ctx) {
      if (!setup) throw Error("Instruction selection is available only in a parent session");
      await ctx.waitForIdle();
      const trusted = ctx.isProjectTrusted();
      const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
      const currentGlobal = manager.getGlobalSettings() as InstructionSettings;
      const global = globalInstructionSnapshot ?? currentGlobal;
      const project = manager.getProjectSettings() as InstructionSettings;
      const packs = packageResources;
      if (packs.problems.length) ctx.ui.notify(packs.problems.join("\n"), "warning");
      const packFiles = packs.packs.flatMap((pack) =>
        pack.instructions.map((file) => ({ ...file, pack })),
      );
      let catalogues: string[] = [];
      try {
        catalogues = instructionCataloguePaths(global, getAgentDir());
      } catch (error) {
        ctx.ui.notify(`Instruction libraries were not loaded: ${String(error)}`, "warning");
      }
      const previous =
        setup.selection("instructions") ??
        (Object.hasOwn(project.localContext ?? {}, "instructions")
          ? (project.localContext?.instructions ?? [])
          : Object.hasOwn(global.localContext ?? {}, "instructions")
            ? (global.localContext?.instructions ?? [])
            : (trusted ? localInstructionChoices(ctx.cwd) : []).map(
                (file) => `local:${relative(ctx.cwd, file.path)}`,
              ));
      const entries: ResourceEntry[] = catalogues
        .flatMap((catalogue) => {
          try {
            return readdirSync(catalogue)
              .filter((name) => name.endsWith(".md"))
              .sort()
              .flatMap((file) => {
                const id = catalogueInstructionId(catalogue, file);
                const source = readCatalogueInstruction(catalogue, file);
                if (!source) return [];
                const parsed = parseFrontmatter(source.content);
                const description =
                  typeof parsed.frontmatter.description === "string"
                    ? parsed.frontmatter.description
                    : "Instruction snippet";
                const title =
                  typeof parsed.frontmatter.title === "string"
                    ? parsed.frontmatter.title
                    : file.replace(/\.md$/i, "");
                return [
                  {
                    id,
                    name: title,
                    description,
                    keywords: `${file} ${parsed.body.slice(0, 500)}`,
                    selected: previous.includes(id),
                    defaultSelected: (project.localContext?.instructions ?? []).includes(id),
                    globalDefaultSelected: (global.localContext?.instructions ?? []).includes(id),
                    preview: async () => ({
                      source: source.path,
                      body: stripFrontmatter(source.content),
                    }),
                  },
                ];
              });
          } catch {
            return [];
          }
        })
        .concat(
          packFiles.map((file) => {
            let parsed = {
              frontmatter: {} as Record<string, unknown>,
              body: stripFrontmatter(file.content),
            };
            try {
              parsed = parseFrontmatter(file.content);
            } catch {
              ctx.ui.notify(
                `${file.path}: instruction metadata could not be read; showing the body.`,
                "warning",
              );
            }
            const description =
              typeof parsed.frontmatter.description === "string"
                ? parsed.frontmatter.description
                : "Agent/session guidance";
            const title =
              typeof parsed.frontmatter.title === "string"
                ? parsed.frontmatter.title
                : basename(file.path, ".md");
            const id = catalogueInstructionId(file.catalogue, basename(file.path));
            return {
              id,
              name: title,
              description,
              badge: file.pack.name,
              globalDefaultable: file.pack.globalDefaultable,
              keywords: `${resourcePackageKeywords(file.pack)} ${basename(file.path)} ${parsed.body.slice(0, 500)}`,
              selected: previous.includes(id),
              defaultSelected: (project.localContext?.instructions ?? []).includes(id),
              globalDefaultSelected: (global.localContext?.instructions ?? []).includes(id),
              preview: async () => ({
                source: file.path,
                body: stripFrontmatter(file.content),
              }),
            };
          }),
        )
        .concat(
          (trusted ? localInstructionChoices(ctx.cwd) : []).map((file) => {
            const id = `local:${relative(ctx.cwd, file.path)}`;
            return {
              id,
              name: file.path.split("/").at(-1) ?? id,
              description:
                "Project-local instructions; select for this session or save project defaults.",
              badge: "Project",
              globalDefaultable: false,
              keywords: file.content.slice(0, 500),
              selected: previous.includes(id),
              defaultSelected: (project.localContext?.instructions ?? []).includes(id),
              globalDefaultSelected: (global.localContext?.instructions ?? []).includes(id),
              preview: async () => ({
                source: file.path,
                body: stripFrontmatter(file.content),
              }),
            };
          }),
        );
      const selected = new Set(previous);
      const saveProject = async () => {
        if (!ctx.isProjectTrusted())
          throw Error("Saving instruction defaults requires a trusted project");
        await writeProjectInstructions(ctx.cwd, [...selected].sort());
      };
      await showResourceBrowser(ctx, {
        title: "Instructions",
        ...resourceBrowserNavigation(pi, "instructions"),
        entries,
        selectionScope: "session",
        defaultsScope: "project",
        defaultsInherited: !Object.hasOwn(project.localContext ?? {}, "instructions"),
        setDefault: async (entry, on, scope) => {
          const current = [...selected];
          const latest = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
          });
          const global =
            (latest.getGlobalSettings() as InstructionSettings).localContext?.instructions ?? [];
          const project = (latest.getProjectSettings() as InstructionSettings).localContext
            ?.instructions;
          const names = new Set(scope === "global" ? global : (project ?? global));
          if (on) names.add(entry.id);
          else names.delete(entry.id);
          if (scope === "global")
            await writeGlobalDefaults(getAgentDir(), "instructions", [...names].sort());
          else {
            if (!ctx.isProjectTrusted())
              throw Error("Saving instruction defaults requires a trusted project");
            await writeProjectInstructions(ctx.cwd, [...names].sort());
          }
          setup.execute({ op: "apply", instructions: current }, ctx);
        },
        saveDefaults: saveProject,
        saveGlobalDefaults: async (entries) =>
          writeGlobalDefaults(
            getAgentDir(),
            "instructions",
            entries.filter((entry) => entry.selected).map((entry) => entry.id),
          ),
        toggle: async (entry, on) => {
          const next = new Set(selected);
          if (on) next.add(entry.id);
          else next.delete(entry.id);
          setup.execute({ op: "apply", instructions: [...next].sort() }, ctx);
          selected.clear();
          for (const id of next) selected.add(id);
        },
      });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    compactPiDocumentation(options);
    const manager =
      typeof options.cwd === "string"
        ? SettingsManager.create(options.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
          })
        : undefined;
    const global =
      globalInstructionSnapshot ??
      (manager?.getGlobalSettings() as InstructionSettings | undefined);
    const project = ctx.isProjectTrusted()
      ? (manager?.getProjectSettings() as InstructionSettings | undefined)
      : undefined;
    const packs = global ? packageResources : { packs: [], problems: [] };
    if (ctx.hasUI && packs.problems.length) ctx.ui.notify(packs.problems.join("\n"), "warning");
    const packFiles = packs.packs.flatMap((pack) =>
      pack.instructions.map((file) => ({ ...file, pack })),
    );
    let catalogues: string[] = [];
    try {
      if (global) catalogues = instructionCataloguePaths(global, getAgentDir());
    } catch (error) {
      if (ctx.hasUI)
        ctx.ui.notify(`Instruction libraries were not loaded: ${String(error)}`, "warning");
    }
    const names =
      catalogues.flatMap((catalogue) => {
        try {
          return readdirSync(catalogue)
            .filter((name) => name.endsWith(".md"))
            .map((name) => catalogueInstructionId(catalogue, name));
        } catch {
          return [];
        }
      }) ?? [];
    const localChoices =
      typeof options.cwd === "string" ? localInstructionChoices(options.cwd) : [];
    const localNames = localChoices.map((file) => `local:${relative(options.cwd, file.path)}`);
    let selected: string[] | undefined;
    try {
      const sessionInstructions = sessionSetupService(pi.events)?.selection("instructions");
      if (sessionInstructions !== undefined) selected = sessionInstructions;
      else if (global)
        selected = effectiveInstructions(global, project ?? {}, [
          ...names,
          ...localNames,
          ...packFiles.map((file) =>
            catalogueInstructionId(dirname(file.path), basename(file.path)),
          ),
        ]);
    } catch (error) {
      selected = [];
      if (ctx.hasUI)
        ctx.ui.notify(`Selected instructions were not loaded: ${String(error)}`, "warning");
    }
    const files =
      enabled() && ctx.isProjectTrusted() && typeof options.cwd === "string"
        ? withLocalFiles(options.contextFiles, options.cwd)
        : options.contextFiles;
    const localInstructions =
      enabled() && ctx.isProjectTrusted()
        ? selectedLocalInstructions(
            options.cwd,
            selected,
            files.map((file) => resolve(options.cwd, file.path)),
            localChoices,
          )
        : [];
    const catalogueFiles =
      enabled() && selected && global
        ? selectedCatalogueInstructions(
            catalogues,
            selected,
            [...files, ...localInstructions].map((file) => resolve(options.cwd, file.path)),
          )
        : [];
    options.contextFiles = files.map((file) => ({
      ...file,
      content: stripFrontmatter(file.content),
    }));
    const selectedPacks = enabled()
      ? selectedPackInstructions(
          packFiles,
          selected,
          [...files, ...localInstructions, ...catalogueFiles].map((file) =>
            resolve(options.cwd, file.path),
          ),
        )
      : [];
    for (const file of selectedPacks) {
      const pack = packFiles.find((member) => member.path === file.path)?.pack;
      if (pack) file.content = readResourceFile(pack.root, file.path);
    }
    const instructions = renderInstructions(
      [...localInstructions, ...catalogueFiles, ...selectedPacks].map((file) => ({
        ...file,
        content: stripFrontmatter(file.content),
      })),
    );
    if (instructions) {
      options.sections ??= {};
      options.sections.instructions = [options.sections.instructions, instructions]
        .filter(Boolean)
        .join("\n\n");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!enabled()) return;
    if (
      autoGitIgnoreEnabled(getAgentDir()) &&
      !process.env.PI_SUBAGENT &&
      !process.argv.some((arg) => arg === "-na" || arg === "--no-approve") &&
      ctx.isProjectTrusted()
    ) {
      const trust = new ProjectTrustStore(getAgentDir());
      ignoreLocalFiles(
        localFiles(ctx.cwd).map((file) => file.path),
        process.env,
        (root) => {
          try {
            return trust.get(root) === true;
          } catch {
            return false;
          }
        },
      );
    }
    if (!ctx.hasUI) return;
    const unreadable = unreadableLocalFiles(ctx.cwd);
    if (unreadable.length)
      ctx.ui.notify(
        `${unreadable.join(", ")} is not a readable file, so it was not loaded`,
        "warning",
      );
  });
}
