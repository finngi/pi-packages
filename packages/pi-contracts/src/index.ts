import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_SERVICE = "background:service";
export const USAGE_EVENT = "pi-runtime:usage:v1";
export const SESSION_SETUP_SERVICE = "pi-session-setup:service:v1";
export const SESSION_SETUP_CONTRIBUTIONS = "pi-session-setup:contribute:v1";
export const SESSION_SETUP_STATE = "pi-session-setup:v1";
/** Saved behavioral defaults for a child, independent of temporary parent selections. */
export const SAVED_INSTRUCTION_CONTEXT = "pi-context:saved-instructions:v1";
export interface SavedInstructionContextRequest {
  version: 1;
  ctx: ExtensionContext;
  contribute(instructions: string): void;
  reject(reason: string): void;
}
export type SessionSetupKind = "packages" | "skills" | "agents" | "instructions" | "tools";
export type SessionSetupSelectionKind = Exclude<SessionSetupKind, "packages">;
export type SessionSetupOverrides = Partial<Record<SessionSetupSelectionKind, string[]>>;
export interface SessionSetupCandidate {
  kind: SessionSetupKind;
  id: string;
  name: string;
  description: string;
  keywords?: string;
  packName?: string;
  path?: string;
  exposure?: string;
  activation?: "active" | "checked-on-apply";
  model?: string;
  modelLocked?: boolean;
  manualOnly?: boolean;
  globalDefaultable?: boolean;
  /** Whether this resource is enabled by the package's native selection when settings are absent. */
  nativeDefault?: boolean;
}
export interface SessionSetupContribution {
  kind: SessionSetupKind;
  candidates: SessionSetupCandidate[];
  selected: string[];
}
export interface SessionSetupContributionRequest {
  version: 1;
  ctx: ExtensionContext;
  contribute(value: SessionSetupContribution): void;
}
export interface SessionSetupService {
  version: 1;
  /** Undefined inherits saved defaults; an empty array deliberately clears this subset. */
  selection(kind: SessionSetupSelectionKind): string[] | undefined;
  inspect(ctx: ExtensionContext): SessionSetupContribution[];
  restore(ctx: ExtensionContext, refreshUniverse?: boolean): void;
  execute(input: unknown, ctx: ExtensionContext): SessionSetupResult;
}
export interface SessionSetupResult {
  op: string;
  selected: Record<SessionSetupSelectionKind, string[]>;
  overrides: SessionSetupOverrides;
  candidates: SessionSetupCandidate[];
  total: number;
  effects: Record<string, string>;
  error?: string;
}
export interface SessionSetupRequest {
  op: "list" | "apply" | "reset";
  query?: string;
  kinds?: SessionSetupKind[];
  limit?: number;
  packages?: string[];
  skills?: string[];
  agents?: string[];
  instructions?: string[];
  tools?: string[];
}
/** Trusted hook-only extensions may join an explicitly prepared child launch. */
export const CHILD_LAUNCH_CONTRIBUTIONS = "pi-child-launch:contribute:v1";
export interface ChildLaunchContribution {
  extension: string;
  /** Only PI_CHILD_EXTENSION_* names may be supplied. */
  env?: Record<string, string>;
}
export interface ChildLaunchContributionRequest {
  version: 1;
  ctx: ExtensionContext;
  contribute(value: ChildLaunchContribution): void;
  reject(reason: string): void;
}

export interface Communication {
  id: string;
  name: string;
  parentId: string;
  parentName: string;
}
export interface SelectedModel {
  provider: string;
  id: string;
}
export interface Skill {
  name: string;
  path: string;
  description?: string;
}
/** Trusted bundle metadata attached by agent discovery, never supplied by a model tool argument. */
export interface AgentBundle {
  root: string;
  privateSkills: Skill[];
}
export interface StaticContextFile {
  path: string;
  content: string;
}
export interface ResourceSpec {
  instructions?: string;
  tools?: string[];
  skills?: string[];
  model?: SelectedModel;
  thinking?: ThinkingLevel | "off";
  communication?: Communication;
  agentBundle?: AgentBundle;
  staticContext?: { originalCwd: string; files: StaticContextFile[]; instructions?: string };
}
export interface ResourceAuthority {
  tools: string[];
  /** Native registration entrypoints; supplied by the host, never a task argument. */
  toolSources?: Record<string, string>;
  skills: Skill[];
  model?: SelectedModel;
  models?: readonly Model<Api>[];
  thinking?: ThinkingLevel | "off";
  communicationExtension?: string;
}
export interface ChildResources {
  extensions?: string[];
  instructions: string;
  tools: string[];
  skills: Skill[];
  model?: SelectedModel;
  thinking: ThinkingLevel | "off";
  requested: { tools: boolean; skills: boolean; model: boolean; thinking: boolean };
  agentBundle?: AgentBundle;
  staticContext?: { originalCwd: string; files: StaticContextFile[]; instructions?: string };
}
export interface WorkspaceIdentity {
  path: string;
  dev: number;
  ino: number;
}
export interface PreparedChild {
  id: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  tmp: string;
  /** Canonical scratch-workspace identity captured before the child process starts. */
  workspaceIdentity?: WorkspaceIdentity;
  workspaceKind?: "scratch" | "project";
  communication?: Communication;
  effectiveResources?: Readonly<{
    tools: readonly string[];
    skills: readonly string[];
    model?: Readonly<SelectedModel>;
    thinking: string;
    permissions?: Readonly<{ write: boolean; network: boolean }>;
  }>;
  isCurrent?(): boolean;
  beforeCleanup?(callback: () => Promise<void>): void;
  cleanup(): Promise<void>;
}
export interface ChildLaunchService {
  version: 1;
  describeChild(spec: Record<string, unknown>): Promise<Record<string, unknown>>;
  prepareChildLaunch(spec: Record<string, unknown>): Promise<PreparedChild>;
}

export type Stream = "stdout" | "stderr";
export type ProcessStatus = "running" | "completed" | "failed" | "cancelled";
export interface ProcessResult {
  text?: string;
  summary?: string;
  details?: unknown;
  failed?: boolean;
}
export interface ProcessSnapshot {
  id: string;
  owner: string;
  label: string;
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason?: string;
  outputBytes: number;
  retainedFrom: number;
  executionExited: boolean;
  streamsClosed: boolean;
  result?: ProcessResult;
}
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  owner: string;
  label: string;
  timeoutMs?: number;
  stdin?: "closed" | "pipe";
  onData?: (stream: Stream, data: Buffer) => void;
  onComplete?: (snapshot: ProcessSnapshot) => ProcessResult;
}
export interface ProcessRead {
  cursor: number;
  nextCursor: number;
  retainedFrom: number;
  gap: boolean;
  chunks: { stream: Stream; start: number; end: number; data: Buffer }[];
}
export interface BackgroundService {
  launch(
    spec: LaunchSpec,
    options?: { notify?: boolean; notifyIfCurrent?: () => boolean },
  ): { id: string; done: Promise<ProcessSnapshot> };
  status(id: string): ProcessSnapshot;
  read(id: string, cursor?: number, maxBytes?: number): ProcessRead;
  write(id: string, data: Uint8Array, end?: boolean): Promise<void>;
  cancel(id: string, reason?: string): void;
  close(): Promise<void>;
}
