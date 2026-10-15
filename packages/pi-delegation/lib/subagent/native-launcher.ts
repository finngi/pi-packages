import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ChildLaunchService, Communication, PreparedChild, ResourceSpec } from "pi-contracts";
import {
  childToolAuthority,
  installChildResources,
  resolveChildResources,
} from "./child-resources.ts";
import { prepareChildProvider } from "./child-provider.ts";
import { childLaunchContributions } from "./child-launch-contributions.ts";

export async function cleanupNativeLaunch({
  root,
  privateTmp,
  configuration,
  agentDir,
  beforeCleanup,
}: {
  root: string;
  privateTmp: string;
  configuration: string;
  agentDir: string;
  beforeCleanup?: () => Promise<void>;
}) {
  let collectionError: unknown;
  try {
    await beforeCleanup?.();
  } catch (error) {
    collectionError = error;
  }
  const cleanupResults = await Promise.allSettled([
    rm(configuration, { recursive: true, force: true }),
    rm(agentDir, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (collectionError) {
    const retainedError = new Error(
      `Artifact collection failed; scratch workspace path left untouched at ${privateTmp}`,
      { cause: collectionError },
    );
    if (cleanupErrors.length)
      throw new AggregateError(
        [retainedError, ...cleanupErrors],
        "Artifact collection failed and child cleanup was incomplete",
      );
    throw retainedError;
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    throw new AggregateError([...cleanupErrors, error], "Child launch directory cleanup failed");
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Child launch cleanup failed");
}

export function createNativeLauncher(
  pi: ExtensionAPI,
  context: () => ExtensionContext,
  messagingExtension: string,
): ChildLaunchService {
  const resources = async (spec: Record<string, unknown>) => {
    const ctx = context();
    return resolveChildResources(spec as ResourceSpec, {
      ...childToolAuthority(pi, messagingExtension),
      skills: pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => ({ name: command.name.slice(6), path: command.sourceInfo!.path! })),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      models: await ctx.modelRegistry.getAvailableOfType("chat"),
      thinking: pi.getThinkingLevel(),
      communicationExtension: messagingExtension,
    });
  };
  return {
    version: 1,
    async describeChild(spec) {
      const selected = await resources(spec);
      return {
        tools: selected.tools,
        skills: selected.skills.map((skill) => skill.name),
        scope: {
          execution: "host permissions",
          approval: "native tool-call hooks",
          write: "host permissions; workspace is an organisational directory, not confinement",
          read: "host permissions",
          network: "host permissions",
          workspaceModes: ["scratch", "project"],
          unavailable: ["MCP connections are not transferred"],
        },
      };
    },
    async prepareChildLaunch(spec) {
      const selected = await resources(spec);
      if (!selected.model) throw Error("No selected child model");
      const communication = spec.communication as Communication;
      if (
        !communication ||
        !/^(?:agent-)?[a-z]+-[a-z]+-[a-z]+$/.test(communication.id) ||
        !/^(?:agent-)?[a-z]+-[a-z]+-[a-z]+$/.test(communication.parentId)
      )
        throw Error("Missing child communication binding");
      const root = await mkdtemp(join(tmpdir(), "pi-child-"));
      const privateTmp = join(root, "workspace"),
        configuration = join(root, "launch"),
        agentDir = join(root, "agent");
      const workspaceKind = spec.workspace === "project" ? "project" : "scratch";
      const workspace = workspaceKind === "project" ? await realpath(context().cwd) : privateTmp;
      let live = true,
        cleanupComplete = false,
        cleanupPromise: Promise<void> | undefined,
        beforeCleanup: (() => Promise<void>) | undefined;
      try {
        await Promise.all(
          [privateTmp, configuration, agentDir].map((directory) =>
            mkdir(directory, { mode: 0o700 }),
          ),
        );
        const workspaceInfo = await lstat(workspace);
        const workspaceIdentity = {
          path: await realpath(workspace),
          dev: workspaceInfo.dev,
          ino: workspaceInfo.ino,
        };
        const providerExtension = process.env.PI_SUBAGENT_PROVIDER_EXTENSION;
        const provider = prepareChildProvider(
          context().modelRegistry,
          selected.model,
          providerExtension,
        );
        const contributions = childLaunchContributions(pi.events, context());
        const providerPath = join(configuration, "provider.json");
        if (provider)
          await writeFile(providerPath, JSON.stringify(provider), { mode: 0o600, flag: "wx" });
        const xml = (value: string) =>
          value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        selected.instructions += `\n\n<agent_id>${xml(communication.id)}</agent_id>\n<parent_id>${xml(communication.parentId)}</parent_id>\n<workspace>${xml(workspace)}</workspace>\n<execution>host permissions</execution>\n\nUse agent_message with kind: progress for routine telemetry to your parent without waking it; use kind: question or message for actionable coordination. Progress to siblings is refused. Return artifact paths and validation evidence. Workspace placement does not restrict filesystem access.`;
        const installed = await installChildResources(selected, configuration);
        const env = {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_CHILD_AGENT_DIR: getAgentDir(),
          PI_SUBAGENT_CONTEXT: JSON.stringify({ ...communication, workspace }),
          PI_CODING_AGENT_DIR: agentDir,
          TMPDIR: `${privateTmp}/`,
          PI_CHILD_PROVIDER_CONFIG: provider ? providerPath : undefined,
          ...contributions.env,
        };
        for (const key of ["NODE_OPTIONS", "NODE_PATH"]) delete (env as NodeJS.ProcessEnv)[key];
        const cli = fileURLToPath(new URL(import.meta.resolve("pi-delegation/child-rpc")));
        const argv = [
          process.execPath,
          cli,
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-mcp",
          "--no-themes",
          "--no-session",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tools",
          selected.tools.join(","),
          "-e",
          messagingExtension,
          ...(selected.extensions ?? [])
            .filter((source) => source !== messagingExtension)
            .flatMap((source) => ["-e", source]),
          ...[
            ...new Set([
              ...(providerExtension ? [providerExtension] : []),
              ...contributions.extensions,
            ]),
          ].flatMap((source) => ["-e", source]),
          "--append-system-prompt",
          installed.instructions,
          "--provider",
          selected.model.provider,
          "--model",
          selected.model.id,
          "--thinking",
          selected.thinking,
          ...installed.skillPaths.flatMap((path) => ["--skill", path]),
        ];
        const prepared: PreparedChild = {
          id: communication.id,
          argv,
          env,
          cwd: workspace,
          tmp: privateTmp,
          workspaceIdentity,
          workspaceKind,
          communication,
          effectiveResources: {
            tools: selected.tools,
            skills: selected.skills.map((skill) => skill.name),
            model: selected.model,
            thinking: selected.thinking,
          },
          isCurrent: () => live,
          beforeCleanup(callback) {
            beforeCleanup = callback;
          },
          async cleanup() {
            if (cleanupComplete) return;
            if (cleanupPromise) return cleanupPromise;
            live = false;
            cleanupPromise = cleanupNativeLaunch({
              root,
              privateTmp,
              configuration,
              agentDir,
              beforeCleanup,
            });
            try {
              await cleanupPromise;
              cleanupComplete = true;
            } catch (error) {
              cleanupPromise = undefined;
              throw error;
            }
          },
        };
        return prepared;
      } catch (error) {
        live = false;
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
