const MAX_DEADLINE_DAYS = 3_650;
const MAX_DEADLINE_MS = MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1_000;

/** Resolve a duration once, or parse an RFC 3339 timestamp with millisecond precision. */
export function resolveGoalDeadline(value: string, now = Date.now()): number {
  const spec = value.trim();
  const duration = /^(\d+)(s|m|h|d)$/i.exec(spec);
  let deadlineAt: number;

  if (duration) {
    const count = Number(duration[1]);
    const unit = duration[2]!.toLowerCase();
    const multiplier =
      unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    const delay = count * multiplier;
    if (!Number.isSafeInteger(delay) || delay <= 0 || delay > MAX_DEADLINE_MS)
      throw new Error(`Goal duration must be between 1 second and ${MAX_DEADLINE_DAYS} days`);
    deadlineAt = now + delay;
  } else {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(spec);
    if (!match)
      throw new Error("Use a duration such as 30m or an RFC 3339 timestamp with timezone");
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "0", zone] =
      match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const wallTime = new Date(0);
    wallTime.setUTCFullYear(year, month - 1, day);
    wallTime.setUTCHours(hour, minute, second, 0);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      wallTime.getUTCFullYear() !== year ||
      wallTime.getUTCMonth() !== month - 1 ||
      wallTime.getUTCDate() !== day
    )
      throw new Error("Goal deadline is not a valid calendar time");
    if (zone !== "Z") {
      const offset = /([+-])(\d{2}):(\d{2})/.exec(zone!)!;
      const offsetHours = Number(offset[2]);
      const offsetMinutes = Number(offset[3]);
      if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0))
        throw new Error("Goal deadline timezone offset is invalid");
    }
    const millisecond = Number((fraction ?? "").slice(0, 3).padEnd(3, "0"));
    const normalized = `${spec.slice(0, spec.indexOf("T") + 9)}.${String(millisecond).padStart(3, "0")}${zone}`;
    deadlineAt = Date.parse(normalized);
    if (!Number.isFinite(deadlineAt)) throw new Error("Goal deadline is not a valid timestamp");
  }

  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now)
    throw new Error("Goal deadline must be in the future");
  if (deadlineAt - now > MAX_DEADLINE_MS)
    throw new Error(`Goal deadline cannot be more than ${MAX_DEADLINE_DAYS} days away`);
  return deadlineAt;
}

export function deadlineRemaining(deadlineAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  if (seconds === 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3_600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

export function deadlineSummary(deadlineAt: number, now = Date.now()): string {
  const local = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(deadlineAt);
  const remaining = deadlineRemaining(deadlineAt, now);
  return `Deadline: ${local} (${new Date(deadlineAt).toISOString()}); Remaining: ${remaining}.`;
}
