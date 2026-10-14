import type { createChildLauncher } from "./child-launch.ts";
import type { SearchCapability, SearchSpec } from "./search-capability.ts";
import type { CallInput, LoadedPolicy, RpcSelect } from "./types.ts";

export interface ShellSpec {
  toolCallId: string;
  input: CallInput;
  cwd?: string;
  signal?: AbortSignal;
}
import type { PreparedShell } from "pi-contracts";
export type { PreparedShell } from "pi-contracts";
type ChildLauncher = ReturnType<typeof createChildLauncher>;
export interface SecurityService {
  version: 1;
  prepareShell(spec: ShellSpec): Promise<PreparedShell>;
  prepareSearch(spec: SearchSpec): SearchCapability;
  describeChild: ChildLauncher["describeChild"];
  getAgentContext():
    | (NonNullable<LoadedPolicy["communication"]> & { workspace: string })
    | undefined;
  prepareChildLaunch: ChildLauncher["prepareChildLaunch"];
  handleChildAsk(
    launchId: string,
    request: RpcSelect,
  ): Promise<{ type: string; id: string; value: string }>;
}
