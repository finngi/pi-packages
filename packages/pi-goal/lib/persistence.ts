import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTokenUsage, totalTokens } from "pi-runtime/token-usage";
import type { GoalState } from "./goal.ts";
import { MAX_GOAL_CRITERIA } from "./limits.ts";
import { validGoalSpecification } from "./goal.ts";
export const ENTRY = "pi-goal.state";
export const WAITER_STATE_ENTRY = "pi-goal.waiter-state.v1";
export const CONTINUE_ENTRY = "pi-goal.continue";
export const DELIVERY_ENTRY = "pi-goal.delivery.v1";
export const USAGE_ENTRY = "pi-goal.request-usage.v1";
const nonnegative = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function commonState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const state = value as GoalState;
  return (
    typeof state.id === "string" &&
    !!state.id.trim() &&
    nonnegative(state.revision) &&
    typeof state.objective === "string" &&
    !!state.objective.trim() &&
    ["active", "paused", "blocked", "completed", "expired"].includes(state.status) &&
    nonnegative(state.turn) &&
    nonnegative(state.blockerTurns) &&
    Array.isArray(state.audit) &&
    Array.isArray(state.evidence) &&
    state.evidence.every((item) => typeof item === "string") &&
    Array.isArray(state.progressKeys) &&
    state.progressKeys.every((item) => typeof item === "string") &&
    new Set(state.progressKeys).size === state.progressKeys.length &&
    [
      state.cycleId,
      state.blocker,
      state.blockerKey,
      state.lastCountedCycle,
      state.lastCountedConditionKey,
    ].every((item) => item === undefined || typeof item === "string") &&
    !!readTokenUsage(state.usage) &&
    nonnegative(totalTokens(state.usage)) &&
    nonnegative(state.usage.missing) &&
    Array.isArray(state.usageIds) &&
    state.usageIds.every((item) => typeof item === "string") &&
    new Set(state.usageIds).size === state.usageIds.length &&
    (state.budget === undefined || (Number.isSafeInteger(state.budget) && state.budget > 0)) &&
    (state.deadlineAt === undefined ||
      (Number.isSafeInteger(state.deadlineAt) &&
        state.deadlineAt > 0 &&
        state.deadlineAt <= 8_640_000_000_000_000 &&
        new Date(state.deadlineAt).getTime() === state.deadlineAt)) &&
    (state.status !== "expired" || state.deadlineAt !== undefined)
  );
}
export function loadGoal(value: unknown): GoalState {
  if (!commonState(value))
    throw Error("The selected branch contains malformed or unsupported goal state");
  const state = value as GoalState;
  if (
    state.version !== 3 ||
    !Array.isArray(state.criteria) ||
    state.criteria.length === 0 ||
    state.criteria.length > MAX_GOAL_CRITERIA ||
    !validGoalSpecification(
      state.objective,
      state.criteria.map((item) => item?.requirement),
    ) ||
    !state.criteria.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        !!item.id.trim() &&
        typeof item.requirement === "string" &&
        !!item.requirement.trim(),
    ) ||
    new Set(state.criteria.map((item) => item.id)).size !== state.criteria.length ||
    !state.audit.every(
      (item) =>
        !!item &&
        state.criteria.some((criterion) => criterion.id === item.criterionId) &&
        typeof item.evidence === "string" &&
        !!item.evidence.trim() &&
        ["met", "unmet", "uncertain"].includes(item.verdict),
    ) ||
    new Set(state.audit.map((item) => item.criterionId)).size !== state.audit.length
  )
    throw Error("The selected branch contains malformed or unsupported goal state");
  return state;
}
export interface GoalBranchState {
  goal?: GoalState;
  disarmed: boolean;
  stopReason?: string;
}
function goalEntryState(data: unknown): GoalState | undefined {
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "state"))
    throw Error("The selected branch contains malformed goal state entry");
  const candidate = (data as { state: unknown }).state;
  return candidate === null ? undefined : loadGoal(candidate);
}
/** Read only this extension's current records in selected-branch order. */
export function readGoalBranch(ctx: ExtensionContext): GoalBranchState {
  let goal: GoalState | undefined;
  let disarmed = false;
  let stopReason: string | undefined;
  let invalidGoalState: Error | undefined;
  let invalidWaiterState: Error | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    const type = entry.customType;
    if (type === ENTRY) {
      try {
        const next = goalEntryState(entry.data);
        if (!next) {
          // A human /goal clear appends an explicit tombstone. Let it recover a
          // branch whose earlier goal record cannot be decoded.
          goal = undefined;
          invalidGoalState = undefined;
        } else goal = next;
      } catch (error) {
        invalidGoalState =
          error instanceof Error
            ? error
            : Error("The selected branch contains malformed goal state");
      }
    } else if (type === WAITER_STATE_ENTRY) {
      const state =
        entry.data && typeof entry.data === "object"
          ? (entry.data as { version?: unknown; disarmed?: unknown; stopReason?: unknown })
          : undefined;
      if (
        state?.version !== 1 ||
        typeof state.disarmed !== "boolean" ||
        (state.stopReason !== undefined &&
          (typeof state.stopReason !== "string" ||
            !state.stopReason.trim() ||
            state.stopReason.length > 160 ||
            /[\x00-\x1f\x7f]/.test(state.stopReason)))
      ) {
        invalidWaiterState = Error("The selected branch contains malformed goal waiter state");
      } else {
        disarmed = state.disarmed;
        stopReason = state.disarmed ? (state.stopReason as string | undefined) : undefined;
        if (!state.disarmed) invalidWaiterState = undefined;
      }
    }
  }
  if (invalidGoalState) throw invalidGoalState;
  if (invalidWaiterState) throw invalidWaiterState;
  return { goal, disarmed, ...(stopReason ? { stopReason } : {}) };
}
export function stateFrom(ctx: ExtensionContext): GoalState | undefined {
  return readGoalBranch(ctx).goal;
}
