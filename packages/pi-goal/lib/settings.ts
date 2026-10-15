/** Native Pi settings select the evaluator; explicit command-line flags override them. */
export function evaluatorOptions(
  value: unknown,
  flags: { model?: unknown; timeoutSec?: unknown } = {},
) {
  const settings = value as { goal?: { evaluator?: { model?: unknown; timeoutSec?: unknown } } };
  return {
    model: flags.model ?? settings.goal?.evaluator?.model,
    timeoutSec: Number(flags.timeoutSec ?? settings.goal?.evaluator?.timeoutSec ?? 30),
  };
}
