import { addDays, datesBetween, localDate } from "../../../skills/merged-commits/scripts/day";
import type { DayCount } from "../../../skills/merged-commits/scripts/github";

/**
 * The profile repository's record of daily counts by repository, which its
 * web page's contributions grid renders and lets readers toggle. The profile
 * repository's `src/history.ts` validates the same shape, and its tests and
 * site build fail on a file it cannot read, so a change here ships there too.
 */
export const HISTORY_FILE = "contributions/commits.json";

/** The first run counts 53 weeks, enough for any one-year grid that ends today. */
const BACKFILL_DAYS = 53 * 7 - 1;

/** One day's merges by repository, `owner/name`, listing only the repositories with any. */
export type RepositoryCounts = Record<string, DayCount>;

export interface History {
  schemaVersion: 2;
  timeZone: string;
  /** When the latest count began; every stored day before its local date is final. */
  asOf: string;
  days: Record<string, RepositoryCounts>;
}

/** A GitHub repository's `owner/name`. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A UTC instant as `Date.toISOString` writes it, with optional fractional seconds. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isCount(value: unknown): value is DayCount {
  if (typeof value !== "object" || value === null) return false;
  const { commits, pullRequests } = value as Record<string, unknown>;
  return [commits, pullRequests].every(field => Number.isSafeInteger(field) && (field as number) >= 0);
}

export function isDate(date: string): boolean {
  try {
    return addDays(date, 0) === date;
  } catch {
    return false;
  }
}

function invalidRepositories(date: string, repositories: unknown): string | undefined {
  if (typeof repositories !== "object" || repositories === null || Array.isArray(repositories)) return `days.${date} must be an object of repositories`;
  for (const [repo, count] of Object.entries(repositories)) {
    if (!REPOSITORY.test(repo)) return `days.${date} has an invalid repository '${repo}'; use owner/name`;
    if (!isCount(count)) return `days.${date}["${repo}"] needs non-negative integer commits and pullRequests`;
  }
  return undefined;
}

function invalidDay(days: object): string | undefined {
  for (const [date, repositories] of Object.entries(days)) {
    if (!isDate(date)) return `days has an invalid date '${date}'`;
    const problem = invalidRepositories(date, repositories);
    if (problem) return problem;
  }
  return undefined;
}

/** A day after the local date of asOf, which no count could have reached. */
function lateDay(days: object, asOf: string, timeZone: string): string | undefined {
  const last = localDate(new Date(asOf), timeZone);
  const late = Object.keys(days).find(date => date > last);
  return late && `days.${late} is after the local date of asOf (${last})`;
}

function isTimeZone(timeZone: unknown): boolean {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function invalidHistory(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it must be a JSON object";
  const { schemaVersion, timeZone, asOf, days } = value as Record<string, unknown>;
  if (schemaVersion !== 2) return "schemaVersion must be 2";
  if (!isTimeZone(timeZone)) return "timeZone must be an IANA time zone";
  if (typeof asOf !== "string" || !ISO_INSTANT.test(asOf) || !isDate(asOf.slice(0, 10)) || Number.isNaN(Date.parse(asOf)))
    return "asOf must be an ISO 8601 instant";
  if (typeof days !== "object" || days === null || Array.isArray(days)) return "days must be an object";
  return invalidDay(days) ?? lateDay(days, asOf, timeZone as string);
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

function sortedKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, record[key]!]),
  );
}

/** The history with `dates` replaced by `counts`, empty for days with no merges, sorted by date and repository. */
export function recordCounts(history: History | null, timeZone: string, asOf: string, dates: string[], counts: Map<string, RepositoryCounts>): History {
  const days: Record<string, RepositoryCounts> = { ...history?.days };
  for (const date of dates) days[date] = sortedKeys(counts.get(date) ?? {});
  return { schemaVersion: 2, timeZone, asOf, days: sortedKeys(days) };
}

/** Two-space JSON with one line per day, so a run's diff shows only the days it counted. */
export function serializeHistory(history: History): string {
  const days = Object.entries(history.days).map(([date, repositories]) => {
    const counts = Object.entries(repositories).map(
      ([repo, count]) => `${JSON.stringify(repo)}: { "commits": ${count.commits}, "pullRequests": ${count.pullRequests} }`,
    );
    return `    ${JSON.stringify(date)}: ${counts.length === 0 ? "{}" : `{ ${counts.join(", ")} }`}`;
  });
  const body = days.length === 0 ? "{}" : `{\n${days.join(",\n")}\n  }`;
  return `{\n  "schemaVersion": 2,\n  "timeZone": ${JSON.stringify(history.timeZone)},\n  "asOf": ${JSON.stringify(history.asOf)},\n  "days": ${body}\n}\n`;
}
