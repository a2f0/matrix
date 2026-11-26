import { addDays, datesBetween, localDate } from "../../../skills/merged-commits/scripts/day";
import type { DayCount } from "../../../skills/merged-commits/scripts/github";

/**
 * The profile repository's record of daily counts, which its README's
 * contributions grid renders. The profile repository validates the same shape.
 */
export const HISTORY_FILE = "contributions/commits.json";

/** The first run counts 53 weeks, enough for any one-year grid that ends today. */
const BACKFILL_DAYS = 53 * 7 - 1;

export interface History {
  schemaVersion: 1;
  timeZone: string;
  /** When the latest count began; every stored day before its local date is final. */
  asOf: string;
  days: Record<string, DayCount>;
}

function isCount(value: unknown): value is DayCount {
  if (typeof value !== "object" || value === null) return false;
  const { commits, pullRequests } = value as Record<string, unknown>;
  return [commits, pullRequests].every(field => Number.isSafeInteger(field) && (field as number) >= 0);
}

function isDate(date: string): boolean {
  try {
    return addDays(date, 0) === date;
  } catch {
    return false;
  }
}

function invalidDay(days: object): string | undefined {
  for (const [date, count] of Object.entries(days)) {
    if (!isDate(date)) return `days has an invalid date '${date}'`;
    if (!isCount(count)) return `days.${date} needs non-negative integer commits and pullRequests`;
  }
  return undefined;
}

function invalidHistory(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it must be a JSON object";
  const { schemaVersion, timeZone, asOf, days } = value as Record<string, unknown>;
  if (schemaVersion !== 1) return "schemaVersion must be 1";
  if (typeof timeZone !== "string" || timeZone === "") return "timeZone must be an IANA time zone";
  if (typeof asOf !== "string" || Number.isNaN(Date.parse(asOf))) return "asOf must be an ISO 8601 instant";
  if (typeof days !== "object" || days === null || Array.isArray(days)) return "days must be an object";
  return invalidDay(days);
}

export function parseHistory(text: string, file: string): History {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problem = invalidHistory(value);
  if (problem) throw new Error(`${file}: ${problem}.`);
  return value as History;
}

/**
 * Every date to count now: each day from the start through today that is
 * missing or was last counted before it ended. The start is the earliest of
 * `since`, 53 weeks ago, and the oldest stored day, so a run after a gap
 * backfills every day it missed.
 */
export function datesToCount(history: History | null, today: string, since?: string): string[] {
  const oldest = history ? Object.keys(history.days).sort()[0] : undefined;
  const start = [since, addDays(today, -BACKFILL_DAYS), oldest].filter(date => date !== undefined).sort()[0]!;
  const finalBefore = history ? localDate(new Date(history.asOf), history.timeZone) : "";
  return datesBetween(start, today).filter(date => !(history?.days[date] && date < finalBefore));
}

/** The history with `dates` replaced by `counts`, zero for days with no merges. */
export function recordCounts(history: History | null, timeZone: string, asOf: string, dates: string[], counts: Map<string, DayCount>): History {
  const days: Record<string, DayCount> = { ...history?.days };
  for (const date of dates) days[date] = counts.get(date) ?? { commits: 0, pullRequests: 0 };
  const sorted = Object.keys(days).sort();
  return { schemaVersion: 1, timeZone, asOf, days: Object.fromEntries(sorted.map(date => [date, days[date]!])) };
}

/** Two-space JSON with one line per day, so a run's diff shows only the days it counted. */
export function serializeHistory(history: History): string {
  const days = Object.entries(history.days).map(
    ([date, count]) => `    ${JSON.stringify(date)}: { "commits": ${count.commits}, "pullRequests": ${count.pullRequests} }`,
  );
  const body = days.length === 0 ? "{}" : `{\n${days.join(",\n")}\n  }`;
  return `{\n  "schemaVersion": 1,\n  "timeZone": ${JSON.stringify(history.timeZone)},\n  "asOf": ${JSON.stringify(history.asOf)},\n  "days": ${body}\n}\n`;
}
