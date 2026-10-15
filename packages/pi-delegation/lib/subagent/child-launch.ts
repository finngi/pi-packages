import { StringDecoder } from "node:string_decoder";
import type { ChildLaunchService, PreparedChild } from "pi-contracts";
import { type ArtifactResult, collectArtifacts, USAGE_BRIDGE, type UsageRecord } from "pi-runtime";
import type { BackgroundService } from "../background/service.ts";
import type { AgentDef } from "./agents.ts";
import { displayAgentName, MESSAGE_BRIDGE } from "./messages.ts";
import { RpcDialogue } from "./rpc-dialogue.ts";

export function restrictionSpec(
  agent: AgentDef,
  task: string,
  settings?: ReturnType<typeof import("./settings.ts").resolveSettings>,
  staticContext?: {
    originalCwd: string;
    files: Array<{ path: string; content: string }>;
    instructions?: string;
  },
): Record<string, unknown> {
  return {
    task,
    instructions: agent.body,
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(settings?.skills === undefined
      ? agent.skills === undefined
        ? {}
        : { skills: agent.skills }
      : { skills: settings.skills }),
    ...(settings?.model ? { model: settings.model } : {}),
    ...(settings?.thinking ? { thinking: settings.thinking } : {}),
    ...(agent.bundleRoot
      ? {
          agentBundle: {
            root: agent.bundleRoot,
            privateSkills: agent.privateSkills ?? [],
          },
        }
      : {}),
    ...(staticContext ? { staticContext } : {}),
  };
}
export async function launchChild({
  launcher,
  transport,
  spec,
  isCurrent,
  onReply,
  onFailure,
  onMessage,
  onSelect,
  onUsage,
  artifactDirectory,
}: {
  launcher: ChildLaunchService;
  transport: BackgroundService;
  spec: Record<string, unknown>;
  isCurrent: () => boolean;
  onReply?: (reply: import("./rpc-dialogue.ts").DialogueReply) => void;
  onFailure?: () => void;
  onMessage?: (
    request: Record<string, unknown>,
    sourceRequestIds: string[],
  ) => Promise<Record<string, unknown>>;
  onUsage?: (record: UsageRecord) => void;
  onSelect?: (request: {
    title: string;
    options: string[];
    signal: AbortSignal;
  }) => Promise<string | undefined>;
  artifactDirectory?: string;
}) {
  if (!isCurrent()) throw Error("child session expired");
  const prepared: PreparedChild = await launcher.prepareChildLaunch(spec);
  let worker: RpcDialogue | undefined,
    buffer = "",
    decoder = new StringDecoder("utf8");
  const pending: { stream: "stdout" | "stderr"; bytes: Buffer }[] = [];
  const uiRequests = new AbortController();
  let id = "",
    transportSettled = false;
  // Background process records are bounded and may be evicted after completion. This ID is
  // transport-private; a missing record here means the process already exited and was reaped.
  const cancelTransport = (reason?: string) => {
    uiRequests.abort();
    if (transportSettled) return;
    try {
      transport.cancel(id, reason);
    } catch (error) {
      if (error instanceof Error && error.message === `Unknown background process: ${id}`) return;
      throw error;
    }
  };
  try {
    if (!isCurrent() || prepared.isCurrent?.() === false)
      throw Error("child session expired before spawn");
    const run = transport.launch(
      {
        command: prepared.argv[0],
        args: prepared.argv.slice(1),
        env: prepared.env,
        cwd: prepared.cwd,
        owner: "subagent",
        label:
          spec.communication && typeof spec.communication === "object"
            ? `${displayAgentName(String((spec.communication as { name: string }).name))} agent`
            : "Delegated agent",
        stdin: "pipe",
        onData(stream, bytes) {
          if (stream === "stdout") {
            buffer += decoder.write(bytes);
            if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
              cancelTransport("oversize child RPC");
              return;
            }
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              // Observe each line in wire order before associating the next telemetry frame.
              const record = Buffer.from(`${line}\n`);
              if (worker) worker.data("stdout", record);
              else pending.push({ stream: "stdout", bytes: record });
              let value: Record<string, unknown>;
              try {
                value = JSON.parse(line);
              } catch {
                continue;
              }
              if (!value || typeof value !== "object" || Array.isArray(value)) continue;
              if (value.type === "extension_ui_request" && value.method === "select") {
                const sourceRequestIds = worker?.activeRequestIds() ?? [];
                void Promise.resolve()
                  .then(async () => {
                    if (!isCurrent()) throw Error("child session expired");
                    const response =
                      typeof value.title === "string" && value.title.startsWith(USAGE_BRIDGE)
                        ? (() => {
                            if (JSON.stringify(value.options) !== JSON.stringify(["Record"]))
                              throw Error("Invalid accounting frame");
                            const record = JSON.parse(value.title.slice(USAGE_BRIDGE.length));
                            if (record.kind !== "classifier" || typeof record.id !== "string")
                              throw Error("Invalid classifier accounting frame");
                            worker?.accountAuxiliary(record);
                            return {
                              type: "extension_ui_response",
                              id: value.id,
                              value: "recorded",
                            };
                          })()
                        : typeof value.title === "string" && value.title.startsWith(MESSAGE_BRIDGE)
                          ? ((await onMessage?.(value, sourceRequestIds)) ?? {
                              type: "extension_ui_response",
                              id: value.id,
                              value: JSON.stringify({
                                accepted: false,
                                error: "Agent messaging is unavailable",
                              }),
                            })
                          : {
                              type: "extension_ui_response",
                              id: value.id,
                              value:
                                typeof value.title === "string" &&
                                Array.isArray(value.options) &&
                                value.options.every((option) => typeof option === "string")
                                  ? await onSelect?.({
                                      title: value.title,
                                      options: value.options as string[],
                                      signal: uiRequests.signal,
                                    })
                                  : undefined,
                            };
                    if (!isCurrent()) throw Error("child session expired");
                    await transport.write(id, Buffer.from(JSON.stringify(response) + "\n"));
                  })
                  .catch(() => cancelTransport("child approval failed"));
              }
            }
          }
          if (stream === "stderr") {
            if (worker) worker.data(stream, bytes);
            else pending.push({ stream, bytes });
          }
        },
      },
      { notify: false },
    );
    void run.done.then(() => {
      uiRequests.abort();
      transportSettled = true;
    });
    id = run.id;
    worker = new RpcDialogue(
      transport,
      id,
      onReply,
      onFailure,
      () => isCurrent() && (prepared.isCurrent?.() ?? true),
      true,
      onUsage,
    );
    for (const event of pending) worker.data(event.stream, event.bytes);
    let artifacts: ArtifactResult | undefined;
    let collection: Promise<ArtifactResult | undefined> | undefined,
      collectionFailed = false;
    const collect = () => {
      if (!collection) {
        collection = (
          artifactDirectory
            ? collectArtifacts(prepared, artifactDirectory).then((value) => {
                artifacts = value;
                return value;
              })
            : Promise.resolve(undefined)
        ).catch((error) => {
          collectionFailed = true;
          throw error;
        });
      }
      return collection;
    };
    prepared.beforeCleanup?.(async () => {
      worker?.close();
      cancelTransport();
      await run.done;
      await collect();
    });
    let finalized: Promise<ArtifactResult | undefined> | undefined;
    const finalize = () => {
      if (!finalized) {
        finalized = run.done.then(async (snapshot) => {
          worker?.complete(snapshot);
          let collectionError: unknown;
          let collectionFailed = false;
          try {
            await collect();
          } catch (error) {
            collectionError = error;
            collectionFailed = true;
          }
          let cleanupError: unknown;
          let cleanupFailed = false;
          try {
            await prepared.cleanup();
          } catch (error) {
            cleanupError = error;
            cleanupFailed = true;
          }
          if (collectionFailed && cleanupFailed)
            throw new AggregateError(
              [collectionError, cleanupError],
              "Child artifact collection and cleanup failed",
            );
          if (collectionFailed) throw collectionError;
          if (cleanupFailed) throw cleanupError;
          return artifacts;
        });
        void finalized.catch(() => {
          finalized = undefined;
          if (collectionFailed) {
            collection = undefined;
            collectionFailed = false;
          }
        });
      }
      return finalized;
    };
    void finalize().catch(() => {});
    return {
      id,
      dialogue: worker,
      prepared,
      artifacts: () => artifacts,
      async start(task: string, beforeDispatch?: (requestId: string) => void) {
        return worker!.start(task, beforeDispatch);
      },
      async close() {
        const busy = worker!.snapshot().status === "busy";
        await worker!.reconcileUsage();
        if (busy)
          onUsage?.({
            id: `${id}:interrupted`,
            kind: "child",
            source: id,
            label: "Interrupted child",
            incomplete: true,
          });
        worker!.close();
        cancelTransport();
        await finalize();
        return artifacts;
      },
    };
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}
