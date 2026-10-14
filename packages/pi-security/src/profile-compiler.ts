import { Worker } from "node:worker_threads";
import type { ExecutionPermissions, LoadedPolicy, ProfileOptions } from "./types.ts";
import { compileProfile } from "./profiles.ts";

/** Keep filesystem-dependent write profiles off the Pi UI thread; never cache their snapshot. */
export async function compileProfileAsync(
  loaded: LoadedPolicy,
  permissions: ExecutionPermissions,
  options: ProfileOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!permissions.write) return compileProfile(loaded, permissions, options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".js") ? "./profile-worker.js" : "./profile-worker.ts",
        import.meta.url,
      ),
      {
        execArgv: [],
        workerData: {
          loaded: {
            policy: loaded.policy,
            filesystem: loaded.filesystem,
            project: loaded.project,
            tmp: loaded.tmp,
            limits: loaded.limits,
            capabilities: loaded.capabilities,
            tempIsolation: loaded.tempIsolation,
          },
          permissions,
          options: {
            policyPath: options.policyPath,
            extensionPath: options.extensionPath,
            writeGrants: options.writeGrants,
            fetchLease: options.fetchLease && { port: options.fetchLease.port },
          },
        },
      },
    );
    const abort = () => {
      void worker.terminate();
      reject(signal?.reason ?? Error("profile preparation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      reject(Error(`profile preparation exited without a result (code ${code})`));
    });
  });
}
