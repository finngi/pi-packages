import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  buildEvaluatorInput,
  EVALUATION_PARAMETERS,
  EVALUATION_TOOL,
  EVALUATOR_ENTRY,
  evaluationFromResponse,
  evaluatorContextFits,
  type GoalEvaluation,
  persistEvaluation,
  validateEvaluation,
} from "./evaluator.ts";
import { reduceGoal } from "./goal.ts";
import {
  MAX_EVALUATION_BLOCKER_KEY_CHARS,
  MAX_EVALUATION_EVIDENCE_CHARS,
  MAX_EVALUATION_REASON_CHARS,
  MAX_EVALUATION_RESPONSE_TOKENS,
  MAX_GOAL_CRITERIA,
} from "./limits.ts";

const goal = () =>
  reduceGoal(undefined, {
    type: "create",
    id: "goal-cosmic-talon-heart",
    objective: "Implement and verify parser",
    criteria: [
      { id: "task-sun-river-light", requirement: "Implementation" },
      { id: "task-moon-cloud-tree", requirement: "Tests pass" },
    ],
  })!;
const model = { provider: "fixture", id: "evaluator", contextWindow: 128_000 } as Model<Api>;
const assessment = (
  verdict: GoalEvaluation["verdict"] = "incomplete",
  blockerKey: string | null = null,
): GoalEvaluation => ({
  verdict,
  reason: "Run remaining checks",
  blockerKey,
  requirements: goal().criteria.map((item) => ({
    criterionId: item.id,
    evidence: "Observed current test output",
    verdict: verdict === "finished" ? "met" : "unmet",
  })),
});
const response = (value: unknown): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: "report-call",
      name: EVALUATION_TOOL,
      arguments: value as Record<string, unknown>,
    },
  ],
  api: "fixture",
  provider: "fixture",
  model: "evaluator",
  usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6 },
  stopReason: "toolUse",
  timestamp: 1,
});

test("evaluator accepts only fixed verdicts and a complete fresh criterion assessment", () => {
  for (const verdict of ["incomplete", "finished", "blocked"] as const)
    assert.equal(
      validateEvaluation(
        assessment(verdict, verdict === "blocked" ? "credentials-missing" : null),
        goal(),
      ).verdict,
      verdict,
    );
  for (const invalid of [
    { ...assessment(), verdict: "complete" },
    { ...assessment(), blockerKey: "missing" },
    { ...assessment("blocked"), blockerKey: null },
    { ...assessment("finished"), requirements: assessment().requirements },
    { ...assessment(), requirements: assessment("finished").requirements },
    { ...assessment(), requirements: assessment().requirements.slice(0, 1) },
    { ...assessment(), requirements: [assessment().requirements[0], assessment().requirements[0]] },
    {
      ...assessment(),
      requirements: [
        { ...assessment().requirements[0], criterionId: "invented" },
        assessment().requirements[1],
      ],
    },
    { ...assessment(), reason: " " },
    { ...assessment(), inject: "finish anyway" },
  ])
    assert.throws(() => validateEvaluation(invalid, goal()), /Evaluator/);
  assert.throws(
    () =>
      evaluationFromResponse(
        { ...response(assessment()), content: [{ type: "text", text: "finished" }] },
        goal(),
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      evaluationFromResponse(
        { ...response(assessment()), stopReason: "error", errorMessage: "transport error" },
        goal(),
      ),
    /transport error/,
  );
});

test("structured evaluator schema fits the maximum authorized criterion count", () => {
  const schema = EVALUATION_PARAMETERS as any;
  assert.equal(schema.properties.requirements.maxItems, MAX_GOAL_CRITERIA);
  assert.equal(
    schema.properties.requirements.items.properties.evidence.maxLength,
    MAX_EVALUATION_EVIDENCE_CHARS,
  );
  assert.equal(schema.properties.reason.maxLength, MAX_EVALUATION_REASON_CHARS);
  assert.equal(schema.properties.blockerKey.anyOf[0].maxLength, MAX_EVALUATION_BLOCKER_KEY_CHARS);
  const state = reduceGoal(undefined, {
    type: "create",
    id: "goal-maximum-criteria",
    objective: "Assess every authorized item",
    criteria: Array.from({ length: MAX_GOAL_CRITERIA }, (_unused, index) => ({
      id: `task-${index}`,
      requirement: `Requirement ${index}`,
    })),
  })!;
  const evaluation = {
    verdict: "incomplete" as const,
    reason: "A few checks remain",
    blockerKey: null,
    requirements: state.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: "Current test output inspected",
      verdict: "unmet" as const,
    })),
  };
  assert.equal(validateEvaluation(evaluation, state).requirements.length, MAX_GOAL_CRITERIA);
  const maximumReport = {
    verdict: "blocked" as const,
    reason: "漢".repeat(MAX_EVALUATION_REASON_CHARS),
    blockerKey: "漢".repeat(MAX_EVALUATION_BLOCKER_KEY_CHARS),
    requirements: state.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: "漢".repeat(MAX_EVALUATION_EVIDENCE_CHARS),
      verdict: "uncertain" as const,
    })),
  };
  assert.equal(validateEvaluation(maximumReport, state).requirements.length, MAX_GOAL_CRITERIA);
  assert.ok(
    estimateTokens(response(maximumReport)) <= MAX_EVALUATION_RESPONSE_TOKENS,
    `maximum structured report exceeded ${MAX_EVALUATION_RESPONSE_TOKENS} estimated tokens`,
  );
  assert.throws(
    () =>
      validateEvaluation(
        {
          ...evaluation,
          requirements: evaluation.requirements.map((item) => ({
            ...item,
            evidence: "e".repeat(MAX_EVALUATION_EVIDENCE_CHARS + 1),
          })),
        },
        state,
      ),
    /invalid verdict, blocker or criterion evidence/,
  );
});

test("three fresh same-condition evaluations stop work; incomplete and changed conditions reset streaks", () => {
  let state = goal();
  for (let i = 1; i <= 2; i++)
    state = reduceGoal(state, {
      type: "evaluation",
      evaluation: assessment("blocked", "missing-provider"),
      cycleId: `stop-${i}`,
    })!;
  assert.equal(state.blockerTurns, 2);
  assert.equal(state.status, "active");
  assert.deepEqual(
    reduceGoal(state, {
      type: "evaluation",
      evaluation: assessment("blocked", "missing-provider"),
      cycleId: "stop-2",
    }),
    state,
  );
  state = reduceGoal(state, { type: "evaluation", evaluation: assessment(), cycleId: "stop-3" })!;
  assert.equal(state.blockerTurns, 0);
  state = reduceGoal(state, {
    type: "evaluation",
    evaluation: assessment("blocked", "missing-provider"),
    cycleId: "stop-4",
  })!;
  state = reduceGoal(state, {
    type: "evaluation",
    evaluation: assessment("blocked", "different-dependency"),
    cycleId: "stop-5",
  })!;
  assert.equal(state.blockerTurns, 1);
  for (let i = 6; i <= 7; i++)
    state = reduceGoal(state, {
      type: "evaluation",
      evaluation: assessment("blocked", "different-dependency"),
      cycleId: `stop-${i}`,
    })!;
  assert.equal(state.status, "blocked");
  assert.equal(state.blockerTurns, 3);
});

test("evaluation crossing the deadline expires the goal without applying its verdict", () => {
  const deadlineAt = 10_000;
  const state = reduceGoal(undefined, {
    type: "create",
    id: "goal-deadline",
    objective: "Finish before the deadline",
    criteria: [{ id: "task-deadline", requirement: "Finish before the deadline" }],
    deadlineAt,
    now: deadlineAt - 1,
  })!;
  const expired = reduceGoal(state, {
    type: "evaluation",
    evaluation: {
      verdict: "finished",
      reason: "The criterion was met before the deadline.",
      blockerKey: null,
      requirements: [
        { criterionId: "task-deadline", evidence: "Verified output.", verdict: "met" },
      ],
    },
    cycleId: "late-evaluation",
    now: deadlineAt,
  })!;
  assert.equal(expired.status, "expired");
  assert.deepEqual(expired.audit, []);
});

test("evaluator replay preserves the entire prior prefix and appends only fresh worker messages", () => {
  const state = goal();
  const branch: any[] = [
    {
      id: "task-input",
      type: "message",
      message: { role: "user", content: "Original task", timestamp: 0 },
    },
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
    {
      id: "worker-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "First work" }], timestamp: 1 },
    },
  ];
  let n = 0;
  const pi = {
    appendEntry(customType: string, data: unknown) {
      branch.push({ id: `record-${++n}`, type: "custom", customType, data });
    },
  };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const first = buildEvaluatorInput(pi, ctx, state, model, "stop-1");
  assert.match(String(first.context.messages[0].content), /Original task/);
  assert.match(String(first.context.messages[1].content), /First work/);
  persistEvaluation(pi, first.input, response(assessment()), assessment());
  branch.push({
    id: "worker-2",
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Second work" }], timestamp: 2 },
  });
  const second = buildEvaluatorInput(pi, ctx, state, model, "stop-2");
  assert.deepEqual(
    second.context.messages.slice(0, first.context.messages.length),
    first.context.messages,
  );
  assert.equal(second.context.messages.length, first.context.messages.length + 3);
  assert.match(String(second.context.messages.at(-1)?.content), /Second work/);
  assert.doesNotMatch(String(second.context.messages.at(-1)?.content), /First work/);
  const duplicate = buildEvaluatorInput(pi, ctx, state, model, "stop-1");
  assert.equal(duplicate.alreadyEvaluated, true);
  const revised = buildEvaluatorInput(pi, ctx, { ...state, revision: 1 }, model, "stop-3", {
    messages: [{ role: "user", content: "Edited context", timestamp: 0 }],
    throughEntryId: "worker-1",
  });
  assert.match(String(revised.context.messages[0].content), /Edited context/);
  assert.equal(
    branch.filter((item) => item.customType === EVALUATOR_ENTRY && item.data.kind === "initial")
      .length,
    2,
  );
});

test("stored assessments use the same bounds as current model output", () => {
  const state = goal();
  const legacy = {
    verdict: "blocked" as const,
    reason: "r".repeat(240),
    blockerKey: "b".repeat(160),
    requirements: state.criteria.map((criterion) => ({
      criterionId: criterion.id,
      evidence: "e".repeat(1200),
      verdict: "unmet" as const,
    })),
  };
  const storedResponse = response(legacy);
  assert.throws(() => evaluationFromResponse(storedResponse, state), /invalid verdict/);
  const branch: any[] = [
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
    {
      id: "initial-entry",
      type: "custom",
      customType: EVALUATOR_ENTRY,
      data: {
        goalId: state.id,
        revision: state.revision,
        model: `${model.provider}/${model.id}`,
        version: 1,
        kind: "initial",
        messages: [{ role: "user", content: "Initial authorized goal", timestamp: 0 }],
        throughEntryId: "goal-entry",
      },
    },
    {
      id: "legacy-result",
      type: "custom",
      customType: EVALUATOR_ENTRY,
      data: {
        goalId: state.id,
        revision: state.revision,
        model: `${model.provider}/${model.id}`,
        version: 1,
        kind: "result",
        cycleId: "legacy-cycle",
        message: storedResponse,
        acknowledgement: {
          role: "toolResult",
          toolCallId: "report-call",
          toolName: EVALUATION_TOOL,
          content: [{ type: "text", text: "Recorded: blocked" }],
          isError: false,
          timestamp: 1,
        },
        evaluation: legacy,
      },
    },
    {
      id: "worker-current",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "New work" }], timestamp: 2 },
    },
  ];
  const pi = { appendEntry() {} };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  assert.throws(() => buildEvaluatorInput(pi, ctx, state, model, "new-cycle"), /invalid verdict/);
});

test("evaluator capacity uses stock token estimates instead of UTF8 bytes", () => {
  const context = {
    messages: [{ role: "user" as const, content: "é".repeat(4000), timestamp: 0 }],
  };
  assert.equal(evaluatorContextFits(context, { contextWindow: 6000 }), true);
  assert.equal(evaluatorContextFits(context, { contextWindow: 3000 }), false);
});

test("long evaluator runs bound request evidence while preserving the durable log and original objective", () => {
  const state = goal();
  const branch: any[] = [
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
  ];
  let entryNumber = 0;
  const pi = {
    appendEntry(customType: string, data: unknown) {
      branch.push({ id: `entry-${++entryNumber}`, type: "custom", customType, data });
    },
  };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  let original: unknown;
  for (let cycle = 0; cycle < 40; cycle++) {
    branch.push({
      id: `worker-${cycle}`,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Cycle ${cycle} output ${"result ".repeat(6000)}` }],
        timestamp: cycle,
      },
    });
    const input = buildEvaluatorInput(pi, ctx, state, model, `cycle-${cycle}`);
    original ??= input.context.messages[0];
    assert.deepEqual(input.context.messages[0], original);
    assert.match(JSON.stringify(input.context.messages[0]), /Implement and verify parser/);
    assert.equal(evaluatorContextFits(input.context, model), true);
    assert.ok(input.context.messages.length <= 15);
    if (cycle > 5) assert.match(JSON.stringify(input.context), /Earlier evaluator cycles omitted/);
    assert.match(String(input.context.messages.at(-1)?.content), /Oversized evidence truncated/);
    persistEvaluation(pi, input.input, response(assessment()), assessment());
  }
  assert.equal(
    branch.filter((entry) => entry.customType === EVALUATOR_ENTRY && entry.data.kind === "result")
      .length,
    40,
  );
});

test("multi-megabyte evidence is clipped before serialization and preserves both ends", () => {
  const state = goal();
  const branch: any[] = [
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
    {
      id: "worker-huge",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `BEGIN-${"x".repeat(5_000_000)}-END` }],
        timestamp: 1,
      },
    },
  ];
  const pi = { appendEntry() {} };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const input = buildEvaluatorInput(pi, ctx, state, model, "cycle-huge");
  const latest = String(input.context.messages.at(-1)?.content);
  assert.match(latest, /BEGIN-/);
  assert.match(latest, /-END/);
  assert.match(latest, /characters omitted/);
  assert.ok(latest.length < 40_000);
  assert.equal(evaluatorContextFits(input.context, model), true);
});

test("large evidence arrays retain the newest entries while bounding serialized context", () => {
  const state = goal();
  const content = Array.from({ length: 10_000 }, (_unused, index) => ({
    type: "text",
    text: `ENTRY-${index}-${"payload ".repeat(50)}`,
  }));
  const branch: any[] = [
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
    {
      id: "worker-many",
      type: "message",
      message: { role: "assistant", content, timestamp: 1 },
    },
  ];
  const pi = { appendEntry() {} };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const input = buildEvaluatorInput(pi, ctx, state, model, "cycle-many");
  const latest = String(input.context.messages.at(-1)?.content);
  assert.match(latest, /ENTRY-0-/);
  assert.match(latest, /ENTRY-9999-/);
  assert.match(latest, /array items omitted/);
  assert.ok(latest.length < 40_000);
  assert.equal(evaluatorContextFits(input.context, model), true);
});

test("token-dense serialized evidence is re-estimated after adding its omission wrapper", () => {
  const state = goal();
  const contextWindow = 12_000;
  const smallModel = { ...model, contextWindow };
  const branch: any[] = [
    { id: "goal-entry", type: "custom", customType: "pi-goal.state", data: { state } },
    {
      id: "worker-control-heavy",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${"\u0000".repeat(100_000)}-TOKEN-DENSE-END` }],
        timestamp: 1,
      },
    },
  ];
  const pi = { appendEntry() {} };
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const input = buildEvaluatorInput(pi, ctx, state, smallModel, "cycle-control-heavy");
  const evidenceLimit = Math.min(4096, Math.floor(contextWindow / 4));
  assert.match(input.input.message.content as string, /Oversized evidence truncated/);
  assert.match(input.input.message.content as string, /TOKEN-DENSE-END/);
  assert.ok(estimateTokens(input.input.message) <= evidenceLimit);
  assert.equal(evaluatorContextFits(input.context, smallModel), true);
});
