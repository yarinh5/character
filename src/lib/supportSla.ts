export type SupportFirstResponseState =
  "not_set" | "pending" | "overdue" | "answered_on_time" | "answered_late";

export type SupportFirstResponseSnapshot = {
  firstResponseTargetAt: string | null;
  firstHumanResponseAt: string | null;
  firstResponseWithinTarget: boolean | null;
};

export type SupportScheduleWindow = {
  weekday: number;
  start: string;
  end: string;
};

const supportWindowPattern = /^([0-6])\s+([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const closureDatePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

export function getSupportFirstResponseState(
  snapshot: SupportFirstResponseSnapshot,
  now = new Date(),
): SupportFirstResponseState {
  if (snapshot.firstHumanResponseAt) {
    if (snapshot.firstResponseWithinTarget === null) return "not_set";
    return snapshot.firstResponseWithinTarget === true ? "answered_on_time" : "answered_late";
  }
  if (!snapshot.firstResponseTargetAt) return "not_set";
  return now.getTime() <= new Date(snapshot.firstResponseTargetAt).getTime()
    ? "pending"
    : "overdue";
}

export function formatSupportTarget(
  targetAt: string | null,
  timeZone: string | null,
  locale = "he-IL",
): string | null {
  if (!targetAt || !timeZone) return null;
  const instant = new Date(targetAt);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    }).format(instant);
  } catch {
    return null;
  }
}

export function parseSupportScheduleWindows(value: string): SupportScheduleWindow[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const match = supportWindowPattern.exec(line);
    if (!match) throw new Error("support_window_invalid");
    const start = `${match[2]}:${match[3]}`;
    const end = `${match[4]}:${match[5]}`;
    if (start === end) throw new Error("support_window_zero_length");
    return { weekday: Number(match[1]), start, end };
  });
}

export function parseSupportClosureDates(value: string): string[] {
  const dates = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const date of dates) {
    const match = closureDatePattern.exec(date);
    const parsed = match ? new Date(`${date}T00:00:00Z`) : null;
    if (
      !match ||
      !parsed ||
      parsed.getUTCFullYear() !== Number(date.slice(0, 4)) ||
      parsed.getUTCMonth() + 1 !== Number(match[1]) ||
      parsed.getUTCDate() !== Number(match[2])
    ) {
      throw new Error("support_closure_date_invalid");
    }
  }
  return [...new Set(dates)].sort();
}
