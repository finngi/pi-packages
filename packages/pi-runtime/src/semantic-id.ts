import { randomInt } from "node:crypto";
import { SEMANTIC_WORDS } from "./semantic-words.ts";

export type SemanticIdKind =
  | "agent"
  | "tool"
  | "message"
  | "process"
  | "goal"
  | "wait"
  | "artifact"
  | "task";

/** Return a readable ID with three distinct words sampled without replacement. */
export function newSemanticId(kind: SemanticIdKind): string {
  const words = [...SEMANTIC_WORDS];
  const parts = Array.from({ length: 3 }, () => words.splice(randomInt(words.length), 1)[0]);
  return `${kind}-${parts.join("-")}`;
}
