import { runGh } from "../../../src/gh";
import { loadManifest } from "../../../src/manifest";
import type { Day, Window } from "./day";

export interface PullRequest {
  number: number;
  url: string;
  mergedAt: string;
  updatedAt: string;
  baseRefOid: string;
  headRefOid: string;
  commits: { totalCount: number };
}
export interface Commit {
  oid: string;
  parents: { totalCount: number };
}
interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export type Commits = Connection<{ commit: Commit }> & { totalCount: number };
export type Graphql = (query: string) => Record<string, unknown>;
/** Every commit reachable from `head` but not from its merge base with `base`. */
export type Compare = (repo: string, base: string, head: string) => Commit[];
type CommitFields = Record<string, { commits: Commits } | null>;
export interface DayCount {
  pullRequests: number;
  commits: number;
}

const graphql: Graphql = query => {
  const response = JSON.parse(runGh(["api", "graphql", "-f", `query=${query}`])) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
  if (!response.data) throw new Error("GitHub returned no GraphQL data.");
  return response.data;
};

/** GitHub lists at most this many commits for a pull request, in GraphQL and REST alike. */
const PULL_REQUEST_COMMIT_LIMIT = 250;

const compare: Compare = (repo, base, head) => {
  const commits: Commit[] = [];
  // Unlike a pull request's own list, a comparison pages past 250 commits. Its
  // response also carries every file's diff, so keep only the commit fields.
  for (let page = 1; ; page++) {
    const url = `repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`;
    const fields = "{total_commits, commits: [.commits[] | {sha, parents: (.parents | length)}]}";
    const response = JSON.parse(runGh(["api", url, "--jq", fields])) as {
      total_commits: number;
      commits: { sha: string; parents: number }[];
    };
    commits.push(...response.commits.map(commit => ({ oid: commit.sha, parents: { totalCount: commit.parents } })));
    if (response.commits.length === 0 || commits.length >= response.total_commits) return commits;
  }
};

function repositoryQuery(repo: string, fields: string) {
  const [owner, name] = repo.split("/");
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
}

function nextCursor<T>(connection: Connection<T>) {
  if (!connection.pageInfo.hasNextPage) return null;
  if (!connection.pageInfo.endCursor) throw new Error("GitHub returned an incomplete pagination cursor.");
  return connection.pageInfo.endCursor;
}

function scanPullRequests(repo: string, window: Window, cutoff: string, selected: Map<number, PullRequest>, request: Graphql) {
  let cursor: string | null = null;
  do {
    const data = request(
      repositoryQuery(
        repo,
        `pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 100, after: ${JSON.stringify(cursor)}) {
      pageInfo {hasNextPage endCursor}
      nodes {number url mergedAt updatedAt baseRefOid headRefOid commits {totalCount}}
    }`,
      ),
    );
    const repository = data.repository as { pullRequests: Connection<PullRequest> } | null;
    if (!repository) throw new Error(`GitHub repository '${repo}' is not accessible.`);
    const connection = repository.pullRequests;
    for (const pr of connection.nodes) if (window.dateOf(pr.mergedAt)) selected.set(pr.number, pr);
    // An old PR can have a recent update; never stop on mergedAt ordering.
    if (connection.nodes.some(pr => Date.parse(pr.updatedAt) <= Date.parse(cutoff))) break;
    cursor = nextCursor(connection);
  } while (cursor);
}

function mergedPullRequests(repo: string, window: Window, request: Graphql) {
  const selected = new Map<number, PullRequest>();
  scanPullRequests(repo, window, window.updatedSince, selected, request);
  // A comment or label change can move an unread PR ahead of our cursor.
  // Recover PRs updated since the report began, deduplicating by PR number.
  scanPullRequests(repo, window, window.asOf, selected, request);
  return [...selected.values()].sort((a, b) => a.number - b.number);
}

function commitField(number: number, cursor: string | null = null) {
  return `p${number}: pullRequest(number: ${number}) { commits(first: 100, after: ${JSON.stringify(cursor)}) {
    totalCount pageInfo {hasNextPage endCursor} nodes {commit {oid parents {totalCount}}}
  } }`;
}

/** The PR's commit connection from a commitField response, or a clear error when GitHub omits it. */
function prCommits(data: Record<string, unknown>, pr: PullRequest) {
  const commits = (data.repository as CommitFields | null)?.[`p${pr.number}`]?.commits;
  if (!commits) throw new Error(`${pr.url}: GitHub returned no commit list; cannot compute a complete count.`);
  return commits;
}

/** Every original commit of each PR, by PR number. */
function pullRequestCommits(repo: string, prs: PullRequest[], request: Graphql, compareRefs: Compare) {
  const commits = new Map<number, Commit[]>();
  // Bound GraphQL query size, independently of the number of PRs selected.
  for (let offset = 0; offset < prs.length; offset += 20) {
    const batch = prs.slice(offset, offset + 20);
    const data = request(repositoryQuery(repo, batch.map(pr => commitField(pr.number)).join("\n")));
    for (const pr of batch) commits.set(pr.number, readCommits(repo, pr, prCommits(data, pr), request, compareRefs));
  }
  return commits;
}

function listedCommits(repo: string, pr: PullRequest, connection: Commits, request: Graphql) {
  const commits = new Map<string, Commit>();
  while (true) {
    if (connection.totalCount !== pr.commits.totalCount) throw new Error(`${pr.url}: commit count changed during the report; run again.`);
    for (const { commit } of connection.nodes) commits.set(commit.oid, commit);
    const cursor = nextCursor(connection);
    if (!cursor) return commits;
    connection = prCommits(request(repositoryQuery(repo, commitField(pr.number, cursor))), pr);
  }
}

function readCommits(repo: string, pr: PullRequest, connection: Commits, request: Graphql, compareRefs: Compare) {
  let commits = listedCommits(repo, pr, connection, request);
  if (commits.size < pr.commits.totalCount && pr.commits.totalCount > PULL_REQUEST_COMMIT_LIMIT) {
    commits = new Map(compareRefs(repo, pr.baseRefOid, pr.headRefOid).map(commit => [commit.oid, commit]));
  }
  if (commits.size !== pr.commits.totalCount) {
    throw new Error(`${pr.url}: incomplete commit list (${commits.size} of ${pr.commits.totalCount}); cannot compute a complete count.`);
  }
  return [...commits.values()];
}

export function countRepository(repo: string, day: Day, request: Graphql = graphql, compareRefs: Compare = compare) {
  const prs = mergedPullRequests(repo, day, request);
  const commits = [...pullRequestCommits(repo, prs, request, compareRefs).values()].flat();
  const unique = new Map(commits.map(commit => [commit.oid, commit]));
  const occurrences = commits.length;
  return {
    repo,
    mergedPrs: prs.length,
    originalCommits: unique.size,
    commitOccurrences: occurrences,
    duplicateCommitOccurrences: occurrences - unique.size,
    existingMergeCommits: [...unique.values()].filter(commit => commit.parents.totalCount > 1).length,
    squashCommits: prs.length,
    withMergeCommits: unique.size + prs.length,
    pullRequests: prs.map(pr => ({ number: pr.number, url: pr.url, mergedAt: pr.mergedAt, commits: pr.commits.totalCount })),
  };
}

/**
 * Merged PRs and distinct original commits for each local date in `window`
 * that has any. Like countRepository, a commit counts once per day it merged.
 */
export function countDays(repo: string, window: Window, request: Graphql = graphql, compareRefs: Compare = compare): Map<string, DayCount> {
  const prs = mergedPullRequests(repo, window, request);
  const commits = pullRequestCommits(repo, prs, request, compareRefs);
  const days = new Map<string, { pullRequests: number; oids: Set<string> }>();
  for (const pr of prs) {
    const date = window.dateOf(pr.mergedAt)!;
    const day = days.get(date) ?? { pullRequests: 0, oids: new Set<string>() };
    day.pullRequests++;
    for (const commit of commits.get(pr.number)!) day.oids.add(commit.oid);
    days.set(date, day);
  }
  return new Map([...days].map(([date, day]) => [date, { pullRequests: day.pullRequests, commits: day.oids.size }]));
}

/** The managed repositories, plus this workspace when it is not one of them. */
export function includingWorkspace(repos: string[], workspace: string): string[] {
  return repos.some(repo => repo.toLowerCase() === workspace.toLowerCase()) ? repos : [...repos, workspace];
}

/** The repositories matrix.json manages and the workspace's own GitHub identity. */
export function matrixScope(root: string): { repos: string[]; workspace: string } {
  const { repos } = loadManifest(root);
  const workspace = runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root).trim();
  return { repos, workspace };
}

export function summarize(repositories: ReturnType<typeof countRepository>[]) {
  return repositories.reduce(
    (total, repo) => ({
      repositories: total.repositories + 1,
      mergedPrs: total.mergedPrs + repo.mergedPrs,
      originalCommits: total.originalCommits + repo.originalCommits,
      commitOccurrences: total.commitOccurrences + repo.commitOccurrences,
      duplicateCommitOccurrences: total.duplicateCommitOccurrences + repo.duplicateCommitOccurrences,
      existingMergeCommits: total.existingMergeCommits + repo.existingMergeCommits,
      squashCommits: total.squashCommits + repo.squashCommits,
      withMergeCommits: total.withMergeCommits + repo.withMergeCommits,
    }),
    {
      repositories: 0,
      mergedPrs: 0,
      originalCommits: 0,
      commitOccurrences: 0,
      duplicateCommitOccurrences: 0,
      existingMergeCommits: 0,
      squashCommits: 0,
      withMergeCommits: 0,
    },
  );
}

export function buildReport(repos: string[], workspace: string, day: Day, request: Graphql = graphql, compareRefs: Compare = compare) {
  const managed = repos.map(repo => countRepository(repo, day, request, compareRefs));
  const extra = includingWorkspace(repos, workspace).slice(repos.length);
  const repositories = [...managed, ...extra.map(repo => countRepository(repo, day, request, compareRefs))];
  return {
    date: day.date,
    timeZone: day.timeZone,
    asOf: day.asOf,
    workspace,
    managed: summarize(managed),
    includingWorkspace: summarize(repositories),
    repositories,
  };
}
