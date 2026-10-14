import { newSemanticId } from "pi-runtime";
export { SEMANTIC_WORDS as AGENT_WORDS } from "pi-runtime";
export function newAgentId(): string {
  return newSemanticId("agent");
}
