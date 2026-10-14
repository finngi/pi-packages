import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkspaceIdentity } from "pi-contracts";
import type { TSchema } from "typebox";

// The registry contains different schemas; Pi validates each call before execution.
export type EffectTool = ToolDefinition<TSchema, unknown>;

export interface ExecutionPermissions {
  execution?: "sandbox" | "host";
  write: boolean;
  network: string[][];
}
export interface PermissionLimits {
  write: boolean;
  network: boolean;
}
export type HostCapability = "gpu" | "host-execution";
export type AgentThinking = ThinkingLevel | "off";
export type PermissionMode = "auto" | "manual";
export interface Match {
  program?: string | string[];
  subcommand?: string | string[];
  "args-contain"?: string | string[];
  paths?: "read" | "write";
  wrappers?: string[];
}
export interface Rule {
  id?: string;
  tool: string;
  match?: Match;
  permissions?: { write?: boolean; network?: string[] };
}
export interface FilesystemScope {
  readDeny: string[];
  writeAllow: string[];
  writeDeny: string[];
}
export interface Policy {
  version: 2;
  mode: "auto" | "manual";
  resources: { write: string[]; denyRead: string[]; denyWrite: string[]; network: string[] };
  classifier: { model: string; timeoutSec: number };
  approvalTimeoutSec: number;
  env: { path: string[]; assignAllow: string[] };
  deny: Rule[];
  allow: Rule[];
}
export interface WriteGrant {
  path: string;
  source: string;
  kind: "file" | "directory";
  createParents: string[];
}
export interface Decision {
  verdict: "allow" | "deny" | "ask";
  ruleIds?: string[];
  permissions?: ExecutionPermissions;
  reason: string;
  writeGrants?: WriteGrant[];
}
export interface CallInput {
  command?: string;
  path?: string;
  background?: boolean;
  permissions?: { execution?: "sandbox" | "host"; write?: string[]; network?: string[] };
  [key: string]: unknown;
}
export interface ToolCall {
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  input: CallInput;
  cwd?: string;
  agentName?: string;
}
export interface TempIsolation {
  base: string;
  own: string;
  launchDir: string;
  resourceReadAllow?: string[];
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
export interface AgentBundle {
  root: string;
  privateSkills: Skill[];
}
export interface StaticContextFile {
  path: string;
  content: string;
}
export interface ChildSpec {
  task: string;
  allowIds?: string[];
  writeAllow?: string[];
  networkHosts?: string[];
  permissions?: Partial<PermissionLimits>;
  readDeny?: string[];
  writeDeny?: string[];
  instructions?: string;
  tools?: string[];
  skills?: string[];
  model?: SelectedModel;
  thinking?: AgentThinking;
  permissionMode?: PermissionMode;
  communication?: Communication;
  agentBundle?: AgentBundle;
  staticContext?: { originalCwd: string; files: StaticContextFile[]; instructions?: string };
}
export interface ChildResources {
  instructions: string;
  tools: string[];
  skills: Skill[];
  model?: SelectedModel;
  thinking: AgentThinking;
  requested: { tools: boolean; skills: boolean; model: boolean; thinking: boolean };
  permissionMode?: PermissionMode;
  agentBundle?: AgentBundle;
  staticContext?: { originalCwd: string; files: StaticContextFile[]; instructions?: string };
}
export interface ParentResources {
  tools: string[];
  skills: Skill[];
  model?: SelectedModel;
  models?: readonly Model<Api>[];
  thinking?: AgentThinking;
  communicationExtension?: string;
  userMessages?: string[];
}
export interface LoadedPolicy {
  policy: Policy;
  filesystem: FilesystemScope;
  project: string;
  tmp: string;
  sha256?: string;
  limits?: PermissionLimits;
  capabilities?: HostCapability[];
  agentDepth?: number;
  childTask?: string;
  tempIsolation?: TempIsolation;
  resources?: ChildResources;
  launchResources?: {
    directory: string;
    instructions: { path: string; sha256: string };
    skills: { name: string; path: string; sha256: string }[];
    bundle?: {
      path: string;
      sourceRoot: string;
      skills: { name: string; path: string; sourcePath: string; sha256: string }[];
    };
  };
  resourceAuthority?: Pick<ParentResources, "tools" | "skills"> & {
    /** Exact private skill paths staged for this launch; never a general directory grant. */
    privateSkills?: Skill[];
  };
  authorization?: { userMessages: string[] };
  communication?: Communication & { extensionPath: string };
  launchId?: string;
}
export interface PreparedChild {
  id: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  tmp: string;
  workspaceIdentity?: WorkspaceIdentity;
  argv: string[];
  communication?: LoadedPolicy["communication"];
  effectiveResources: Readonly<{
    tools: readonly string[];
    skills: readonly string[];
    model?: Readonly<SelectedModel>;
    thinking: AgentThinking;
    permissionMode?: PermissionMode;
    permissions?: Readonly<PermissionLimits>;
  }>;
  parentLoaded: LoadedPolicy;
  childLoaded: LoadedPolicy;
  live: boolean;
  isCurrent(): boolean;
  cleanup(): Promise<void>;
  beforeCleanup?(callback: () => Promise<void>): void;
  askSeen?: Set<string>;
}
export type AskContext = Pick<ExtensionContext, "hasUI" | "ui">;
export interface ClassifierView {
  tool: string;
  input: CallInput;
  cwd?: string;
  permissions: ExecutionPermissions;
  writeGrants?: Pick<WriteGrant, "path" | "kind" | "createParents">[];
  depth?: number;
  userMessages?: string[];
  childTask?: string;
  assistantDecision?: { text: string; thinking: string };
}
export interface Classification {
  verdict: "allow" | "deny" | "unsure";
  reasonCode: string;
  labels: string[];
  note?: string;
}
export interface AskResolverOptions {
  policy: Policy;
  classify?: (view: ClassifierView, options: Policy["classifier"]) => Promise<Classification>;
  authority: (call: ToolCall) => {
    userMessages?: string[];
    depth?: number;
    childTask?: string;
    assistantDecision?: ClassifierView["assistantDecision"];
  };
}
export interface WrappedShell {
  execution?: "host";
  profile: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  sandboxArgv?: string[];
}
export interface ProfileOptions {
  policyPath?: string;
  extensionPath?: string;
  fetchLease?: { port: number };
  writeGrants?: WriteGrant[];
}
export interface WrapOptions extends ProfileOptions {
  assertCurrent?: () => void;
  profileText?: string;
  envAssign?: NodeJS.ProcessEnv;
}
export interface FetchLease {
  port: number;
  env: Record<string, string>;
  release(): Promise<void>;
}
export interface ChildAuth {
  model: Model<Api>;
  auth: Extract<Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>, { ok: true }>;
  fixture?: boolean;
}
export interface ChildAuthOptions {
  fixtureProviderExtension?: string;
}
export interface RpcSelect {
  id: string;
  method: string;
  title?: string;
  options?: string[];
}
