/** Select calendar days without assuming that a local day lasts 24 hours. */

/** Local calendar days to count, and the instant the count began. */
export interface Window {
  timeZone: string;
  asOf: string;
  /** No PR merged inside the window was last updated before this instant. */
  updatedSince: string;
  /** The local date of a merge inside the window, or null when it falls outside. */
  dateOf(mergedAt: string): string | null;
}

export interface Day extends Window {
  date: string;
  contains(mergedAt: string): boolean;
}

const DAY_MS = 86_400_000;

function dateFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

function calendarDate(formatter: Intl.DateTimeFormat, instant: Date) {
  const parts = formatter.formatToParts(instant);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
}

function dateEpoch(date: string) {
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date '${date}'; use today, yesterday, or YYYY-MM-DD.`);
  }
  return epoch;
}

/** The YYYY-MM-DD date `days` calendar days after `date` (negative for before). */
export function addDays(date: string, days: number): string {
  return new Date(dateEpoch(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `first` through `last`, inclusive. */
export function datesBetween(first: string, last: string): string[] {
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** The local calendar date of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return calendarDate(dateFormatter(timeZone), instant);
}

/** Select the local dates `first` through `last`, counting merges up to `now`. */
export function selectRange(first: string, last: string, timeZone: string, now: Date): Window {
  const formatter = dateFormatter(timeZone);
  const start = dateEpoch(first);
  dateEpoch(last);
  if (last > calendarDate(formatter, now)) throw new Error("Cannot count a future date.");
  if (first > last) throw new Error(`The first date ${first} is after the last date ${last}.`);
  return {
    timeZone: formatter.resolvedOptions().timeZone,
    asOf: now.toISOString(),
    // Every IANA UTC offset is within 24 hours. This is only a pagination
    // cutoff; membership uses the actual local calendar date, including DST.
    updatedSince: new Date(start - DAY_MS).toISOString(),
    dateOf(mergedAt) {
      const instant = new Date(mergedAt);
      if (instant > now) return null;
      const date = calendarDate(formatter, instant);
      return date >= first && date <= last ? date : null;
    },
  };
}

/** The window, counting only merges on `dates`, so other days' PRs are never read. */
export function onDates(window: Window, dates: Iterable<string>): Window {
  const counted = new Set(dates);
  return {
    ...window,
    dateOf(mergedAt) {
      const date = window.dateOf(mergedAt);
      return date !== null && counted.has(date) ? date : null;
    },
  };
}

export function selectDay(selector: string, timeZone: string, now: Date): Day {
  const today = localDate(now, timeZone);
  const date = selector === "today" ? today : selector === "yesterday" ? addDays(today, -1) : selector;
  const window = selectRange(date, date, timeZone, now);
  return { ...window, date, contains: mergedAt => window.dateOf(mergedAt) === date };
}
