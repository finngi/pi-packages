export interface Match {
  program?: string | string[];
  subcommand?: string | string[];
  "args-contain"?: string | string[];
  wrappers?: string[];
}
export interface Rule {
  id?: string;
  tool: string;
  match?: Match;
}
export interface ToolCall {
  toolCallId: string;
  parentToolCallId?: string;
}
export interface ClassifierView {
  tool: string;
  input: Record<string, unknown>;
  cwd?: string;
  userMessages?: string[];
  childTask?: string;
  assistantDecision?: { text: string; thinking: string };
}
export interface Classification {
  verdict: "allow" | "deny" | "unsure";
  reasonCode: string;
  note?: string;
}
