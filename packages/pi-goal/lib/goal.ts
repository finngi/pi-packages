import {
  addTokenUsage,
  readTokenUsage,
  type TokenUsage,
  totalTokens,
} from "pi-runtime/token-usage";
import { newSemanticId } from "pi-runtime/semantic-id";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { type GoalEvaluation, validateEvaluation } from "./evaluator.ts";
import {
  MAX_GOAL_CRITERIA,
  MAX_GOAL_EVIDENCE_TOKENS,
  MAX_GOAL_SPEC_CHARS,
  MAX_GOAL_TEXT_FIELD_CHARS,
} from "./limits.ts";

export { MAX_GOAL_CRITERIA } from "./limits.ts";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "expired";
export interface GoalCriterion {
  id: string;
  requirement: string;
}
export interface GoalAudit {
  criterionId: string;
  evidence: string;
  verdict: "met" | "unmet" | "uncertain";
}
export interface GoalState {
  version: 3;
  id: string;
  revision: number;
  objective: string;
  criteria: GoalCriterion[];
  status: GoalStatus;
  turn: number;
  cycleId?: string;
  blocker?: string;
  blockerKey?: string;
  blockerTurns: number;
  lastCountedCycle?: string;
  lastCountedConditionKey?: string;
  audit: GoalAudit[];
  evidence: string[];
  progressKeys: string[];
  budget?: number;
  deadlineAt?: number;
  usage: TokenUsage & { missing: number };
  usageIds: string[];
}
export interface GoalCreateAuthorization {
  objective: string;
  budget?: number;
  criteria?: string[];
  deadline?: string;
}
const MAX_GOAL_DEADLINE_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
function isFutureDeadline(value: number, now: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > now &&
    value - now <= MAX_GOAL_DEADLINE_MS &&
    new Date(value).getTime() === value
  );
}
export interface OwnedWaiterValueV1 {
  deliveryKey: string;
  value: unknown;
}
export type OwnedWaiterAcceptanceV1 =
  | { accepted: false }
  | {
      accepted: true;
      scope: { goalId: string; revision: number; branchToken: string };
      release(): void;
    };
/** A producer retains ownership until the goal accepts an exact scoped offer. */
export interface OwnedWaiterOfferV1 {
  version: 1;
  id: string;
  owner: string;
  sessionId: string;
  producerGeneration: string;
  promise: Promise<OwnedWaiterValueV1>;
  isCurrent(): boolean;
  respond(result: OwnedWaiterAcceptanceV1): void;
}
export function validCriteria(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_GOAL_CRITERIA &&
    value.every(
      (item) =>
        typeof item === "string" && !!item.trim() && item.length <= MAX_GOAL_TEXT_FIELD_CHARS,
    ) &&
    new Set(value).size === value.length
  );
}
export function validGoalSpecification(objective: unknown, criteria?: unknown): boolean {
  if (
    typeof objective !== "string" ||
    !objective.trim() ||
    objective.length > MAX_GOAL_TEXT_FIELD_CHARS ||
    (criteria !== undefined && !validCriteria(criteria))
  )
    return false;
  const requirements = criteria === undefined ? [objective] : criteria;
  if (
    objective.length + requirements.reduce((sum, item) => sum + item.length, 0) >
    MAX_GOAL_SPEC_CHARS
  )
    return false;
  const evidence = JSON.stringify({ goal: { objective, criteria: requirements } });
  return (
    estimateTokens({ role: "user", content: evidence, timestamp: 0 }) <= MAX_GOAL_EVIDENCE_TOKENS
  );
}
export function matchesGoalCreateAuthorization(authorization: unknown, input: unknown): boolean {
  if (
    !authorization ||
    typeof authorization !== "object" ||
    Array.isArray(authorization) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return false;
  const auth = authorization as GoalCreateAuthorization,
    args = input as GoalCreateAuthorization;
  const valid = (value: GoalCreateAuthorization) =>
    validGoalSpecification(value.objective, value.criteria) &&
    (value.budget === undefined || (Number.isSafeInteger(value.budget) && value.budget > 0)) &&
    (value.deadline === undefined || typeof value.deadline === "string");
  return (
    valid(auth) &&
    valid(args) &&
    auth.objective === args.objective &&
    auth.budget === args.budget &&
    auth.deadline === args.deadline &&
    JSON.stringify(auth.criteria) === JSON.stringify(args.criteria)
  );
}
export function acceptanceCriteria(objective: string, criteria?: string[]): GoalCriterion[] {
  if (!validGoalSpecification(objective, criteria))
    throw Error(
      `Goal text must contain a nonempty objective and up to ${MAX_GOAL_CRITERIA} distinct criteria, with at most ${MAX_GOAL_TEXT_FIELD_CHARS} characters per field, ${MAX_GOAL_SPEC_CHARS} characters total, and ${MAX_GOAL_EVIDENCE_TOKENS} estimated evaluator tokens`,
    );
  return (criteria ?? [objective]).map((requirement) => ({
    id: newSemanticId("task"),
    requirement,
  }));
}
export type GoalAction =
  | {
      type: "create";
      id: string;
      objective: string;
      budget?: number;
      criteria?: GoalCriterion[];
      deadlineAt?: number;
      now?: number;
    }
  | {
      type: "edit";
      objective: string;
      criteria?: GoalCriterion[];
      deadlineAt?: number | null;
      now?: number;
    }
  | { type: "pause" }
  | { type: "resume"; deadlineAt?: number | null; now?: number }
  | { type: "expire"; now: number }
  | { type: "progress"; evidence: string; requirementKey?: string; advances?: boolean }
  | { type: "audit"; requirements: GoalAudit[] }
  | { type: "evaluation"; evaluation: GoalEvaluation; cycleId: string; now?: number }
  | { type: "blocker"; key: string; blocker: string; cycleId: string }
  | { type: "turn"; cycleId: string }
  | { type: "usage"; id: string; goalId: string; usage?: unknown; incomplete?: boolean }
  | { type: "clear" };
export function initialGoal(): GoalState | undefined {
  return undefined;
}
function assertCriteria(criteria: GoalCriterion[]) {
  if (
    !Array.isArray(criteria) ||
    !criteria.length ||
    criteria.length > MAX_GOAL_CRITERIA ||
    !criteria.every(
      (criterion) =>
        !!criterion &&
        typeof criterion.id === "string" &&
        !!criterion.id.trim() &&
        typeof criterion.requirement === "string" &&
        !!criterion.requirement.trim() &&
        criterion.requirement.length <= MAX_GOAL_TEXT_FIELD_CHARS,
    ) ||
    new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length
  )
    throw Error("Fixed acceptance criteria are required");
}
const clearedBlocker = {
  blocker: undefined,
  blockerKey: undefined,
  blockerTurns: 0,
  lastCountedCycle: undefined,
  lastCountedConditionKey: undefined,
};
export function rearmGoal(
  state: GoalState,
  deadlineAt?: number | null,
  now = Date.now(),
): GoalState {
  if (state.status === "completed") throw Error("A completed goal cannot be resumed");
  const nextDeadline = deadlineAt === null ? undefined : (deadlineAt ?? state.deadlineAt);
  if (
    (state.status === "expired" || (state.deadlineAt !== undefined && state.deadlineAt <= now)) &&
    deadlineAt === undefined
  )
    throw Error("This goal has expired; resume it with a new --for duration or --no-deadline");
  if (nextDeadline !== undefined && !isFutureDeadline(nextDeadline, now))
    throw Error("A resumed goal needs a deadline in the future");
  assertCriteria(state.criteria);
  return {
    ...state,
    deadlineAt: nextDeadline,
    status: "active",
    revision: state.revision + 1,
    cycleId: undefined,
    ...clearedBlocker,
    audit: [],
  };
}
export function reduceGoal(
  state: GoalState | undefined,
  action: GoalAction,
): GoalState | undefined {
  if (action.type === "clear") return undefined;
  if (action.type === "create") {
    if (state && state.status !== "completed")
      throw Error("A goal already exists; edit it first or complete it before starting another");
    if (!action.objective.trim() || !action.id.trim())
      throw Error("Objective and goal identity are required");
    if (action.budget !== undefined && (!Number.isSafeInteger(action.budget) || action.budget <= 0))
      throw Error("Budget must be a positive integer");
    if (action.deadlineAt !== undefined) {
      if (!isFutureDeadline(action.deadlineAt, action.now ?? Date.now()))
        throw Error("Goal deadline must be a valid time in the future");
    }
    const criteria = action.criteria ?? acceptanceCriteria(action.objective);
    assertCriteria(criteria);
    if (
      !validGoalSpecification(
        action.objective,
        criteria.map((item) => item.requirement),
      )
    )
      throw Error("Goal objective and criteria exceed the bounded evaluator input limits");
    return {
      version: 3,
      id: action.id,
      revision: 0,
      objective: action.objective,
      criteria: criteria.map((item) => ({ ...item })),
      status: "active",
      turn: 0,
      blockerTurns: 0,
      audit: [],
      evidence: [],
      progressKeys: [],
      budget: action.budget,
      deadlineAt: action.deadlineAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: 0 },
      usageIds: [],
    };
  }
  if (!state) throw Error("No active goal");
  switch (action.type) {
    case "edit": {
      if (!action.objective.trim()) throw Error("Objective must not be empty");
      const deadlineAt =
        action.deadlineAt === null ? undefined : (action.deadlineAt ?? state.deadlineAt);
      const explicitDeadline = action.deadlineAt !== undefined;
      if (state.status === "expired" && !explicitDeadline)
        throw Error("This goal has expired; edit it with a new --for duration or --no-deadline");
      if (deadlineAt !== undefined && !isFutureDeadline(deadlineAt, action.now ?? Date.now()))
        throw Error(
          "Goal deadline must be a valid time in the future; use --for or --no-deadline to extend it",
        );
      const criteria = action.criteria ?? acceptanceCriteria(action.objective);
      assertCriteria(criteria);
      if (
        !validGoalSpecification(
          action.objective,
          criteria.map((item) => item.requirement),
        )
      )
        throw Error("Goal objective and criteria exceed the bounded evaluator input limits");
      return {
        ...state,
        deadlineAt,
        objective: action.objective,
        criteria,
        revision: state.revision + 1,
        status: "active",
        turn: 0,
        cycleId: undefined,
        ...clearedBlocker,
        audit: [],
        evidence: [],
        progressKeys: [],
      };
    }
    case "pause":
      if (state.status !== "active" && state.status !== "blocked")
        throw Error("Only an active or blocked goal can be paused");
      return { ...state, status: "paused" };
    case "resume": {
      if (state.status !== "paused" && state.status !== "blocked" && state.status !== "expired")
        throw Error("Only a paused, blocked or expired goal can be resumed");
      return rearmGoal(state, action.deadlineAt, action.now);
    }
    case "expire":
      if (
        state.status === "completed" ||
        state.status === "expired" ||
        state.deadlineAt === undefined ||
        state.deadlineAt > action.now
      )
        return state;
      return { ...state, status: "expired" };
    case "progress": {
      if (state.status !== "active") throw Error("A non-active goal cannot be updated");
      const evidence = action.evidence.trim();
      if (!evidence || action.advances !== true || !action.requirementKey?.trim()) return state;
      if (!state.criteria.some((criterion) => criterion.id === action.requirementKey))
        throw Error("Progress must name an authorized criterion ID");
      const key = `${action.requirementKey}\u0000${evidence}`;
      if (state.progressKeys.includes(key)) return state;
      return {
        ...state,
        evidence: [...state.evidence, evidence],
        progressKeys: [...state.progressKeys, key],
        ...clearedBlocker,
      };
    }
    case "audit": {
      if (state.status !== "active") throw Error("A non-active goal cannot be audited");
      if (
        !Array.isArray(action.requirements) ||
        !action.requirements.length ||
        !action.requirements.every(
          (item) =>
            !!item &&
            typeof item.evidence === "string" &&
            !!item.evidence.trim() &&
            ["met", "unmet", "uncertain"].includes(item.verdict) &&
            state.criteria.some((criterion) => criterion.id === item.criterionId),
        ) ||
        new Set(action.requirements.map((item) => item.criterionId)).size !==
          action.requirements.length
      )
        throw Error(
          "Every assessment needs an authorized criterion ID, evidence and a valid verdict",
        );
      // Each audit is a fresh assessment; stale met verdicts never fill omitted criteria.
      const complete =
        action.requirements.length === state.criteria.length &&
        action.requirements.every((item) => item.verdict === "met");
      return {
        ...state,
        audit: action.requirements.map((item) => ({ ...item })),
        status: complete ? "completed" : "active",
      };
    }
    case "evaluation": {
      if (state.status !== "active") throw Error("Only an active goal can be evaluated");
      if (state.deadlineAt !== undefined && state.deadlineAt <= (action.now ?? Date.now()))
        return { ...state, status: "expired" };
      const assessment = validateEvaluation(action.evaluation, state);
      if (state.lastCountedCycle === action.cycleId) return state;
      const audited = {
        ...state,
        audit: assessment.requirements.map((item) => ({ ...item })),
      };
      if (assessment.verdict === "finished")
        return { ...audited, ...clearedBlocker, status: "completed" };
      if (assessment.verdict === "incomplete")
        return { ...audited, ...clearedBlocker, lastCountedCycle: action.cycleId };
      return reduceGoal(audited, {
        type: "blocker",
        key: assessment.blockerKey!,
        blocker: assessment.reason,
        cycleId: action.cycleId,
      });
    }
    case "blocker": {
      if (
        state.status !== "active" ||
        !action.blocker.trim() ||
        !action.key.trim() ||
        !action.cycleId.trim()
      )
        throw Error(
          "A blocker needs a fresh assessment cycle, condition key and wording for an active goal",
        );
      // A cycle has at most one counted assessment, regardless of changed wording or condition.
      if (state.lastCountedCycle === action.cycleId) return state;
      const count = state.lastCountedConditionKey === action.key ? state.blockerTurns + 1 : 1;
      return {
        ...state,
        blocker: action.blocker,
        blockerKey: action.key,
        blockerTurns: count,
        lastCountedCycle: action.cycleId,
        lastCountedConditionKey: action.key,
        status: count >= 3 ? "blocked" : "active",
      };
    }
    case "turn":
      if (state.status !== "active" || !action.cycleId.trim() || action.cycleId === state.cycleId)
        return state;
      return { ...state, turn: state.turn + 1, cycleId: action.cycleId };
    case "usage": {
      if (action.goalId !== state.id || !action.id || state.usageIds.includes(action.id))
        return state;
      const usageIds = [...state.usageIds, action.id],
        usage = readTokenUsage(action.usage);
      const sum = usage && addTokenUsage(state.usage, usage);
      if (!sum || !Number.isSafeInteger(totalTokens(sum)))
        return { ...state, usageIds, usage: { ...state.usage, missing: state.usage.missing + 1 } };
      // A receipt belongs to dispatch authority, so pause/completion after dispatch does not erase it.
      return {
        ...state,
        usageIds,
        usage: { ...sum, missing: state.usage.missing + (action.incomplete ? 1 : 0) },
      };
    }
  }
}
export function applyGoalBatch(
  state: GoalState | undefined,
  expected: { id: string; revision: number },
  actions: GoalAction[],
): GoalState | undefined {
  if (!state || state.id !== expected.id || state.revision !== expected.revision)
    throw Error("Goal scope changed; refresh get_goal before updating");
  if (actions.some((action) => !["progress", "audit", "blocker"].includes(action.type)))
    throw Error("This update contains an unsupported action");
  let next = state;
  for (const action of actions) {
    const updated = reduceGoal(next, action);
    if (!updated) throw Error("Invalid goal update batch");
    next = updated;
  }
  return next;
}
export function withinBudget(state: GoalState): boolean {
  return (
    state.budget === undefined ||
    (state.usage.missing === 0 && totalTokens(state.usage) < state.budget)
  );
}
