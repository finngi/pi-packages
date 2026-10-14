import path from "node:path";
import { securityFailure } from "./errors.ts";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  LsOperations,
  FindOperations,
  GrepToolInput,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { CallInput, ExecutionPermissions, EffectTool, WriteGrant } from "./types.ts";
import type { FileClient, HelperOperation, HelperArguments } from "./file-protocol.ts";
type FileOperations = ReadOperations &
  WriteOperations &
  EditOperations &
  LsOperations &
  FindOperations;
type FileFactory = (cwd: string, options?: { operations: FileOperations }) => EffectTool;

export function createFileToolDefinitions({
  cwd,
  clientForPermissions,
}: {
  cwd: string;
  clientForPermissions: (
    permissions: ExecutionPermissions,
    grants?: WriteGrant[],
  ) => Promise<FileClient>;
}) {
  const factories = {
    read: createReadToolDefinition,
    write: createWriteToolDefinition,
    edit: createEditToolDefinition,
    ls: createLsToolDefinition,
    find: createFindToolDefinition,
    grep: createGrepToolDefinition,
  } as unknown as Record<string, FileFactory>;
  const definitions: Record<string, EffectTool> = {};
  for (const [name, factory] of Object.entries(factories)) {
    const definition = factory(cwd);
    definitions[name] = {
      ...definition,
      ...(name === "ls" || name === "find" || name === "grep" ? { defaultActive: false } : {}),
      async execute(
        id,
        input: CallInput,
        signal,
        onUpdate,
        ctx: ExtensionToolContext & {
          securityPermissions?: ExecutionPermissions;
          securityWriteGrants?: WriteGrant[];
        },
      ) {
        if (
          !ctx?.securityPermissions ||
          typeof ctx.securityPermissions.write !== "boolean" ||
          !Array.isArray(ctx.securityPermissions.network) ||
          ctx.securityPermissions.network.length
        )
          return securityFailure("missing or invalid bound file permissions");
        let client: FileClient;
        try {
          client = await clientForPermissions(ctx.securityPermissions!, ctx.securityWriteGrants);
        } catch (error) {
          return securityFailure((error as Error)?.message || String(error));
        }
        try {
          const request = <K extends HelperOperation>(op: K, args: HelperArguments[K]) =>
            client.request(op, args, { signal });
          const operations: FileOperations = {
            readFile: async (p) => Buffer.from(await request("readFile", { path: p }), "base64"),
            access: async (p) => {
              await request("access", { path: p, write: name === "edit" });
            },
            detectImageMimeType: async (p) =>
              (await request("detectImageMimeType", { path: p })) ?? undefined,
            writeFile: async (p, content) => {
              await request("writeFile", { path: p, content });
            },
            mkdir: async (p) => {
              await request("mkdir", { path: p });
            },
            exists: (p) => request("exists", { path: p }),
            stat: async (p) => {
              const s = await request("stat", { path: p });
              return { isDirectory: () => s.isDirectory };
            },
            readdir: (p) => request("readdir", { path: p }),
            glob: (pattern, searchCwd, options) =>
              request("glob", { pattern, cwd: searchCwd, options }),
          };
          if (name === "grep") {
            const result = await request("grep", {
              ...(input as GrepToolInput),
              path: path.resolve(ctx?.cwd ?? cwd, input.path ?? "."),
            });
            return { ...result, details: result.details };
          }
          const effectiveInput =
            ctx.securityWriteGrants?.length && (name === "write" || name === "edit")
              ? { ...input, path: ctx.securityWriteGrants[0].path }
              : input;
          return await factory(cwd, { operations }).execute(
            id,
            effectiveInput,
            signal,
            onUpdate,
            ctx,
          );
        } finally {
          if (ctx.securityWriteGrants?.length) await client.close();
        }
      },
    };
  }
  return definitions;
}
