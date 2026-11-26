import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { localDate, onDates, selectRange } from "../../../skills/merged-commits/scripts/day";
import { countDays, type DayCount, includingWorkspace, matrixScope } from "../../../skills/merged-commits/scripts/github";
import { checkoutStatus, notReady } from "../../../src/checkouts";
import { gitOutput } from "../../../src/git";
import { checkoutPath, cloneUrl, loadManifest } from "../../../src/manifest";
import { datesToCount, HISTORY_FILE, type History, isDate, parseHistory, recordCounts, serializeHistory } from "./history";

const USAGE = `Usage: bun run contributions [--since YYYY-MM-DD] [--timezone IANA] [--profile DIR]
       scripts/reports/updateContributions.ts [same options]

Count the original (pre-squash) commits in PRs merged across matrix.json
repositories and this workspace for every day the profile repository's
${HISTORY_FILE} is missing or counted before the day ended, which that
repository's web page renders. The first run counts the last 53 weeks; --since
also counts every day from that date. --timezone sets the calendar of a new
history (default: this machine's).
It writes into the checkout of <owner>/<owner> from matrix.json only when that
checkout is ready, as bun run status reports it, apart from changes to the file
a run writes; --profile writes into another directory as it is.
Requires an authenticated gh CLI. Prints JSON; progress goes to stderr.
`;

const ROOT = path.resolve(import.meta.dir, "../../..");

/** Whether a run writes `file`, which is only the history. */
function isGenerated(file: string): boolean {
  return file === HISTORY_FILE;
}

/** The space-separated field where each kind of version 2 porcelain entry starts its path. */
const PATH_FIELD: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1, "!": 1 };

/**
 * The checkout's changes, one entry per file, each listing its path and, for a
 * rename, its original path. Version 2 porcelain never starts an entry with a
 * space, which matters because matrix's Git helper trims output, and with -z
 * paths arrive unquoted.
 */
export function statusChanges(dir: string): string[][] {
  const fields = gitOutput(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"])
    .split("\0")
    .filter(field => field !== "");
  const changes: string[][] = [];
  for (let field = fields.shift(); field !== undefined; field = fields.shift()) {
    const paths = [
      field
        .split(" ")
        .slice(PATH_FIELD[field[0]!] ?? 1)
        .join(" "),
    ];
    // A rename or copy is followed by its original path.
    if (field.startsWith("2 ")) paths.push(fields.shift() ?? "");
    changes.push(paths);
  }
  return changes;
}

/**
 * Why a run must not write into a managed checkout, as `bun run status` would
 * say, ignoring changes to the files a run writes. Tracked files flagged
 * assume-unchanged or skip-worktree still count, as they do there.
 */
export function profileNotReady(root: string, repo: string, url = cloneUrl(repo, loadManifest(root).protocol)): string | undefined {
  const status = checkoutStatus(root, repo, url);
  if (status.ready || status.error || !status.present) return notReady(status);
  const dir = checkoutPath(root, repo);
  const others = statusChanges(dir).filter(paths => !paths.every(isGenerated)).length;
  const hidden = gitOutput(dir, ["ls-files", "-v"])
    .split("\n")
    .filter(line => /^[a-zS] /.test(line)).length;
  return notReady({ ...status, changes: others + hidden });
}

/**
 * The checkout of the workspace owner's profile repository, `<owner>/<owner>`,
 * which must be on its updated default branch so new counts never land in
 * other work.
 */
export function profileCheckout(root: string, repos: string[], workspace: string, notReadyReason = profileNotReady): string {
  const owner = workspace.split("/")[0]!;
  const repo = repos.find(candidate => candidate.toLowerCase() === `${owner}/${owner}`.toLowerCase());
  if (!repo) throw new Error(`matrix.json does not manage the profile repository ${owner}/${owner}; add it or pass --profile.`);
  const dir = checkoutPath(root, repo);
  if (!existsSync(dir)) throw new Error(`${dir} is missing; run bun run sync ${repo} first.`);
  const reason = notReadyReason(root, repo);
  if (reason)
    throw new Error(`${repo} is not ready for new counts (${reason}); return it to its updated default branch, or pass --profile to write into it as it is.`);
  return dir;
}

function validSince(since: string | undefined, today: string): string | undefined {
  if (since !== undefined && (!isDate(since) || since > today)) throw new Error(`--since must be a YYYY-MM-DD date no later than today (${today}).`);
  return since;
}

function resolveTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

function historyTimeZone(history: History | null, requested: string | undefined): string {
  if (!history) return resolveTimeZone(requested ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  // Compare resolved names, so a hand-written utc matches UTC.
  if (requested && resolveTimeZone(requested) !== resolveTimeZone(history.timeZone)) {
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

function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string" }, timezone: { type: "string" }, profile: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const { repos, workspace } = matrixScope(ROOT);
  const profile = values.profile ? path.resolve(values.profile) : profileCheckout(ROOT, repos, workspace);
  const file = path.join(profile, HISTORY_FILE);
  const existing = existsSync(file) ? parseHistory(readFileSync(file, "utf8"), file) : null;
  const timeZone = historyTimeZone(existing, values.timezone);
  const now = new Date();
  const today = localDate(now, timeZone);
  // A history counted on a later date than today came from a clock that has
  // since moved back; recording an earlier asOf would strand its later days.
  if (existing && localDate(new Date(existing.asOf), timeZone) > today)
    throw new Error(`${HISTORY_FILE} was counted at ${existing.asOf}, after today (${today} in ${timeZone}); check this machine's clock.`);
  const dates = datesToCount(existing, today, validSince(values.since, today));
  // Dates before today that are already final are skipped, not recounted.
  const window = onDates(selectRange(dates[0]!, today, timeZone, now), dates);
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
  // Replace the file whole, so an interrupted run leaves the previous history.
  writeFileSync(`${file}.tmp`, serializeHistory(history));
  renameSync(`${file}.tmp`, file);
  const counted = sum(dates.map(date => history.days[date]!));
  console.log(
    JSON.stringify(
      { profile, timeZone, asOf: window.asOf, repositories: scope.length, counted: { first: dates[0], last: today, days: dates.length, ...counted } },
      null,
      2,
    ),
  );
}

/** Update the profile's contributions history for `args`, returning the exit status. */
export function run(args: string[]): number {
  try {
    main(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
