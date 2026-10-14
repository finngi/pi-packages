import { createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVALUATION_TOOL, type GoalEvaluation } from "./evaluator.ts";

/** Scripted evaluator for stock SDK integration: runtime/auth/transport are real, model output is deterministic. */
export function withFixtureEvaluator(
  factory: (pi: ExtensionAPI) => void,
  verdict: GoalEvaluation["verdict"] = "finished",
) {
  return (pi: ExtensionAPI) => {
    const model: Model<Api> = {
      id: "evaluator",
      provider: "goal-evaluator-fixture",
      api: "goal-evaluator-fixture",
      name: "Goal evaluator fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 2048,
    };
    const getFlag = pi.getFlag.bind(pi);
    pi.getFlag = (name) =>
      name === "goal-evaluator-model" ? `${model.provider}/${model.id}` : getFlag(name);
    pi.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture-only",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple(requested, context) {
        const initial = context.messages.find((message) => message.role === "user");
        const state = JSON.parse(String(initial?.content)).goal;
        const stream = createAssistantMessageEventStream();
        const message: any = {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "evaluation-call",
              name: EVALUATION_TOOL,
              arguments: {
                verdict,
                reason:
                  verdict === "finished"
                    ? "All fixture requirements inspected"
                    : "Verify remaining requirements",
                blockerKey: verdict === "blocked" ? "fixture-dependency" : null,
                requirements: state.criteria.map((criterion: any) => ({
                  criterionId: criterion.id,
                  evidence: "Inspected scripted worker evidence",
                  verdict: verdict === "finished" ? "met" : "unmet",
                })),
              },
            },
          ],
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        return stream;
      },
    });
    factory(pi);
  };
}
