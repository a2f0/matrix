import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { onDates, selectDay, selectRange } from "../skills/merged-commits/scripts/day";
import {
  buildReport,
  type Commit,
  type Commits,
  type Compare,
  countDays,
  countRepository,
  type Graphql,
  includingWorkspace,
  type PullRequest,
  summarize,
} from "../skills/merged-commits/scripts/github";

import { loadManifest } from "./manifest";
import { SPAWNS, tempDir } from "./testFixtures";

const now = new Date("2026-11-06T23:46:10Z");
const day = selectDay("yesterday", "America/New_York", now);

function pr(number: number, mergedAt: string, count: number, updatedAt = mergedAt): PullRequest {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    mergedAt,
    updatedAt,
    baseRefOid: `base${number}`,
    headRefOid: `head${number}`,
    commits: { totalCount: count },
  };
}

function commit(oid: string, parents = 1): Commit {
  return { oid, parents: { totalCount: parents } };
}

function commits(nodes: Commit[], totalCount = nodes.length, cursor: string | null = null): Commits {
  return { totalCount, nodes: nodes.map(commit => ({ commit })), pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } };
}

function prs(nodes: PullRequest[], cursor: string | null = null) {
  return { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } };
}

test.each([
  ["2026-03-08", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
  ["2026-11-01", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ["2026-11-05", "Pacific/Kiritimati", "2026-11-04T10:00:00Z", "2026-11-05T10:00:00Z"],
  ["2026-11-05", "Etc/GMT+12", "2026-11-05T12:00:00Z", "2026-11-06T12:00:00Z"],
])("counts the exact local day %s in %s", (date, timeZone, start, end) => {
  const selection = selectDay(date, timeZone, now);
  expect(selection.contains(new Date(Date.parse(start) - 1).toISOString())).toBe(false);
  expect(selection.contains(start)).toBe(true);
  expect(selection.contains(new Date(Date.parse(end) - 1).toISOString())).toBe(true);
  expect(selection.contains(end)).toBe(false);
});

test("relative dates use the local calendar and never include merges after the cutoff", () => {
  const cutoff = new Date("2026-11-02T04:30:00Z");
  const today = selectDay("today", "America/New_York", cutoff);
  expect(today.date).toBe("2026-11-01");
  expect(selectDay("yesterday", "America/New_York", cutoff).date).toBe("2026-10-31");
  expect(today.contains(cutoff.toISOString())).toBe(true);
  expect(today.contains("2026-11-02T04:30:01Z")).toBe(false);
  expect(() => selectDay("2026-11-02", "America/New_York", cutoff)).toThrow("future date");
  expect(() => selectDay("2026-02-30", "UTC", cutoff)).toThrow("Invalid date");
  expect(() => selectDay("yesterday", "Not/A_Timezone", cutoff)).toThrow();
});

test("paginates PRs by update time and all commits, deduplicating overlapping PRs", () => {
  const first = pr(1, "2026-11-05T05:00:00Z", 101);
  const second = pr(2, "2026-11-06T04:59:59Z", 2);
  const oldButUpdated = pr(3, "2026-10-01T00:00:00Z", 1, "2026-11-06T10:00:00Z");
  const shared = commit("shared", 2);
  const firstPage = Array.from({ length: 100 }, (_, index) => commit(`c${index}`));
  const request: Graphql = query => {
    if (query.includes("pullRequests(")) {
      if (query.includes('after: "prs-next"')) return prs([second, pr(4, "2026-11-01T00:00:00Z", 1)], "do-not-fetch");
      if (query.includes('after: "do-not-fetch"')) throw new Error("Fetched beyond the update-time cutoff");
      return prs([oldButUpdated, pr(5, "2026-11-06T05:00:00Z", 1), first], "prs-next");
    }
    if (query.includes('after: "commits-next"')) return { repository: { p1: { commits: commits([shared], 101) } } };
    return { repository: { p1: { commits: commits(firstPage, 101, "commits-next") }, p2: { commits: commits([shared, commit("unique")]) } } };
  };
  const result = countRepository("example/repo", day, request);
  expect(result).toMatchObject({
    mergedPrs: 2,
    originalCommits: 102,
    commitOccurrences: 103,
    duplicateCommitOccurrences: 1,
    existingMergeCommits: 1,
    squashCommits: 2,
    withMergeCommits: 104,
    pullRequests: [
      { number: 1, commits: 101 },
      { number: 2, commits: 2 },
    ],
  });
  // The same SHA in a different repository is a separate history entry.
  expect(summarize([result, { ...result, repo: "example/fork" }])).toMatchObject({
    repositories: 2,
    originalCommits: 204,
    commitOccurrences: 206,
    duplicateCommitOccurrences: 2,
    withMergeCommits: 208,
  });
});

test("keeps empty repositories in totals without querying nonexistent PR commits", () => {
  const request: Graphql = query => {
    if (!query.includes("pullRequests(")) throw new Error("No PRs to fetch");
    return prs([]);
  };
  expect(summarize([countRepository("example/empty", day, request)])).toEqual({
    repositories: 1,
    mergedPrs: 0,
    originalCommits: 0,
    commitOccurrences: 0,
    duplicateCommitOccurrences: 0,
    existingMergeCommits: 0,
    squashCommits: 0,
    withMergeCommits: 0,
  });
});

test.each([
  [commits([commit("a")], 2), "incomplete commit list"],
  [commits([commit("a")], 1), "commit count changed"],
  [commits([commit("a"), commit("a")], 2), "incomplete commit list"],
])("rejects incomplete or changing commit lists rather than returning partial counts", (connection, message) => {
  const request: Graphql = query =>
    query.includes("pullRequests(") ? prs([pr(1, "2026-11-05T12:00:00Z", 2)]) : { repository: { p1: { commits: connection } } };
  expect(() => countRepository("example/repo", day, request)).toThrow(message);
});

test("inaccessible repositories and API failures do not become zero counts", () => {
  expect(() => countRepository("example/private", day, () => ({ repository: null }))).toThrow("not accessible");
  for (const missing of [{ repository: null }, { repository: { p1: null } }]) {
    const request: Graphql = query => (query.includes("pullRequests(") ? prs([pr(1, "2026-11-05T12:00:00Z", 1)]) : missing);
    expect(() => countRepository("example/repo", day, request)).toThrow("no commit list");
  }
  expect(() =>
    countRepository("example/repo", day, () => {
      throw new Error("rate limit");
    }),
  ).toThrow("rate limit");
});

test("recovers a PR updated ahead of the cursor while paging", () => {
  let firstPageReads = 0;
  const request: Graphql = query => {
    if (!query.includes("pullRequests(")) {
      return { repository: { p1: { commits: commits([commit("one")]) }, p2: { commits: commits([commit("two")]) } } };
    }
    if (query.includes('after: "next"')) return prs([pr(3, "2026-11-01T00:00:00Z", 1)]);
    firstPageReads++;
    return firstPageReads === 1
      ? prs([pr(1, "2026-11-05T12:00:00Z", 1)], "next")
      : prs([pr(2, "2026-11-05T10:00:00Z", 1, "2026-11-06T23:47:00Z"), pr(1, "2026-11-05T12:00:00Z", 1)]);
  };
  expect(countRepository("example/repo", day, request)).toMatchObject({
    mergedPrs: 2,
    originalCommits: 2,
    pullRequests: [{ number: 1 }, { number: 2 }],
  });
});

test.each([
  ["example/Matrix", 1, 2],
  ["example/app", 2, 3],
])("workspace-inclusive totals do not double-count a managed workspace: %s", (managedRepo, expectedRepos, expectedCommits) => {
  const request: Graphql = query => {
    const isWorkspace = /name: "matrix"/i.test(query);
    const count = isWorkspace ? 2 : 1;
    if (query.includes("pullRequests(")) return prs([pr(1, "2026-11-05T12:00:00Z", count)]);
    return { repository: { p1: { commits: commits(isWorkspace ? [commit("shared"), commit("workspace")] : [commit("shared")]) } } };
  };
  const result = buildReport([managedRepo], "example/matrix", day, request);
  expect(result.managed).toMatchObject({ repositories: 1, originalCommits: managedRepo === "example/app" ? 1 : 2 });
  expect(result.includingWorkspace).toMatchObject({
    repositories: expectedRepos,
    originalCommits: expectedCommits,
    mergedPrs: expectedRepos,
    withMergeCommits: expectedCommits + expectedRepos,
  });
});

test("the executable script finds its manifest and workspace identity from either invocation directory", () => {
  const root = path.resolve(import.meta.dir, "..");
  const caller = realpathSync(tempDir("other checkout"));
  const gh = path.join(caller, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = repo ]; then
  [ "$PWD" = "$EXPECTED_ROOT" ] && [ -z "$GH_REPO" ] && [ -z "$GIT_DIR" ] || exit 1
  echo fixture/workspace
else
  echo '{"data":{"repository":{"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}'
fi
`,
  );
  chmodSync(gh, 0o755);
  const nested = path.join(caller, "checkouts", "other");
  mkdirSync(nested, { recursive: true });
  for (const cwd of [root, nested]) {
    // Run it through its shebang, with this Bun first on PATH, so the executable bit is tested too.
    const script = `.${path.sep}${path.relative(cwd, path.join(root, "scripts/reports/mergedCommits.ts"))}`;
    const PATH = [caller, path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
    const report = JSON.parse(
      execFileSync(script, ["2020-01-01", "--timezone", "UTC"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH, EXPECTED_ROOT: root, GH_REPO: "fixture/other", GIT_DIR: nested },
      }),
    );
    expect(report.workspace).toBe("fixture/workspace");
    expect(report.repositories.map((entry: { repo: string }) => entry.repo)).toEqual([...loadManifest(root).repos, "fixture/workspace"]);
  }
});

test("the executable script reports errors on stderr with a failing exit status", () => {
  const script = path.resolve(import.meta.dir, "../scripts/reports/mergedCommits.ts");
  const PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
  const result = spawnSync(script, ["2026-02-30", "--timezone", "UTC"], { encoding: "utf8", env: { ...process.env, PATH } });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Invalid date '2026-02-30'");
});

test("a range selects each local date in it, never after the cutoff, and rejects reversed or future ranges", () => {
  const range = selectRange("2026-11-04", "2026-11-05", "America/New_York", now);
  expect(range.dateOf("2026-11-04T04:59:59Z")).toBeNull();
  expect(range.dateOf("2026-11-04T05:00:00Z")).toBe("2026-11-04");
  expect(range.dateOf("2026-11-05T04:59:59Z")).toBe("2026-11-04");
  expect(range.dateOf("2026-11-06T04:59:59Z")).toBe("2026-11-05");
  expect(range.dateOf("2026-11-06T05:00:00Z")).toBeNull();
  expect(range.updatedSince).toBe("2026-11-03T00:00:00.000Z");
  const today = selectRange("2026-11-06", "2026-11-06", "America/New_York", now);
  expect(today.dateOf(now.toISOString())).toBe("2026-11-06");
  expect(today.dateOf(new Date(now.getTime() + 1000).toISOString())).toBeNull();
  expect(() => selectRange("2026-11-05", "2026-11-04", "UTC", now)).toThrow("after the last date");
  expect(() => selectRange("2026-11-05", "2026-11-07", "UTC", now)).toThrow("future date");
});

/** A GitHub stub over fixed PRs and their commits, counting each kind of query. */
function fixture(pullRequests: PullRequest[], commitLists: Record<number, Commit[]>) {
  const calls = { pullRequests: 0, commits: 0 };
  const request: Graphql = query => {
    if (query.includes("pullRequests(")) {
      calls.pullRequests++;
      return prs(pullRequests);
    }
    calls.commits++;
    const fields = [...query.matchAll(/p(\d+): pullRequest/g)].map(([, number]) => Number(number));
    return { repository: Object.fromEntries(fields.map(number => [`p${number}`, { commits: commits(commitLists[number]!) }])) };
  };
  return { request, calls };
}

test("counts each local merge date once per repository and matches the single-day report", () => {
  const { request } = fixture(
    [
      pr(1, "2026-11-05T12:00:00Z", 2),
      // 22:00 on November 4th in New York.
      pr(2, "2026-11-05T03:00:00Z", 2),
      pr(3, "2026-11-04T12:00:00Z", 1),
      pr(4, "2026-11-06T06:00:00Z", 1),
      pr(5, "2026-11-03T12:00:00Z", 1),
    ],
    { 1: [commit("a"), commit("b")], 2: [commit("b"), commit("c")], 3: [commit("c")], 4: [commit("d")], 5: [commit("e")] },
  );
  const range = selectRange("2026-11-04", "2026-11-05", "America/New_York", now);
  expect(countDays("example/repo", range, request)).toEqual(
    new Map([
      ["2026-11-05", { pullRequests: 1, commits: 2 }],
      ["2026-11-04", { pullRequests: 2, commits: 2 }],
    ]),
  );
  for (const [date, commitsThatDay] of [
    ["2026-11-04", 2],
    ["2026-11-05", 2],
  ] as const) {
    expect(countRepository("example/repo", selectDay(date, "America/New_York", now), request).originalCommits).toBe(commitsThatDay);
  }
});

test("a range limited to some dates reads no commits of PRs merged on the others", () => {
  const queried: number[] = [];
  const { request } = fixture([pr(1, "2026-11-03T12:00:00Z", 1), pr(2, "2026-11-04T12:00:00Z", 1), pr(3, "2026-11-05T12:00:00Z", 1)], {
    1: [commit("a")],
    2: [commit("b")],
    3: [commit("c")],
  });
  const recording: Graphql = query => {
    queried.push(...[...query.matchAll(/p(\d+): pullRequest/g)].map(([, number]) => Number(number)));
    return request(query);
  };
  const range = onDates(selectRange("2026-11-03", "2026-11-05", "UTC", now), ["2026-11-03", "2026-11-05"]);
  expect([...countDays("example/repo", range, recording).keys()].sort()).toEqual(["2026-11-03", "2026-11-05"]);
  expect(queried.sort()).toEqual([1, 3]);
});

test("a range reads commits in batches across days, not one query per day", () => {
  const many = Array.from({ length: 25 }, (_, index) => pr(index + 1, `2026-10-${String(index + 1).padStart(2, "0")}T12:00:00Z`, 1));
  const { request, calls } = fixture(many, Object.fromEntries(many.map(entry => [entry.number, [commit(`c${entry.number}`)]])));
  const days = countDays("example/repo", selectRange("2026-10-01", "2026-11-05", "UTC", now), request);
  expect(days.size).toBe(25);
  expect(calls).toEqual({ pullRequests: 2, commits: 2 });
});

test("the workspace joins the managed repositories once", () => {
  expect(includingWorkspace(["example/app"], "example/matrix")).toEqual(["example/app", "example/matrix"]);
  expect(includingWorkspace(["example/Matrix"], "example/matrix")).toEqual(["example/Matrix"]);
});

describe("pull requests over GitHub's 250-commit list", () => {
  const big = pr(7, "2026-11-05T12:00:00Z", 300);
  const listed = Array.from({ length: 250 }, (_, index) => commit(`c${index}`));
  // GitHub lists 250 of the 300 commits, in pages of 100, and then reports no next page.
  const request: Graphql = query => {
    if (query.includes("pullRequests(")) return prs([big]);
    const page = query.includes('after: "200"') ? 2 : query.includes('after: "100"') ? 1 : 0;
    const nodes = listed.slice(page * 100, page * 100 + 100);
    return { repository: { p7: { commits: commits(nodes, 300, page < 2 ? String((page + 1) * 100) : null) } } };
  };

  test("count every commit from the comparison of the PR's base and head", () => {
    const calls: string[] = [];
    const compared: Compare = (repo, base, head) => {
      calls.push(`${repo} ${base}...${head}`);
      return Array.from({ length: 300 }, (_, index) => commit(`c${index}`, index === 299 ? 2 : 1));
    };
    expect(countRepository("example/repo", day, request, compared)).toMatchObject({ originalCommits: 300, existingMergeCommits: 1 });
    expect(calls).toEqual(["example/repo base7...head7"]);
  });

  test("still refuse a comparison that disagrees with the PR's count", () => {
    const short: Compare = () => listed.slice(0, 299 - 50);
    expect(() => countRepository("example/repo", day, request, short)).toThrow("incomplete commit list (249 of 300)");
  });

  test("page GitHub's comparison until it has every commit or a page comes back empty", SPAWNS, () => {
    const bin = tempDir("compare");
    const pages = (total: number) => {
      for (const [index, [from, count]] of [
        [0, 150],
        [150, 150],
        [300, 0],
      ].entries()) {
        writeFileSync(path.join(bin, `page-${index + 1}.json`), page(from!, count!, total));
      }
    };
    const page = (from: number, count: number, total: number) =>
      JSON.stringify({
        total_commits: total,
        commits: Array.from({ length: count }, (_, index) => ({ sha: `c${from + index}`, parents: from + index === 299 ? 2 : 1 })),
      });
    pages(300);
    // Records each call's arguments and answers with the page that `--jq` would leave.
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$2 $3" >> "${bin}/calls"\ncat "${bin}/page-\${2##*page=}.json"\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${original}`;
    try {
      expect(countRepository("example/repo", day, request)).toMatchObject({ originalCommits: 300, existingMergeCommits: 1 });
      expect(readFileSync(path.join(bin, "calls"), "utf8").trim().split("\n")).toEqual([
        "repos/example/repo/compare/base7...head7?per_page=100&page=1 --jq",
        "repos/example/repo/compare/base7...head7?per_page=100&page=2 --jq",
      ]);
      // A total GitHub overstates still ends at the first empty page.
      pages(400);
      writeFileSync(path.join(bin, "calls"), "");
      expect(countRepository("example/repo", day, request).originalCommits).toBe(300);
      expect(readFileSync(path.join(bin, "calls"), "utf8").trim().split("\n")).toHaveLength(3);
    } finally {
      process.env.PATH = original;
    }
  });

  test("do not compare when a PR within the limit comes back short", () => {
    const never: Compare = () => {
      throw new Error("compared");
    };
    const small: Graphql = query =>
      query.includes("pullRequests(") ? prs([pr(1, "2026-11-05T12:00:00Z", 2)]) : { repository: { p1: { commits: commits([commit("a")], 2) } } };
    expect(() => countRepository("example/repo", day, small, never)).toThrow("incomplete commit list (1 of 2)");
  });
});
