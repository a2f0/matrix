import { runGh } from "../../../src/gh";
import type { Day } from "./day";

export interface PullRequest {
  number: number;
  url: string;
  mergedAt: string;
  updatedAt: string;
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
type CommitFields = Record<string, { commits: Commits } | null>;

const graphql: Graphql = query => {
  const response = JSON.parse(runGh(["api", "graphql", "-f", `query=${query}`])) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
  if (!response.data) throw new Error("GitHub returned no GraphQL data.");
  return response.data;
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

function scanPullRequests(repo: string, day: Day, cutoff: string, selected: Map<number, PullRequest>, request: Graphql) {
  let cursor: string | null = null;
  do {
    const data = request(
      repositoryQuery(
        repo,
        `pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: 100, after: ${JSON.stringify(cursor)}) {
      pageInfo {hasNextPage endCursor}
      nodes {number url mergedAt updatedAt commits {totalCount}}
    }`,
      ),
    );
    const repository = data.repository as { pullRequests: Connection<PullRequest> } | null;
    if (!repository) throw new Error(`GitHub repository '${repo}' is not accessible.`);
    const connection = repository.pullRequests;
    for (const pr of connection.nodes) if (day.contains(pr.mergedAt)) selected.set(pr.number, pr);
    // An old PR can have a recent update; never stop on mergedAt ordering.
    if (connection.nodes.some(pr => Date.parse(pr.updatedAt) <= Date.parse(cutoff))) break;
    cursor = nextCursor(connection);
  } while (cursor);
}

function mergedPullRequests(repo: string, day: Day, request: Graphql) {
  const selected = new Map<number, PullRequest>();
  scanPullRequests(repo, day, day.updatedSince, selected, request);
  // A comment or label change can move an unread PR ahead of our cursor.
  // Recover PRs updated since the report began, deduplicating by PR number.
  scanPullRequests(repo, day, day.asOf, selected, request);
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

function originalCommits(repo: string, prs: PullRequest[], request: Graphql) {
  const unique = new Map<string, Commit>();
  let occurrences = 0;
  // Bound GraphQL query size, independently of the number of PRs in the day.
  for (let offset = 0; offset < prs.length; offset += 20) {
    const batch = prs.slice(offset, offset + 20);
    const data = request(repositoryQuery(repo, batch.map(pr => commitField(pr.number)).join("\n")));
    for (const pr of batch) {
      const commits = readCommits(repo, pr, prCommits(data, pr), request);
      occurrences += commits.length;
      for (const commit of commits) unique.set(commit.oid, commit);
    }
  }
  return { unique, occurrences };
}

function readCommits(repo: string, pr: PullRequest, connection: Commits, request: Graphql) {
  const commits = new Map<string, Commit>();
  while (true) {
    if (connection.totalCount !== pr.commits.totalCount) throw new Error(`${pr.url}: commit count changed during the report; run again.`);
    for (const { commit } of connection.nodes) commits.set(commit.oid, commit);
    const cursor = nextCursor(connection);
    if (!cursor) break;
    connection = prCommits(request(repositoryQuery(repo, commitField(pr.number, cursor))), pr);
  }
  if (commits.size !== pr.commits.totalCount) {
    throw new Error(`${pr.url}: incomplete commit list (${commits.size} of ${pr.commits.totalCount}); cannot compute a complete count.`);
  }
  return [...commits.values()];
}

export function countRepository(repo: string, day: Day, request: Graphql = graphql) {
  const prs = mergedPullRequests(repo, day, request);
  const { unique, occurrences } = originalCommits(repo, prs, request);
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

export function buildReport(repos: string[], workspace: string, day: Day, request: Graphql = graphql) {
  const managed = repos.map(repo => countRepository(repo, day, request));
  const repositories = managed.some(repo => repo.repo.toLowerCase() === workspace.toLowerCase())
    ? managed
    : [...managed, countRepository(workspace, day, request)];
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
