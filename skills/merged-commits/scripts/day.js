/** Select calendar days without assuming that a local day lasts 24 hours. */

/** @param {string} timeZone */
function dateFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** @param {Intl.DateTimeFormat} formatter @param {Date} instant */
function calendarDate(formatter, instant) {
  const parts = formatter.formatToParts(instant);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
}

/** @param {string} date */
function dateEpoch(date) {
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date '${date}'; use today, yesterday, or YYYY-MM-DD.`);
  }
  return epoch;
}

/** @param {string} selector @param {string} timeZone @param {Date} now */
export function selectDay(selector, timeZone, now) {
  const formatter = dateFormatter(timeZone);
  const today = calendarDate(formatter, now);
  const yesterday = new Date(dateEpoch(today) - 86_400_000).toISOString().slice(0, 10);
  const date = selector === "today" ? today : selector === "yesterday" ? yesterday : selector;
  const epoch = dateEpoch(date);
  if (date > today) throw new Error("Cannot count a future date.");
  return {
    date,
    timeZone: formatter.resolvedOptions().timeZone,
    asOf: now.toISOString(),
    // Every IANA UTC offset is within 24 hours. This is only a pagination
    // cutoff; membership uses the actual local calendar date, including DST.
    updatedSince: new Date(epoch - 86_400_000).toISOString(),
    /** @param {string} mergedAt */
    contains(mergedAt) {
      const instant = new Date(mergedAt);
      return instant <= now && calendarDate(formatter, instant) === date;
    },
  };
}
