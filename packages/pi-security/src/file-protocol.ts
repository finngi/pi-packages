import type { AgentToolResult, GrepToolDetails } from "@earendil-works/pi-coding-agent";

export interface HelperArguments {
  readFile: { path: string };
  access: { path: string; write: boolean };
  detectImageMimeType: { path: string };
  writeFile: { path: string; content: string };
  mkdir: { path: string };
  exists: { path: string };
  stat: { path: string };
  readdir: { path: string };
  rename: { from: string; to: string };
  glob: { pattern: string; cwd: string; options: { limit: number; ignore: string[] } };
  grep: {
    path: string;
    pattern: string;
    ignoreCase?: boolean;
    literal?: boolean;
    glob?: string;
    limit?: number;
    context?: number;
  };
}
export interface HelperResults {
  readFile: string;
  access: null;
  detectImageMimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null;
  writeFile: null;
  mkdir: null;
  exists: boolean;
  stat: { isDirectory: boolean };
  readdir: string[];
  rename: null;
  glob: string[];
  grep: Omit<AgentToolResult<GrepToolDetails>, "details"> & { details?: GrepToolDetails };
}
export type HelperOperation = keyof HelperArguments;
export type HelperCall = {
  [K in HelperOperation]: [K, HelperArguments[K], AbortSignal];
}[HelperOperation];
export type HelperRequest =
  | {
      [K in HelperOperation]: { id: number; op: K; args: HelperArguments[K]; cancel?: false };
    }[HelperOperation]
  | { id: number; cancel: true };
export interface HelperResponse {
  id?: number;
  ready?: boolean;
  processGroup?: { pid: number; state: "started" | "stopped" };
  result?: HelperResults[HelperOperation];
  error?: { message: string; code?: string; errno?: number; syscall?: string; path?: string };
}
export interface FileClient {
  readyMs: number;
  request<K extends HelperOperation>(
    op: K,
    args: HelperArguments[K],
    options?: { signal?: AbortSignal },
  ): Promise<HelperResults[K]>;
  close(): Promise<void>;
}
