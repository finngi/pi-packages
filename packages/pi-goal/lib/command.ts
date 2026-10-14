import type { GoalState } from "./goal.ts";

export type GoalCommand =
  | { kind: "start" | "edit"; objective: string; deadline?: string; clearDeadline?: boolean }
  | { kind: "resume"; deadline?: string; clearDeadline?: boolean }
  | { kind: "status" | "pause" | "clear" };

function deadlineOption(args: string): {
  remainder: string;
  deadline?: string;
  clearDeadline?: boolean;
} {
  const trimmed = args.trimStart();
  const none = /^--no-deadline(?:\s+|$)/.exec(trimmed);
  if (none) return { remainder: trimmed.slice(none[0].length).trimStart(), clearDeadline: true };
  const duration = /^--for\s+(\S+)(?:\s+|$)/.exec(trimmed);
  if (duration)
    return {
      remainder: trimmed.slice(duration[0].length).trimStart(),
      deadline: duration[1],
    };
  if (trimmed.startsWith("--for") || trimmed.startsWith("--no-deadline"))
    throw Error("Use --for <duration-or-timestamp> or --no-deadline");
  return { remainder: args };
}

/** Reserved verbs route controls; every other input is the human's exact objective. */
export function parseGoalCommand(args: string, goal?: GoalState): GoalCommand {
  if (!args.trim()) return { kind: "status" };
  const match = /^\s*(\S+)(?:\s)?/.exec(args)!;
  const verb = match[1];
  const reserved = ["start", "edit", "status", "pause", "resume", "clear"].includes(verb);
  const remainder = reserved ? args.slice(match[0].length) : args;
  if (reserved && verb === "resume") {
    const option = deadlineOption(remainder);
    if (option.remainder.trim())
      throw Error("/goal resume takes no arguments except --for or --no-deadline");
    const result: Extract<GoalCommand, { kind: "resume" }> = { kind: "resume" };
    if (option.deadline !== undefined) result.deadline = option.deadline;
    if (option.clearDeadline) result.clearDeadline = true;
    return result;
  }
  if (reserved && verb !== "start" && verb !== "edit") {
    if (remainder.trim())
      throw Error(
        `/goal ${verb} takes no arguments; use /goal start ${args.trimStart()} to use those words as an objective`,
      );
    return { kind: verb as "status" | "pause" | "clear" };
  }
  const option = reserved ? deadlineOption(remainder) : { remainder };
  const objective = option.remainder;
  if (reserved && /^(?:--for|--no-deadline)(?:\s|$)/.test(objective))
    throw Error("Specify only one deadline option before the objective");
  if (!objective.trim()) throw Error("Objective must not be empty");
  const result: Extract<GoalCommand, { kind: "start" | "edit" }> = {
    kind: reserved
      ? (verb as "start" | "edit")
      : !goal || goal.status === "completed"
        ? "start"
        : "edit",
    objective,
  };
  if (option.deadline !== undefined) result.deadline = option.deadline;
  if (option.clearDeadline) result.clearDeadline = true;
  return result;
}
