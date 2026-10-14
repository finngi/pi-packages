export type {
  Stream,
  ProcessStatus as Status,
  ProcessResult,
  ProcessSnapshot as Snapshot,
  LaunchSpec,
  ProcessRead as ReadResult,
} from "pi-contracts";
export interface ProcessLimits {
  concurrent?: number;
  concurrentAgents?: number;
  retained?: number;
  outputBytes?: number;
  inputBytes?: number;
  killGraceMs?: number;
  drainMs?: number;
  writeMs?: number;
}
