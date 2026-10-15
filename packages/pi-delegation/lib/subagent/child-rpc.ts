import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createToolSearchExtension,
  ModelRuntime,
  parseArgs,
  runRpcMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installChildProvider, type ChildProvider } from "./child-provider.ts";

/** Use Pi's loader and RPC host with only the resources prepared by the parent. */
export async function createChildRuntime(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const errors = args.diagnostics.filter(({ type }) => type === "error");
  if (errors.length) throw Error(errors.map(({ message }) => message).join("\n"));
  if (
    args.extensions?.some(
      (entry) => !isAbsolute(entry) && !["builtin:codemode", "builtin:tool-search"].includes(entry),
    )
  )
    throw Error("Child extensions must be prepared absolute paths or supported native builtins");
  const nativeAgentDir = process.env.PI_CHILD_AGENT_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!nativeAgentDir || !isAbsolute(nativeAgentDir) || !agentDir || !isAbsolute(agentDir))
    throw Error("Missing native child agent directory binding");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(nativeAgentDir, "auth.json"),
    modelsPath: join(nativeAgentDir, "models.json"),
    modelsStorePath: join(nativeAgentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const providerConfig = process.env.PI_CHILD_PROVIDER_CONFIG;
  if (providerConfig && !isAbsolute(providerConfig))
    throw Error("Child provider configuration must be a prepared absolute path");
  const provider = providerConfig
    ? (JSON.parse(await readFile(providerConfig, "utf8")) as ChildProvider | undefined)
    : undefined;
  const cwd = process.cwd();
  return createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
        extensionFlagValues: args.unknownFlags,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          disabledBuiltinExtensions: ["mcp"],
          additionalExtensionPaths: args.extensions,
          additionalSkillPaths: args.skills,
          appendSystemPrompt: args.appendSystemPrompt,
          extensionFactories: [
            { name: "codemode", builtin: true, factory: createCodemodeExtension() },
            { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
            ...(provider
              ? [
                  (pi: Parameters<typeof installChildProvider>[0]) =>
                    installChildProvider(pi, modelRuntime, provider),
                ]
              : []),
          ],
        },
      });
      const failures = [
        ...services.diagnostics
          .filter(({ type }) => type === "error")
          .map(({ message }) => message),
        ...services.resourceLoader.getExtensions().errors.map(({ error }) => error),
      ];
      if (failures.length) throw Error(failures.join("\n"));
      const model = args.provider && args.model && modelRuntime.getModel(args.provider, args.model);
      if (!model) throw Error("Selected child model is unavailable");
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: args.thinking,
        tools: args.tools ?? [],
        excludeTools: args.excludeTools,
        noTools: "builtin",
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runRpcMode(await createChildRuntime());
}
