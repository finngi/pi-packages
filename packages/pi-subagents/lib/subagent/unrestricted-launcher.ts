import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildLaunchService, Communication, PreparedChild, ResourceSpec } from "pi-contracts";
import {
  childTools,
  installChildResources,
  resolveChildAuth,
  resolveChildResources,
} from "pi-runtime";

export async function cleanupUnrestrictedLaunch({
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
    rm(join(configuration, "auth.json"), { force: true }),
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

export function createUnrestrictedLauncher(
  pi: ExtensionAPI,
  context: () => ExtensionContext,
  messagingExtension: string,
): ChildLaunchService {
  const resources = async (spec: Record<string, unknown>) => {
    const ctx = context();
    return resolveChildResources(
      spec as ResourceSpec,
      {
        tools: pi.getActiveTools().filter((name) => childTools.includes(name)),
        skills: pi
          .getCommands()
          .filter((command) => command.source === "skill")
          .map((command) => ({ name: command.name.slice(6), path: command.sourceInfo!.path! })),
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        models: await ctx.modelRegistry.getAvailableOfType("chat"),
        thinking: pi.getThinkingLevel(),
        communicationExtension: messagingExtension,
      },
      { unrestricted: true },
    );
  };
  return {
    version: 1,
    async describeChild(spec) {
      const selected = await resources(spec);
      return {
        tools: selected.tools,
        skills: selected.skills.map((skill) => skill.name),
        permissions: { write: true, network: true },
        scope: {
          mode: "off",
          write: "host permissions; workspace is an organisational directory, not confinement",
          read: "host permissions",
          security: "off",
          network: "host permissions",
          workspaceModes: ["scratch", "project"],
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
        const fixtureProviderExtension = process.env.PI_SUBAGENT_FIXTURE_EXTENSION;
        const auth = await resolveChildAuth(context().modelRegistry, selected.model, {
          fixtureProviderExtension,
        });
        const authPath = join(configuration, "auth.json"),
          bytes = JSON.stringify(auth);
        await writeFile(authPath, bytes, { mode: 0o600, flag: "wx" });
        const xml = (value: string) =>
          value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        selected.instructions += `\n\n<agent_id>${xml(communication.id)}</agent_id>\n<parent_id>${xml(communication.parentId)}</parent_id>\n<workspace>${xml(workspace)}</workspace>\n<security>off; host permissions</security>\n\nUse agent_message with kind: progress for routine telemetry to your parent without waking it; use kind: question or message for actionable coordination. Progress to siblings is refused. Return artifact paths and validation evidence. Workspace placement does not restrict filesystem access.`;
        const installed = await installChildResources(selected, configuration);
        const env = {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_SUBAGENT_CONTEXT: JSON.stringify({ ...communication, workspace }),
          PI_SUBAGENT_SECURITY: "off",
          PI_CODING_AGENT_DIR: agentDir,
          TMPDIR: `${privateTmp}/`,
          PI_CHILD_AUTH: JSON.stringify({
            version: 1,
            path: authPath,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        };
        for (const key of [
          "PI_SECURITY_TRANSPORT",
          "PI_SECURITY_POLICY",
          "PI_POLICY_LAUNCH",
          "PI_SECURITY_CHILD_AUTH",
          "PI_SECURITY_TMP",
          "PI_SECURITY_CHILD_FIXTURE_EXTENSION",
          "NODE_OPTIONS",
          "NODE_PATH",
        ])
          delete (env as NodeJS.ProcessEnv)[key];
        const cli = fileURLToPath(
          new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
        );
        const argv = [
          process.execPath,
          cli,
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tools",
          selected.tools.join(","),
          "-e",
          messagingExtension,
          ...(!auth.fixture
            ? ["-e", fileURLToPath(new URL(import.meta.resolve("pi-runtime/child-auth")))]
            : []),
          ...(fixtureProviderExtension ? ["-e", fixtureProviderExtension] : []),
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
            permissionMode: "full-access",
            permissions: { write: true, network: true },
          },
          isCurrent: () => live,
          beforeCleanup(callback) {
            beforeCleanup = callback;
          },
          async cleanup() {
            if (cleanupComplete) return;
            if (cleanupPromise) return cleanupPromise;
            live = false;
            cleanupPromise = cleanupUnrestrictedLaunch({
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
