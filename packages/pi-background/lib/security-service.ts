import type { PreparedShell } from "pi-contracts";
export type { PreparedShell } from "pi-contracts";
export interface PreparedChild {
  id: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  tmp: string;
  cleanup(): Promise<void>;
}
export interface SecurityService {
  version: 1;
  prepareShell(spec: {
    toolCallId: string;
    input: unknown;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<PreparedShell>;
  prepareChildLaunch(spec: Record<string, unknown>): Promise<PreparedChild>;
  handleChildAsk(id: string, request: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export const securitySelected = () => process.env.PI_SECURITY_TRANSPORT === "extensions";
export function securityService(events: {
  emit(name: string, value: unknown): void;
}): SecurityService {
  const found: SecurityService[] = [];
  events.emit("pi-security:service:v1", {
    version: 1,
    respond: (service: SecurityService) => found.push(service),
  });
  if (
    found.length !== 1 ||
    found[0].version !== 1 ||
    typeof found[0].prepareShell !== "function" ||
    typeof found[0].prepareChildLaunch !== "function"
  )
    throw Error("pi-security service unavailable or duplicated");
  return found[0];
}
