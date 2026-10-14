import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNarrows, childPermissionLimits, narrow } from "./child-policy.ts";
import { installChildResources, resolveChildResources } from "./child-resources.ts";
import { materializeFilesystem } from "./policy.ts";
import type { loadPolicy as loadPolicyFunction } from "./policy.ts";
import type { createTempScope } from "./temp-scope.ts";
import type {
  ChildAuth,
  ChildAuthOptions,
  ChildSpec,
  LoadedPolicy,
  ParentResources,
  PreparedChild,
  SelectedModel,
} from "./types.ts";

interface LauncherOptions {
  parentLoaded: LoadedPolicy;
  tempScope: Awaited<ReturnType<typeof createTempScope>>;
  extensionPath: string;
  piCliPath: string;
  processExtension?: () => string;
  parentResources?: ParentResources | (() => ParentResources | Promise<ParentResources>);
  resolveAuth?: (model: SelectedModel, options: ChildAuthOptions) => Promise<ChildAuth>;
  resolveClassifierAuth?: (model: string, options: ChildAuthOptions) => Promise<ChildAuth>;
  fixtureProviderExtension?: string;
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const unsafeChildRuntimeEnvironmentName = /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$)/;
const metadata = (loaded: LoadedPolicy) => ({
  project: loaded.project,
  tmp: loaded.tmp,
  limits: loaded.limits ?? { write: true, network: true },
  capabilities: loaded.capabilities ?? [],
  agentDepth: loaded.agentDepth ?? 0,
  ...(loaded.childTask === undefined ? {} : { childTask: loaded.childTask }),
  ...(loaded.launchResources ? { launchResources: loaded.launchResources } : {}),
  ...(loaded.resourceAuthority ? { resourceAuthority: loaded.resourceAuthority } : {}),
  ...(loaded.resources ? { resources: loaded.resources } : {}),
  ...(loaded.tempIsolation ? { tempIsolation: loaded.tempIsolation } : {}),
  ...(loaded.authorization ? { authorization: loaded.authorization } : {}),
  ...(loaded.communication ? { communication: loaded.communication } : {}),
});
const materialized = (loaded: LoadedPolicy) => {
  const policy = structuredClone(loaded.policy);
  materializeFilesystem(policy, loaded.filesystem);
  return policy;
};
function checkCommunication(spec: ChildSpec, authority?: ParentResources) {
  const communication = spec.communication;
  if (
    communication &&
    (!authority?.communicationExtension ||
      Object.keys(communication).sort().join(",") !== "id,name,parentId,parentName" ||
      ![communication.id, communication.parentId].every(
        (x) => typeof x === "string" && /^(?:agent-)?[a-z]+-[a-z]+-[a-z]+$/.test(x),
      ) ||
      ![communication.name, communication.parentName].every(
        (x) => typeof x === "string" && /^[\w.:-]+$/.test(x),
      ))
  )
    throw Error("invalid child communication binding");
  return communication;
}
function policySpec(spec: ChildSpec) {
  const { agentBundle: _agentBundle, staticContext: _staticContext, ...scope } = spec;
  return scope;
}
export function createChildLauncher({
  parentLoaded,
  tempScope,
  extensionPath,
  piCliPath,
  processExtension,
  parentResources,
  resolveAuth,
  resolveClassifierAuth,
  fixtureProviderExtension,
}: LauncherOptions) {
  const credentialRoot = path.join(tempScope.launchDir, "credentials");
  if (!parentLoaded.filesystem.readDeny.includes(`${credentialRoot}/**`))
    parentLoaded.filesystem.readDeny.push(`${credentialRoot}/**`);
  materializeFilesystem(parentLoaded.policy, parentLoaded.filesystem);
  const launches = new Map<string, PreparedChild>();
  let closed = false;
  return {
    launches,
    async describeChild(spec: ChildSpec) {
      const authority =
        typeof parentResources === "function" ? await parentResources() : parentResources;
      checkCommunication(spec, authority);
      const resources = resolveChildResources(spec, authority),
        limits = childPermissionLimits(parentLoaded, policySpec(spec));
      if (!limits.write)
        resources.tools = resources.tools.filter((name) => !["write", "edit"].includes(name));
      return {
        tools: resources.tools,
        skills: resources.skills.map((s) => s.name),
        permissions: limits,
        scope: {
          mode: spec.permissionMode ?? parentLoaded.policy.mode,
          permissions: limits,
          write: !limits.write ? "none" : "workspace; other paths require approval",
          read: "permitted files, excluding policy denials and other agent temporary directories",
          readDeny: [...parentLoaded.filesystem.readDeny],
          writeDeny: [...parentLoaded.filesystem.writeDeny],
          network: limits.network ? [...parentLoaded.policy.resources.network] : [],
          capabilities: [...(parentLoaded.capabilities ?? [])],
        },
      };
    },
    async prepareChildLaunch(spec: ChildSpec) {
      if (closed) throw Error("launcher closed");
      const shellExtension = processExtension?.();
      const authority =
        typeof parentResources === "function" ? await parentResources() : parentResources;
      const communication = checkCommunication(spec, authority);
      const resources = resolveChildResources(spec, authority);
      if (!childPermissionLimits(parentLoaded, policySpec(spec)).write)
        resources.tools = resources.tools.filter((name) => !["write", "edit"].includes(name));
      const auth =
        resources.model && resolveAuth
          ? await resolveAuth(resources.model, { fixtureProviderExtension })
          : undefined;
      let classifierAuth: ChildAuth | undefined;
      if ((spec.permissionMode ?? parentLoaded.policy.mode) === "auto" && resolveClassifierAuth)
        try {
          classifierAuth = await resolveClassifierAuth(parentLoaded.policy.classifier.model, {
            fixtureProviderExtension,
          });
        } catch {}
      const tmp = await tempScope.allocateChild(parentLoaded.tmp);
      let directory: string | undefined, authPath: string | undefined;
      try {
        const workspaceInfo = await lstat(tmp);
        const workspaceIdentity = {
          path: await realpath(tmp),
          dev: workspaceInfo.dev,
          ino: workspaceInfo.ino,
        };
        const child = narrow(parentLoaded, policySpec(spec), {
          tmp,
          tempBase: tempScope.base,
          launchDir: tempScope.launchDir,
        });
        const id = randomBytes(8).toString("hex");
        directory = path.join(tempScope.launchDir, id);
        await mkdir(directory, { mode: 0o700 });
        const authorization = {
          userMessages: authority?.userMessages ?? parentLoaded.authorization?.userMessages ?? [],
        };
        child.authorization = authorization;
        if (communication)
          child.communication = {
            ...communication,
            extensionPath: authority!.communicationExtension!,
          };
        const xml = (x: string) =>
          String(x)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        const instructions = communication
          ? resources.instructions +
            `\n\n<agent_id>${xml(communication.id)}</agent_id>\n<parent_id>${xml(communication.parentId)}</parent_id>\n<workspace>${xml(tmp)}</workspace>\n\nWrite implementation artifacts only in your workspace. Use agent_message for progress, questions and coordination with listed agent sessions. The parent inspects and integrates returned artifacts. Return paths and validation results in your final answer.`
          : resources.instructions;
        resources.instructions = instructions;
        const installed = await installChildResources(resources, directory);
        // The child needs the staged skill locations and instructions, not the trusted host bundle
        // source paths or duplicate static context payload.
        child.resources = { ...resources, agentBundle: undefined, staticContext: undefined };
        child.launchResources = {
          directory,
          instructions: {
            path: installed.instructions,
            sha256: sha(await readFile(installed.instructions)),
          },
          skills: await Promise.all(
            installed.skillPaths.map(async (p: string, index: number) => ({
              name: resources.skills[index].name,
              path: p,
              sha256: sha(await readFile(p)),
            })),
          ),
        };
        if (installed.bundlePath) {
          const bundleSkills = child.launchResources.skills.flatMap((skill, index) => {
            const relative = path.relative(installed.bundlePath!, skill.path);
            return relative === "" ||
              (!relative.startsWith(`..${path.sep}`) &&
                relative !== ".." &&
                !path.isAbsolute(relative))
              ? [{ ...skill, sourcePath: resources.skills[index].path }]
              : [];
          });
          child.launchResources.bundle = {
            path: installed.bundlePath,
            sourceRoot: resources.agentBundle!.root,
            skills: bundleSkills,
          };
        }
        child.tempIsolation!.resourceReadAllow = [
          ...installed.skillPaths.map((p) => path.dirname(p)),
          ...(installed.bundlePath ? [installed.bundlePath] : []),
        ];
        let authPayload: { version: number; path: string; sha256: string } | undefined;
        if (auth || classifierAuth) {
          await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
          authPath = path.join(credentialRoot, `${id}.json`);
          const authBytes = JSON.stringify({
            ...auth,
            ...(classifierAuth ? { classifier: classifierAuth } : {}),
          });
          await writeFile(authPath, authBytes, { flag: "wx", mode: 0o600 });
          authPayload = { version: 1, path: authPath, sha256: sha(authBytes) };
          child.filesystem.readDeny.push(authPath);
          materializeFilesystem(child.policy, child.filesystem);
        }
        const parentFile = path.join(directory, "parent.json"),
          childFile = path.join(directory, "child.json"),
          manifestFile = path.join(directory, "manifest.json");
        const parentSnapshot = {
          ...parentLoaded,
          authorization,
          resourceAuthority: {
            tools: [
              ...(authority?.tools ?? resources.tools),
              ...(communication ? ["agent_message", "agent_list"] : []),
            ],
            skills: authority?.skills ?? resources.skills,
            privateSkills:
              child.launchResources.bundle?.skills.map(({ name, sourcePath }) => ({
                name,
                path: sourcePath,
              })) ?? [],
          },
        };
        const parentBytes = JSON.stringify(materialized(parentLoaded)),
          childBytes = JSON.stringify(materialized(child));
        await writeFile(parentFile, parentBytes, { flag: "wx", mode: 0o600 });
        await writeFile(childFile, childBytes, { flag: "wx", mode: 0o600 });
        const manifest = {
          version: 1,
          id,
          parent: { path: parentFile, sha256: sha(parentBytes), ...metadata(parentSnapshot) },
          child: { path: childFile, sha256: sha(childBytes), ...metadata(child) },
        };
        const bytes = JSON.stringify(manifest);
        await writeFile(manifestFile, bytes, { flag: "wx", mode: 0o600 });
        child.sha256 = sha(childBytes);
        child.launchId = id;
        const env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !unsafeChildRuntimeEnvironmentName.test(name),
            ),
          ),
          ...(authPayload ? { PI_SECURITY_CHILD_AUTH: JSON.stringify(authPayload) } : {}),
          PI_SUBAGENT: "1",
          PI_SECURITY_TRANSPORT: shellExtension ? "extensions" : "internal",
          PI_POLICY_LAUNCH: JSON.stringify({ version: 1, path: manifestFile, sha256: sha(bytes) }),
          PI_SECURITY_POLICY: childFile,
          PI_SECURITY_TMP: tmp,
          TMPDIR: `${tmp}/`,
          PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
        };
        await mkdir(env.PI_CODING_AGENT_DIR, { mode: 0o700 });
        let live = true,
          cleanupComplete = false;
        let collect: (() => Promise<void>) | undefined, cleanupPromise: Promise<void> | undefined;
        const launch: PreparedChild = {
          id,
          env,
          cwd: tmp,
          tmp,
          workspaceIdentity,
          communication: child.communication,
          argv: [
            process.execPath,
            piCliPath,
            "--mode",
            "rpc",
            "--no-extensions",
            "--no-builtin-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "-e",
            extensionPath,
            ...(shellExtension ? ["-e", shellExtension] : []),
            ...(communication ? ["-e", authority!.communicationExtension!] : []),
            ...(authPayload && !auth?.fixture
              ? [
                  "-e",
                  fileURLToPath(
                    new URL(
                      import.meta.url.endsWith(".js") ? "./child-auth.js" : "./child-auth.ts",
                      import.meta.url,
                    ),
                  ),
                ]
              : []),
            ...(fixtureProviderExtension ? ["-e", fixtureProviderExtension] : []),
            "--append-system-prompt",
            installed.instructions,
            "--thinking",
            resources.thinking,
            ...(resources.model
              ? ["--provider", resources.model.provider, "--model", resources.model.id]
              : []),
            ...installed.skillPaths.flatMap((p) => ["--skill", p]),
          ],
          effectiveResources: Object.freeze({
            tools: Object.freeze([...resources.tools]),
            skills: Object.freeze(resources.skills.map((x) => x.name)),
            model: resources.model ? Object.freeze({ ...resources.model }) : undefined,
            thinking: resources.thinking,
            permissionMode: resources.permissionMode,
            permissions: child.limits,
          }),
          parentLoaded,
          childLoaded: child,
          live: true,
          isCurrent: () => live && !closed,
          beforeCleanup(callback) {
            collect = callback;
          },
          async cleanup() {
            if (cleanupComplete) return;
            if (cleanupPromise) return cleanupPromise;
            live = false;
            launch.live = false;
            launches.delete(id);
            cleanupPromise = (async () => {
              let collectionError: unknown;
              let workspaceRetained = false;
              try {
                await collect?.();
              } catch (error) {
                collectionError = error;
                try {
                  await tempScope.retainChild(tmp);
                  workspaceRetained = true;
                } catch (retainError) {
                  collectionError = new AggregateError(
                    [error, retainError],
                    `Artifact collection failed and workspace could not be retained at ${tmp}`,
                  );
                }
              }
              const cleanup = await Promise.allSettled([
                ...(workspaceRetained ? [] : [tempScope.removeChild(tmp)]),
                ...(authPath ? [rm(authPath, { force: true })] : []),
                ...(directory ? [rm(directory, { recursive: true, force: true })] : []),
              ]);
              const cleanupErrors = cleanup.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
              );
              const failures = [
                ...(collectionError
                  ? [
                      new Error(
                        `Artifact collection failed; scratch workspace path ${workspaceRetained ? `left untouched at ${tmp}` : `could not be preserved at ${tmp}`}`,
                        { cause: collectionError },
                      ),
                    ]
                  : []),
                ...cleanupErrors,
              ];
              if (failures.length === 1) throw failures[0];
              if (failures.length > 1)
                throw new AggregateError(failures, "Child launch cleanup failed");
            })();
            try {
              await cleanupPromise;
              cleanupComplete = true;
            } catch (error) {
              cleanupPromise = undefined;
              throw error;
            }
          },
        };
        launches.set(id, launch);
        return launch;
      } catch (error) {
        const cleanup = await Promise.allSettled([
          tempScope.removeChild(tmp),
          ...(authPath ? [rm(authPath, { force: true })] : []),
          ...(directory ? [rm(directory, { recursive: true, force: true })] : []),
        ]);
        const cleanupErrors = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (cleanupErrors.length)
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Child launch setup and cleanup failed",
          );
        throw error;
      }
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([...launches.values()].map((x) => x.cleanup()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "One or more child launches failed to clean up");
    },
  };
}
export async function loadChildLaunch({
  env,
  loadPolicy,
}: {
  env: NodeJS.ProcessEnv;
  loadPolicy: typeof loadPolicyFunction;
}): Promise<LoadedPolicy> {
  if (env.PI_SUBAGENT !== "1" || !env.PI_POLICY_LAUNCH) throw Error("missing child launch payload");
  const payload = JSON.parse(env.PI_POLICY_LAUNCH);
  if (
    Object.keys(payload).sort().join(",") !== "path,sha256,version" ||
    payload.version !== 1 ||
    !path.isAbsolute(payload.path)
  )
    throw Error("invalid child launch payload");
  const bytes = await readFile(payload.path);
  if (sha(bytes) !== payload.sha256) throw Error("launch manifest hash mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.version !== 1 || typeof manifest.id !== "string")
    throw Error("invalid launch manifest");
  const loaded: LoadedPolicy[] = [];
  for (const entry of [manifest.parent, manifest.child]) {
    if (!entry || !path.isAbsolute(entry.path) || sha(await readFile(entry.path)) !== entry.sha256)
      throw Error("launch policy hash mismatch");
    const value = await loadPolicy(entry.path, { project: entry.project, tmp: entry.tmp });
    Object.assign(value, metadata(entry));
    loaded.push(value);
  }
  assertNarrows(loaded[1], loaded[0]);
  if (loaded[1].launchResources) {
    for (const entry of [
      loaded[1].launchResources.instructions,
      ...loaded[1].launchResources.skills,
    ])
      if (sha(await readFile(entry.path)) !== entry.sha256)
        throw Error("child resource hash mismatch");
  }
  loaded[1].launchId = manifest.id;
  return loaded[1];
}
