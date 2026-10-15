/** Personal overlays and selected instructions, followed by eager context metadata cleanup. */

import { basename, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
} from "pi-resources/discovery";
import {
  SESSION_SETUP_CONTRIBUTIONS,
  type SessionSetupContributionRequest,
  sessionSetupService,
  installSessionSetup,
} from "pi-resources/session-setup";
import {
  SAVED_INSTRUCTION_CONTEXT,
  type SavedInstructionContextRequest,
} from "pi-resources/instructions";
import { resourcePickerControls } from "pi-resources/picker";
import { stripFrontmatter } from "../lib/frontmatter.ts";
import { instructionCatalogue } from "../lib/instruction-catalogue.ts";
import {
  catalogueInstructionId,
  effectiveInstructions,
  type InstructionSettings,
} from "../lib/instruction-selection.ts";
import {
  contextFilesDisabled,
  localFiles,
  localInstructionChoices,
  selectedLocalInstructions,
  selectedPackInstructions,
  unreadableLocalFiles,
  withLocalFiles,
  type ContextFile,
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
  let staticContextFiles: ContextFile[] = [];
  const instructionFiles = () =>
    packageResources.packs.flatMap((pack) => pack.instructions.map((file) => ({ ...file, pack })));
  const selectedInstructionText = (
    cwd: string,
    trusted: boolean,
    selected: string[] | undefined,
    files: ContextFile[],
  ) => {
    if (!enabled()) return "";
    const localInstructions = trusted
      ? selectedLocalInstructions(
          cwd,
          selected,
          files.map((file) => resolve(cwd, file.path)),
        )
      : [];
    const packFiles = instructionFiles();
    const selectedPacks = selectedPackInstructions(
      packFiles,
      selected,
      [...files, ...localInstructions].map((file) => resolve(cwd, file.path)),
    );
    for (const file of selectedPacks) {
      const pack = packFiles.find((member) => member.path === file.path)?.pack;
      if (pack) file.content = readResourceFile(pack.root, file.path);
    }
    return renderInstructions(
      [...localInstructions, ...selectedPacks].map((file) => ({
        ...file,
        content: stripFrontmatter(file.content),
      })),
    );
  };

  const refreshResources = async (ctx: ExtensionContext) => {
    packageResources = await discoverResourcePackages(
      SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }),
      ctx.cwd,
      getAgentDir(),
      pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.sourceInfo),
    );
  };
  pi.on("session_start", async (_event, ctx) => refreshResources(ctx));

  pi.events.on(SESSION_SETUP_CONTRIBUTIONS, (value) => {
    const request = value as SessionSetupContributionRequest;
    if (request?.version !== 1 || typeof request.contribute !== "function") return;
    const { ctx } = request;
    const trusted = ctx.isProjectTrusted();
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
    const found = instructionCatalogue(
      manager.getGlobalSettings() as InstructionSettings,
      manager.getProjectSettings() as InstructionSettings,
      ctx.cwd,
      trusted,
      enabled(),
      packageResources.packs,
    );
    request.contribute({
      kind: "instructions",
      candidates: found.candidates.map((candidate) => ({
        kind: "instructions",
        ...candidate,
      })),
      selected: found.selected,
    });
    if (ctx.hasUI && found.problems.length) ctx.ui.notify(found.problems.join("\n"), "warning");
  });

  pi.events.on(SAVED_INSTRUCTION_CONTEXT, (value) => {
    const request = value as SavedInstructionContextRequest;
    if (request?.version !== 1 || typeof request.contribute !== "function") return;
    try {
      if (!enabled()) {
        request.contribute("");
        return;
      }
      const { ctx } = request;
      const trusted = ctx.isProjectTrusted();
      const manager = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: trusted,
      });
      const localNames = (trusted ? localInstructionChoices(ctx.cwd) : []).map(
        (file) => `local:${relative(ctx.cwd, file.path)}`,
      );
      const selected = effectiveInstructions(
        manager.getGlobalSettings() as InstructionSettings,
        trusted ? (manager.getProjectSettings() as InstructionSettings) : {},
        [
          ...localNames,
          ...instructionFiles().map((file) =>
            catalogueInstructionId(file.catalogue, basename(file.path)),
          ),
        ],
        localNames,
        false,
      );
      request.contribute(selectedInstructionText(ctx.cwd, trusted, selected, staticContextFiles));
    } catch (error) {
      request.reject(`Saved child instructions could not be loaded: ${String(error)}`);
    }
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
      const global = currentGlobal;
      const project = manager.getProjectSettings() as InstructionSettings;
      const packs = packageResources;
      if (packs.problems.length) ctx.ui.notify(packs.problems.join("\n"), "warning");
      const packFiles = packs.packs.flatMap((pack) =>
        pack.instructions.map((file) => ({ ...file, pack })),
      );
      const discovered = instructionCatalogue(
        global,
        project,
        ctx.cwd,
        trusted,
        enabled(),
        packs.packs,
      );
      if (discovered.problems.length) ctx.ui.notify(discovered.problems.join("\n"), "warning");
      const previous = setup.selection("instructions") ?? discovered.selected;
      const nativeNames = new Set(
        discovered.candidates.filter((item) => item.nativeDefault).map((item) => item.id),
      );
      const entries: ResourceEntry[] = packFiles
        .map((file) => {
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
            preview: async () => ({
              source: file.path,
              body: stripFrontmatter(file.content),
            }),
          };
        })
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
              preview: async () => ({
                source: file.path,
                body: stripFrontmatter(file.content),
              }),
            };
          }),
        )
        .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index);
      await showResourceBrowser(ctx, {
        title: "Instructions",
        ...resourceBrowserNavigation(pi, "instructions"),
        entries,
        selectionScope: "session",
        defaultsScope: "project",
        ...resourcePickerControls({
          ctx,
          setup,
          entries,
          members: (entry) => [
            {
              kind: "instructions",
              id: entry.id,
              nativeDefault: nativeNames.has(entry.id),
              globalDefaultable: entry.globalDefaultable,
            },
          ],
        }),
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
    const global = manager?.getGlobalSettings() as InstructionSettings | undefined;
    const project = ctx.isProjectTrusted()
      ? (manager?.getProjectSettings() as InstructionSettings | undefined)
      : undefined;
    const packs = global ? packageResources : { packs: [], problems: [] };
    if (ctx.hasUI && packs.problems.length) ctx.ui.notify(packs.problems.join("\n"), "warning");
    const packFiles = packs.packs.flatMap((pack) =>
      pack.instructions.map((file) => ({ ...file, pack })),
    );
    const localChoices =
      typeof options.cwd === "string" ? localInstructionChoices(options.cwd) : [];
    const localNames = localChoices.map((file) => `local:${relative(options.cwd, file.path)}`);
    let selected: string[] | undefined;
    try {
      const sessionInstructions = sessionSetupService(pi.events)?.selection("instructions");
      if (sessionInstructions !== undefined) selected = sessionInstructions;
      else if (global)
        selected = effectiveInstructions(
          global,
          project ?? {},
          [
            ...localNames,
            ...packFiles.map((file) => catalogueInstructionId(file.catalogue, basename(file.path))),
          ],
          localNames,
          ctx.mode === "tui",
        );
    } catch (error) {
      selected = [];
      if (ctx.hasUI)
        ctx.ui.notify(`Selected instructions were not loaded: ${String(error)}`, "warning");
    }
    const files =
      enabled() && ctx.isProjectTrusted() && typeof options.cwd === "string"
        ? withLocalFiles(options.contextFiles, options.cwd)
        : options.contextFiles;
    staticContextFiles = files;
    options.contextFiles = files.map((file) => ({
      ...file,
      content: stripFrontmatter(file.content),
    }));
    const instructions = selectedInstructionText(
      options.cwd,
      ctx.isProjectTrusted(),
      selected,
      files,
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
