import { expect, test } from "bun:test";
import { selectDay } from "../skills/merged-commits/scripts/day.js";
import { type Commit, type Commits, countRepository, type Graphql, type PullRequest, summarize } from "../skills/merged-commits/scripts/github.js";

const now = new Date("2026-11-06T23:46:10Z");
const day = selectDay("yesterday", "America/New_York", now);

function pr(number: number, mergedAt: string, count: number, updatedAt = mergedAt): PullRequest {
  return { number, url: `https://github.com/example/repo/pull/${number}`, mergedAt, updatedAt, commits: { totalCount: count } };
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
  expect(() =>
    countRepository("example/repo", day, () => {
      throw new Error("rate limit");
    }),
  ).toThrow("rate limit");
});
