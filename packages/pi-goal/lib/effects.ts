import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type GoalEffectDeclaration = { kind: "none" } | { kind: "application-state" };
/** Mirrors TrustedToolReviewDescriptorV1: guards additionally treats the exact create match as
 * host admission authority, which remains live until the synchronous creation boundary. */
type GoalReviewDescriptor = {
  readonly version: 1;
  readonly description: string;
  readonly inspectAuthorization?: (
    finalInput: Readonly<Record<string, unknown>>,
    ctx: ExtensionContext,
  ) => { readonly status: "matched" | "unmatched"; readonly fields: readonly string[] } | undefined;
};
export type GoalExecutionGrant = {
  readonly signal: AbortSignal;
  assertCurrent(input?: unknown): void;
  dispatch<T>(input: unknown, operation: () => T): T;
};
export type GoalEffectRequest = {
  version: 1;
  declare(adapterId: string, toolName: string, declaration: GoalEffectDeclaration): void;
  wrapToolExecution<T extends { name: string; execute: (...args: any[]) => any }>(
    adapterId: string,
    tool: T,
    options?: { deferredDispatch?: boolean; review?: GoalReviewDescriptor },
  ): T;
};
