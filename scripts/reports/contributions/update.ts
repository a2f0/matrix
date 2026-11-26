import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { addDays, localDate, selectRange } from "../../../skills/merged-commits/scripts/day";
import { countDays, type DayCount, includingWorkspace, matrixScope } from "../../../skills/merged-commits/scripts/github";
import { checkoutPath } from "../../../src/manifest";
import { datesToCount, HISTORY_FILE, type History, parseHistory, recordCounts, serializeHistory } from "./history";

const USAGE = `Usage: bun run contributions [--since YYYY-MM-DD] [--timezone IANA] [--profile DIR]
       scripts/reports/updateContributions.ts [same options]

Count the original (pre-squash) commits in PRs merged across matrix.json
repositories and this workspace for every day the profile repository's
${HISTORY_FILE} is missing or counted before the day ended, then render its
README's contributions grid with that repository's bun run contributions:render.
The first run counts the last 53 weeks; --since also counts every day from that
date. --timezone sets the calendar of a new history (default: this machine's).
--profile overrides the checkout of <owner>/<owner> from matrix.json.
Requires an authenticated gh CLI. Prints JSON; progress goes to stderr.
`;

const ROOT = path.resolve(import.meta.dir, "../../..");

function profileCheckout(repos: string[], workspace: string): string {
  const owner = workspace.split("/")[0]!;
  const repo = repos.find(candidate => candidate.toLowerCase() === `${owner}/${owner}`.toLowerCase());
  if (!repo) throw new Error(`matrix.json does not manage the profile repository ${owner}/${owner}; add it or pass --profile.`);
  const dir = checkoutPath(ROOT, repo);
  if (!existsSync(dir)) throw new Error(`${dir} is missing; run bun run sync ${repo} first.`);
  return dir;
}

function resolveTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

function historyTimeZone(history: History | null, requested: string | undefined): string {
  if (!history) return resolveTimeZone(requested ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (requested && resolveTimeZone(requested) !== history.timeZone) {
    throw new Error(`${HISTORY_FILE} records ${history.timeZone} days; it cannot mix in ${requested}.`);
  }
  return history.timeZone;
}

function addCounts(total: Map<string, DayCount>, days: Map<string, DayCount>) {
  for (const [date, day] of days) {
    const sum = total.get(date) ?? { commits: 0, pullRequests: 0 };
    total.set(date, { commits: sum.commits + day.commits, pullRequests: sum.pullRequests + day.pullRequests });
  }
}

function sum(days: Iterable<DayCount>): DayCount {
  let commits = 0;
  let pullRequests = 0;
  for (const day of days) {
    commits += day.commits;
    pullRequests += day.pullRequests;
  }
  return { commits, pullRequests };
}

function render(profile: string) {
  // The profile repository owns its README; run its renderer with this Bun, its output on stderr.
  const result = spawnSync(process.execPath, ["run", "contributions:render"], { cwd: profile, stdio: ["ignore", 2, 2] });
  if (result.error) throw new Error(`Could not run bun in ${profile}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`bun run contributions:render failed in ${profile} (exit ${result.status ?? result.signal}).`);
}

function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string" }, timezone: { type: "string" }, profile: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.since) addDays(values.since, 0);
  const { repos, workspace } = matrixScope(ROOT);
  const profile = values.profile ? path.resolve(values.profile) : profileCheckout(repos, workspace);
  const file = path.join(profile, HISTORY_FILE);
  const existing = existsSync(file) ? parseHistory(readFileSync(file, "utf8"), file) : null;
  const timeZone = historyTimeZone(existing, values.timezone);
  const now = new Date();
  const today = localDate(now, timeZone);
  const dates = datesToCount(existing, today, values.since);
  const window = selectRange(dates[0]!, today, timeZone, now);
  const scope = includingWorkspace(repos, workspace);
  const counts = new Map<string, DayCount>();
  for (const repo of scope) {
    const days = countDays(repo, window);
    const total = sum(days.values());
    console.error(`${repo}: ${total.pullRequests} merged PRs, ${total.commits} original commits from ${dates[0]} through ${today}`);
    addCounts(counts, days);
  }
  const history = recordCounts(existing, timeZone, window.asOf, dates, counts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeHistory(history));
  render(profile);
  const counted = sum(dates.map(date => history.days[date]!));
  console.log(
    JSON.stringify(
      { profile, timeZone, asOf: window.asOf, repositories: scope.length, counted: { first: dates[0], last: today, days: dates.length, ...counted } },
      null,
      2,
    ),
  );
}

/** Update the profile's contributions history and grid for `args`, returning the exit status. */
export function run(args: string[]): number {
  try {
    main(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
