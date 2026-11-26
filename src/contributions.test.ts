import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datesToCount, type History, parseHistory, recordCounts, serializeHistory, upgradeHistory } from "../scripts/reports/contributions/history";
import { profileCheckout, profileNotReady, statusChanges } from "../scripts/reports/contributions/update";
import { datesBetween } from "../skills/merged-commits/scripts/day";
import { syncRepo } from "./checkouts";
import { loadManifest } from "./manifest";
import { gitIn, gitInit, SPAWNS, tempDir } from "./testFixtures";

const ROOT = path.resolve(import.meta.dir, "..");

function history(days: string[], asOf: string, timeZone = "America/New_York"): History {
  return { schemaVersion: 2, timeZone, asOf, days: Object.fromEntries(days.map(date => [date, { "a2f0/app": { commits: 1, pullRequests: 1 } }])) };
}

test("the first run counts 53 weeks through today", () => {
  const dates = datesToCount(null, "2026-11-26");
  expect(dates).toHaveLength(371);
  expect([dates[0], dates.at(-1)]).toEqual(["2025-11-21", "2026-11-26"]);
});

test("a later run recounts the day it last ran on and backfills every day since", () => {
  // Counted at 15:00 on November 25th in New York: that day may have grown since.
  const stored = history(datesBetween("2025-11-20", "2026-11-25"), "2026-11-25T20:00:00Z");
  expect(datesToCount(stored, "2026-11-25")).toEqual(["2026-11-25"]);
  expect(datesToCount(stored, "2026-11-29")).toEqual(["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  // A day missing from the middle is counted again too.
  const { "2026-06-01": _, ...gap } = stored.days;
  expect(datesToCount({ ...stored, days: gap }, "2026-11-25")).toEqual(["2026-06-01", "2026-11-25"]);
});

test("a stored day without merges is final like any other", () => {
  const stored = history(datesBetween("2025-11-20", "2026-11-25"), "2026-11-25T20:00:00Z");
  stored.days["2026-06-01"] = {};
  expect(datesToCount(stored, "2026-11-25")).toEqual(["2026-11-25"]);
});

test("a version 1 history is counted again from its oldest day, by repository", () => {
  const totals = { schemaVersion: 1 as const, timeZone: "UTC", asOf: "2026-11-25T20:00:00Z", days: { "2024-03-01": { commits: 4, pullRequests: 1 } } };
  expect(upgradeHistory(totals)).toEqual({ existing: null, since: "2024-03-01" });
  expect(upgradeHistory(totals, "2023-01-01")).toEqual({ existing: null, since: "2023-01-01" });
  expect(upgradeHistory({ ...totals, days: {} }, "2026-01-01")).toEqual({ existing: null, since: "2026-01-01" });
  const current = history(["2026-11-24"], "2026-11-25T20:00:00Z");
  expect(upgradeHistory(current, "2026-01-01")).toEqual({ existing: current, since: "2026-01-01" });
  expect(upgradeHistory(null)).toEqual({ existing: null, since: undefined });
});

test("a history counted after today's date, from a skewed clock, leaves nothing to count", () => {
  expect(datesToCount(history(datesBetween("2025-11-20", "2026-11-25"), "2026-11-27T12:00:00Z"), "2026-11-25")).toEqual([]);
});

test("--since adds earlier days without recounting final ones", () => {
  const stored = history(datesBetween("2025-11-25", "2026-11-25"), "2026-11-26T12:00:00Z");
  const dates = datesToCount(stored, "2026-11-26", "2025-01-01");
  expect([dates[0], dates.at(-2), dates.at(-1)]).toEqual(["2025-01-01", "2025-11-24", "2026-11-26"]);
  expect(dates).toHaveLength(datesBetween("2025-01-01", "2025-11-24").length + 1);
});

test("recording keeps other days, empties days without merges, and sorts by date and repository", () => {
  const stored = history(["2026-11-20", "2026-11-25"], "2026-11-21T12:00:00Z");
  const next = recordCounts(
    stored,
    "America/New_York",
    "2026-11-26T12:00:00.000Z",
    ["2026-11-26", "2026-11-25"],
    new Map([
      [
        "2026-11-25",
        {
          "a2f0/web": { commits: 9, pullRequests: 2 },
          "a2f0/api": { commits: 3, pullRequests: 1 },
        },
      ],
    ]),
  );
  expect(next).toEqual({
    schemaVersion: 2,
    timeZone: "America/New_York",
    asOf: "2026-11-26T12:00:00.000Z",
    days: {
      "2026-11-20": { "a2f0/app": { commits: 1, pullRequests: 1 } },
      // A recounted day replaces every repository's count, so one that stopped counting drops out.
      "2026-11-25": { "a2f0/api": { commits: 3, pullRequests: 1 }, "a2f0/web": { commits: 9, pullRequests: 2 } },
      "2026-11-26": {},
    },
  });
  expect(Object.keys(next.days)).toEqual(["2026-11-20", "2026-11-25", "2026-11-26"]);
  expect(Object.keys(next.days["2026-11-25"]!)).toEqual(["a2f0/api", "a2f0/web"]);
});

test("serializes one line per day and parses back", () => {
  const stored = history(["2026-11-24", "2026-11-25"], "2026-11-26T12:00:00.000Z");
  stored.days["2026-11-25"]!["a2f0/web"] = { commits: 12, pullRequests: 3 };
  stored.days["2026-11-26"] = {};
  const text = serializeHistory(stored);
  expect(text).toBe(
    `{
  "schemaVersion": 2,
  "timeZone": "America/New_York",
  "asOf": "2026-11-26T12:00:00.000Z",
  "days": {
    "2026-11-24": { "a2f0/app": { "commits": 1, "pullRequests": 1 } },
    "2026-11-25": { "a2f0/app": { "commits": 1, "pullRequests": 1 }, "a2f0/web": { "commits": 12, "pullRequests": 3 } },
    "2026-11-26": {}
  }
}
`,
  );
  expect(parseHistory(text, "commits.json")).toEqual(stored);
  expect(serializeHistory({ ...stored, days: {} })).toContain('"days": {}\n}');
});

test.each([
  ["{", "is not JSON"],
  ['{"schemaVersion":3}', "schemaVersion must be 2, or 1 to count again by repository"],
  // A version 1 history kept only each day's totals, which must still be valid to count again.
  [
    '{"schemaVersion":1,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":{"a2f0/app":{"commits":1,"pullRequests":1}}}}',
    "days.2026-11-25 needs non-negative integer",
  ],
  ['{"schemaVersion":2,"timeZone":"UTC","asOf":"soon","days":{}}', "asOf must be an ISO 8601 instant"],
  ['{"schemaVersion":2,"timeZone":"UTC","asOf":"Nov 26 2026","days":{}}', "asOf must be an ISO 8601 instant"],
  ['{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-02-30T00:00:00Z","days":{}}', "asOf must be an ISO 8601 instant"],
  [
    '{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-27":{}}}',
    "days.2026-11-27 is after the local date of asOf (2026-11-26)",
  ],
  ['{"schemaVersion":2,"timeZone":"Not/A_Zone","asOf":"2026-11-26T00:00:00Z","days":{}}', "timeZone must be an IANA time zone"],
  ['{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-02-30":{}}}', "invalid date '2026-02-30'"],
  ['{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":[]}}', "days.2026-11-25 must be an object of repositories"],
  [
    '{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":{"commits":1,"pullRequests":0}}}',
    "days.2026-11-25 has an invalid repository 'commits'",
  ],
  [
    '{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":{"../..":{"commits":1,"pullRequests":1}}}}',
    "days.2026-11-25 has an invalid repository '../..'",
  ],
  [
    '{"schemaVersion":2,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":{"a2f0/app":{"commits":-1,"pullRequests":0}}}}',
    'days.2026-11-25["a2f0/app"] needs non-negative integer',
  ],
])("rejects an invalid history: %s", (text, message) => {
  expect(() => parseHistory(text, "commits.json")).toThrow(message);
});

const NO_MERGES = `echo '{"data":{"repository":{"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'`;

/** An empty profile checkout, and a gh that answers GraphQL queries with `graphql`, by default no merged PRs. */
function workspace(graphql = NO_MERGES) {
  const dir = tempDir("contributions");
  const bin = path.join(dir, "bin");
  const profile = path.join(dir, "profile");
  mkdirSync(bin);
  mkdirSync(profile);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
if [ "$1" = repo ]; then echo fixture/workspace; exit 0; fi
${graphql}
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const run = (...args: string[]) =>
    spawnSync(path.join(ROOT, "scripts/reports/updateContributions.ts"), ["--profile", profile, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) },
    });
  return { profile, run };
}

test("finds the owner's profile checkout, in any case, only when it is ready for new counts", SPAWNS, () => {
  const root = tempDir("profile-root");
  const ready = () => undefined;
  expect(() => profileCheckout(root, ["a2f0/app"], "a2f0/matrix", ready)).toThrow("does not manage the profile repository a2f0/a2f0");
  expect(() => profileCheckout(root, ["A2F0/a2f0"], "a2f0/matrix", ready)).toThrow("run bun run sync A2F0/a2f0 first");
  mkdirSync(path.join(root, "checkouts", "a2f0"), { recursive: true });
  expect(profileCheckout(root, ["a2f0/app", "A2F0/a2f0"], "a2f0/matrix", ready)).toBe(path.join(root, "checkouts", "a2f0"));
  expect(() => profileCheckout(root, ["a2f0/a2f0"], "a2f0/matrix", () => "on branch feat/other")).toThrow(
    "a2f0/a2f0 is not ready for new counts (on branch feat/other); return it to its updated default branch, or pass --profile",
  );
  // The real check finds a directory that is not a Git checkout not ready.
  writeFileSync(
    path.join(root, "matrix.json"),
    JSON.stringify({ schemaVersion: 1, protocol: "ssh", discover: { owner: "a2f0", visibility: "public", exclude: [] }, repos: ["a2f0/a2f0"] }),
  );
  expect(() => profileCheckout(root, ["a2f0/a2f0"], "a2f0/matrix")).toThrow("a2f0/a2f0 is not ready for new counts");
});

test("lists a checkout's changes by path, first entry included, with renames and unusual names", SPAWNS, () => {
  const dir = tempDir("profile-status");
  gitInit(dir);
  for (const file of ["README.md", "package.json", "old name.md"]) writeFileSync(path.join(dir, file), `${file}\n`);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "seed");
  expect(statusChanges(dir)).toEqual([]);
  // README.md sorts first, where a trimmed version 1 listing would lose its leading space.
  writeFileSync(path.join(dir, "README.md"), "changed\n");
  writeFileSync(path.join(dir, "package.json"), "{}\n");
  mkdirSync(path.join(dir, "contributions"));
  writeFileSync(path.join(dir, "contributions", "commits.json"), "{}\n");
  gitIn(dir, "mv", "old name.md", 'new "name".md');
  expect(statusChanges(dir)).toEqual([["README.md"], ['new "name".md', "old name.md"], ["package.json"], ["contributions/commits.json"]]);
});

test("a profile checkout is ready for new counts only on its updated default branch, apart from the history a run writes", SPAWNS, () => {
  const temporary = tempDir("profile-ready");
  const root = path.join(temporary, "matrix");
  const seed = path.join(temporary, "seed");
  const remote = path.join(temporary, "remote.git");
  const checkout = path.join(root, "checkouts", "a2f0");
  mkdirSync(root);
  mkdirSync(seed);
  gitIn(seed, "init", "-q", "-b", "main");
  for (const file of ["README.md", "package.json"]) writeFileSync(path.join(seed, file), `${file}\n`);
  gitIn(seed, "add", ".");
  gitIn(seed, "commit", "-q", "-m", "seed");
  gitIn(temporary, "clone", "-q", "--bare", seed, remote);
  syncRepo(root, "a2f0/a2f0", remote);
  expect(profileNotReady(root, "a2f0/other", remote)).toBe("checkout missing; run sync");
  const reason = () => profileNotReady(root, "a2f0/a2f0", remote);
  expect(reason()).toBeUndefined();

  // An earlier run's output, not yet shipped.
  mkdirSync(path.join(checkout, "contributions"));
  writeFileSync(path.join(checkout, "contributions", "commits.json"), "{}\n");
  expect(reason()).toBeUndefined();

  // Other files there, the README included, are someone's work.
  writeFileSync(path.join(checkout, "contributions", "notes.txt"), "mine\n");
  expect(reason()).toBe("1 local change");
  rmSync(path.join(checkout, "contributions", "notes.txt"));
  writeFileSync(path.join(checkout, "README.md"), "mine\n");
  expect(reason()).toBe("1 local change");
  gitIn(checkout, "checkout", "-q", "README.md");
  writeFileSync(path.join(checkout, "package.json"), "{}\n");
  expect(reason()).toBe("1 local change");
  gitIn(checkout, "checkout", "-q", "package.json");
  gitIn(checkout, "update-index", "--assume-unchanged", "package.json");
  expect(reason()).toBe("1 local change");
  gitIn(checkout, "update-index", "--no-assume-unchanged", "package.json");

  gitIn(checkout, "checkout", "-q", "-b", "feat/other");
  expect(reason()).toBe("on branch feat/other");
  gitIn(checkout, "checkout", "-q", "main");
  writeFileSync(path.join(seed, "package.json"), "{}\n");
  gitIn(seed, "commit", "-q", "-am", "update");
  gitIn(seed, "push", "-q", remote, "HEAD");
  gitIn(checkout, "fetch", "-q", "origin");
  expect(reason()).toBe("1 commit behind origin; run sync");
});

test("the script backfills a new history, and then recounts only from its last day", SPAWNS, () => {
  const { profile, run } = workspace();
  const first = run("--timezone", "UTC");
  expect(first.stderr).toContain("fixture/workspace: 0 merged PRs");
  expect(first.status).toBe(0);
  const report = JSON.parse(first.stdout);
  expect(report).toMatchObject({ profile, timeZone: "UTC", repositories: loadManifest(ROOT).repos.length + 1, counted: { days: 371, commits: 0 } });
  const stored = parseHistory(readFileSync(path.join(profile, "contributions/commits.json"), "utf8"), "commits.json");
  expect(Object.keys(stored.days)).toHaveLength(371);
  // Days without merges hold no repositories.
  expect(Object.values(stored.days).every(repositories => Object.keys(repositories).length === 0)).toBe(true);
  // The history is the only file a run writes.
  expect(readdirSync(profile, { recursive: true }).sort()).toEqual(["contributions", path.join("contributions", "commits.json")]);

  const second = run();
  expect(second.status).toBe(0);
  // One day, or two when the runs straddle midnight.
  const { first: from, last, days } = JSON.parse(second.stdout).counted;
  expect(from).toBe(report.counted.last);
  expect(days).toBe(datesBetween(from, last).length);
  expect(days).toBeLessThanOrEqual(2);

  for (const since of ["2999-01-01", "2026-02-30", "soon"]) {
    const rejected = run("--since", since);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("--since must be a YYYY-MM-DD date no later than today");
  }

  const mixed = run("--timezone", "America/New_York");
  expect(mixed.status).toBe(1);
  expect(mixed.stderr).toContain("records UTC days; it cannot mix in America/New_York");

  // A zone spelled differently by hand still resolves to the same one.
  const file = path.join(profile, "contributions/commits.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"timeZone": "UTC"', '"timeZone": "utc"'));
  expect(run("--timezone", "UTC").status).toBe(0);
  expect(existsSync(`${file}.tmp`)).toBe(false);

  // A history counted on a later date, from a clock that has since moved back, is left alone.
  const skewed = readFileSync(file, "utf8").replace(/"asOf": "[^"]+"/, '"asOf": "2999-01-01T00:00:00.000Z"');
  writeFileSync(file, skewed);
  const behind = run();
  expect(behind.status).toBe(1);
  expect(behind.stderr).toContain("after today");
  expect(readFileSync(file, "utf8")).toBe(skewed);
});

test("the script records each repository's counts beside the others' on the days they merged", SPAWNS, () => {
  // Every repository merged one PR of two commits at noon on June 1st, 2024.
  const pullRequests = JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 1,
              url: "https://github.com/fixture/pull/1",
              mergedAt: "2024-06-01T12:00:00Z",
              updatedAt: "2024-06-01T12:00:00Z",
              baseRefOid: "base",
              headRefOid: "head",
              commits: { totalCount: 2 },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  });
  const nodes = ["a", "b"].map(oid => ({ commit: { oid, parents: { totalCount: 1 } } }));
  const commits = JSON.stringify({
    data: { repository: { p1: { commits: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
  });
  const { profile, run } = workspace(`case "$*" in
  *"pullRequest(number"*) echo '${commits}' ;;
  *) echo '${pullRequests}' ;;
esac`);
  const result = run("--timezone", "UTC", "--since", "2024-05-31");
  expect(result.status).toBe(0);
  const scope = [...loadManifest(ROOT).repos, "fixture/workspace"];
  const stored = parseHistory(readFileSync(path.join(profile, "contributions/commits.json"), "utf8"), "commits.json");
  expect(stored.days["2024-06-01"]).toEqual(Object.fromEntries(scope.map(repo => [repo, { commits: 2, pullRequests: 1 }])));
  expect(Object.keys(stored.days["2024-06-01"]!)).toEqual(scope.sort());
  expect(stored.days["2024-05-31"]).toEqual({});
  expect(JSON.parse(result.stdout).counted).toMatchObject({ first: "2024-05-31", commits: 2 * scope.length, pullRequests: scope.length });
});

test("the script counts a version 1 history again in full, keeping every day it held", SPAWNS, () => {
  const { profile, run } = workspace();
  const file = path.join(profile, "contributions/commits.json");
  mkdirSync(path.dirname(file));
  const days = { "2024-01-01": { commits: 3, pullRequests: 1 }, "2024-06-01": { commits: 0, pullRequests: 0 } };
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, timeZone: "UTC", asOf: "2024-06-02T00:00:00.000Z", days }));
  const result = run();
  expect(result.status).toBe(0);
  const { counted } = JSON.parse(result.stdout);
  expect(counted.first).toBe("2024-01-01");
  const stored = parseHistory(readFileSync(file, "utf8"), "commits.json");
  expect(stored.schemaVersion).toBe(2);
  expect(stored.timeZone).toBe("UTC");
  expect(Object.keys(stored.days)).toEqual(datesBetween("2024-01-01", counted.last));
  // The fake gh reports no merges, so the old totals give way to empty days.
  expect(stored.days["2024-01-01"]).toEqual({});
});
