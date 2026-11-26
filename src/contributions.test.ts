import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datesToCount, type History, parseHistory, recordCounts, serializeHistory } from "../scripts/reports/contributions/history";
import { miseBun, pinnedBun, profileCheckout, profileNotReady, statusChanges } from "../scripts/reports/contributions/update";
import { datesBetween } from "../skills/merged-commits/scripts/day";
import { syncRepo } from "./checkouts";
import { loadManifest } from "./manifest";
import { gitIn, gitInit, SPAWNS, tempDir } from "./testFixtures";

const ROOT = path.resolve(import.meta.dir, "..");

function history(days: string[], asOf: string, timeZone = "America/New_York"): History {
  return { schemaVersion: 1, timeZone, asOf, days: Object.fromEntries(days.map(date => [date, { commits: 1, pullRequests: 1 }])) };
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

test("a history counted after today's date, from a skewed clock, leaves nothing to count", () => {
  expect(datesToCount(history(datesBetween("2025-11-20", "2026-11-25"), "2026-11-27T12:00:00Z"), "2026-11-25")).toEqual([]);
});

test("--since adds earlier days without recounting final ones", () => {
  const stored = history(datesBetween("2025-11-25", "2026-11-25"), "2026-11-26T12:00:00Z");
  const dates = datesToCount(stored, "2026-11-26", "2025-01-01");
  expect([dates[0], dates.at(-2), dates.at(-1)]).toEqual(["2025-01-01", "2025-11-24", "2026-11-26"]);
  expect(dates).toHaveLength(datesBetween("2025-01-01", "2025-11-24").length + 1);
});

test("recording keeps other days, zeroes days without merges, and sorts by date", () => {
  const stored = history(["2026-11-20"], "2026-11-21T12:00:00Z");
  const next = recordCounts(
    stored,
    "America/New_York",
    "2026-11-26T12:00:00.000Z",
    ["2026-11-26", "2026-11-25"],
    new Map([["2026-11-25", { commits: 9, pullRequests: 2 }]]),
  );
  expect(next).toEqual({
    schemaVersion: 1,
    timeZone: "America/New_York",
    asOf: "2026-11-26T12:00:00.000Z",
    days: {
      "2026-11-20": { commits: 1, pullRequests: 1 },
      "2026-11-25": { commits: 9, pullRequests: 2 },
      "2026-11-26": { commits: 0, pullRequests: 0 },
    },
  });
  expect(Object.keys(next.days)).toEqual(["2026-11-20", "2026-11-25", "2026-11-26"]);
});

test("serializes one line per day and parses back", () => {
  const stored = history(["2026-11-25", "2026-11-26"], "2026-11-26T12:00:00.000Z");
  const text = serializeHistory(stored);
  expect(text).toBe(
    `{
  "schemaVersion": 1,
  "timeZone": "America/New_York",
  "asOf": "2026-11-26T12:00:00.000Z",
  "days": {
    "2026-11-25": { "commits": 1, "pullRequests": 1 },
    "2026-11-26": { "commits": 1, "pullRequests": 1 }
  }
}
`,
  );
  expect(parseHistory(text, "commits.json")).toEqual(stored);
  expect(serializeHistory({ ...stored, days: {} })).toContain('"days": {}\n}');
});

test.each([
  ["{", "is not JSON"],
  ['{"schemaVersion":2}', "schemaVersion must be 1"],
  ['{"schemaVersion":1,"timeZone":"UTC","asOf":"soon","days":{}}', "asOf must be an ISO 8601 instant"],
  ['{"schemaVersion":1,"timeZone":"UTC","asOf":"Nov 26 2026","days":{}}', "asOf must be an ISO 8601 instant"],
  ['{"schemaVersion":1,"timeZone":"UTC","asOf":"2026-02-30T00:00:00Z","days":{}}', "asOf must be an ISO 8601 instant"],
  [
    '{"schemaVersion":1,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-27":{"commits":1,"pullRequests":0}}}',
    "days.2026-11-27 is after the local date of asOf (2026-11-26)",
  ],
  ['{"schemaVersion":1,"timeZone":"Not/A_Zone","asOf":"2026-11-26T00:00:00Z","days":{}}', "timeZone must be an IANA time zone"],
  ['{"schemaVersion":1,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-02-30":{"commits":1,"pullRequests":0}}}', "invalid date '2026-02-30'"],
  ['{"schemaVersion":1,"timeZone":"UTC","asOf":"2026-11-26T00:00:00Z","days":{"2026-11-25":{"commits":-1,"pullRequests":0}}}', "non-negative integer"],
])("rejects an invalid history: %s", (text, message) => {
  expect(() => parseHistory(text, "commits.json")).toThrow(message);
});

/** A profile checkout whose renderer records that it ran, and a gh with no merged PRs. */
function workspace() {
  const dir = tempDir("contributions");
  const bin = path.join(dir, "bin");
  const profile = path.join(dir, "profile");
  mkdirSync(bin);
  mkdirSync(profile);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
if [ "$1" = repo ]; then echo fixture/workspace; exit 0; fi
echo '{"data":{"repository":{"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(profile, "package.json"), JSON.stringify({ scripts: { "contributions:render": "echo rendered > rendered.txt" } }));
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

test("a profile checkout is ready for new counts only on its updated default branch, apart from files a run writes", SPAWNS, () => {
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
  writeFileSync(path.join(checkout, "README.md"), "grid\n");
  mkdirSync(path.join(checkout, "contributions"));
  writeFileSync(path.join(checkout, "contributions", "commits.json"), "{}\n");
  writeFileSync(path.join(checkout, "contributions", "level-0.svg"), "<svg/>\n");
  expect(reason()).toBeUndefined();

  writeFileSync(path.join(checkout, "contributions", "notes.txt"), "mine\n");
  expect(reason()).toBe("1 local change");
  rmSync(path.join(checkout, "contributions", "notes.txt"));
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

test("reads a plain [tools] Bun pin and refuses one it cannot read", () => {
  expect(miseBun('[tools]\nbun = "1.4.4" # pinned\n')).toBe("1.4.4");
  expect(miseBun('[tools]\nshellcheck = "0.11.0"\n')).toBeUndefined();
  for (const pin of ['bun = { version = "1.4.4" }', '"bun" = "1.4.4"', "bun = 'latest'"]) {
    expect(() => miseBun(`[tools]\n${pin}\n`)).toThrow('write it as bun = "<version>"');
  }
});

test("runs the profile's render with the Bun its .mise.toml pins", () => {
  const dir = tempDir("profile-bun");
  const installs = tempDir("mise-installs");
  expect(pinnedBun(dir, installs)).toBe(process.execPath);
  // Only the [tools] table pins a tool.
  writeFileSync(path.join(dir, ".mise.toml"), '[env]\nbun = "0.0.1"\n');
  expect(pinnedBun(dir, installs)).toBe(process.execPath);
  writeFileSync(path.join(dir, ".mise.toml"), '[env]\nbun = "0.0.1"\n\n[tools]\nbun = "9.9.9"\nshellcheck = "0.11.0"\n');
  expect(() => pinnedBun(dir, installs)).toThrow("pins Bun 9.9.9, which mise has not installed; run mise install there first.");
  mkdirSync(path.join(installs, "bun", "9.9.9", "bin"), { recursive: true });
  writeFileSync(path.join(installs, "bun", "9.9.9", "bin", "bun"), "");
  expect(pinnedBun(dir, installs)).toBe(path.join(installs, "bun", "9.9.9", "bin", "bun"));
});

test("the script backfills a new history, renders the profile, and then recounts only from its last day", SPAWNS, () => {
  const { profile, run } = workspace();
  const first = run("--timezone", "UTC");
  expect(first.stderr).toContain("fixture/workspace: 0 merged PRs");
  expect(first.status).toBe(0);
  const report = JSON.parse(first.stdout);
  expect(report).toMatchObject({ profile, timeZone: "UTC", repositories: loadManifest(ROOT).repos.length + 1, counted: { days: 371, commits: 0 } });
  const stored = parseHistory(readFileSync(path.join(profile, "contributions/commits.json"), "utf8"), "commits.json");
  expect(Object.keys(stored.days)).toHaveLength(371);
  expect(existsSync(path.join(profile, "rendered.txt"))).toBe(true);

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
});

test("a failing renderer fails the run after the history is saved", SPAWNS, () => {
  const { profile, run } = workspace();
  writeFileSync(path.join(profile, "package.json"), JSON.stringify({ scripts: { "contributions:render": "exit 3" } }));
  const result = run("--timezone", "UTC");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("bun run contributions:render failed");
  expect(existsSync(path.join(profile, "contributions/commits.json"))).toBe(true);
});
