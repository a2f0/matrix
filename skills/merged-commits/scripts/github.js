import { runGh } from "../../../src/gh";

/** @typedef {ReturnType<typeof import('./day.js').selectDay>} Day */
/** @typedef {{number: number, url: string, mergedAt: string, updatedAt: string, commits: {totalCount: number}}} PullRequest */
/** @typedef {{oid: string, parents: {totalCount: number}}} Commit */
/** @template T @typedef {{nodes: T[], pageInfo: {hasNextPage: boolean, endCursor: string | null}}} Connection */
/** @typedef {Connection<{commit: Commit}> & {totalCount: number}} Commits */
/** @typedef {(query: string) => Record<string, unknown>} Graphql */

/** @type {Graphql} */
function graphql(query) {
  const response = JSON.parse(runGh(["api", "graphql", "-f", `query=${query}`]));
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${JSON.stringify(response.errors)}`);
  if (!response.data) throw new Error("GitHub returned no GraphQL data.");
  return response.data;
}

/** @param {string} repo @param {string} fields */
function repositoryQuery(repo, fields) {
  const [owner, name] = repo.split("/");
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
}

/** @template T @param {Connection<T>} connection */
function nextCursor(connection) {
  if (!connection.pageInfo.hasNextPage) return null;
  if (!connection.pageInfo.endCursor) throw new Error("GitHub returned an incomplete pagination cursor.");
  return connection.pageInfo.endCursor;
}

/** @param {string} repo @param {Day} day @param {string} cutoff @param {Map<number, PullRequest>} selected @param {Graphql} request */
function scanPullRequests(repo, day, cutoff, selected, request) {
  /** @type {string | null} */
  let cursor = null;
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
    const repository = /** @type {{pullRequests: Connection<PullRequest>} | null} */ (data.repository);
    if (!repository) throw new Error(`GitHub repository '${repo}' is not accessible.`);
    const connection = repository.pullRequests;
    for (const pr of connection.nodes) if (day.contains(pr.mergedAt)) selected.set(pr.number, pr);
    // An old PR can have a recent update; never stop on mergedAt ordering.
    if (connection.nodes.some(pr => Date.parse(pr.updatedAt) <= Date.parse(cutoff))) break;
    cursor = nextCursor(connection);
  } while (cursor);
}

/** @param {string} repo @param {Day} day @param {Graphql} request */
function mergedPullRequests(repo, day, request) {
  /** @type {Map<number, PullRequest>} */
  const selected = new Map();
  scanPullRequests(repo, day, day.updatedSince, selected, request);
  // A comment or label change can move an unread PR ahead of our cursor.
  // Recover PRs updated since the report began, deduplicating by PR number.
  scanPullRequests(repo, day, day.asOf, selected, request);
  return [...selected.values()].sort((a, b) => a.number - b.number);
}

/** @param {number} number @param {string | null} [cursor] */
function commitField(number, cursor = null) {
  return `p${number}: pullRequest(number: ${number}) { commits(first: 100, after: ${JSON.stringify(cursor)}) {
    totalCount pageInfo {hasNextPage endCursor} nodes {commit {oid parents {totalCount}}}
  } }`;
}

/** @param {string} repo @param {PullRequest[]} prs @param {Graphql} request */
function originalCommits(repo, prs, request) {
  /** @type {Map<string, Commit>} */
  const unique = new Map();
  let occurrences = 0;
  // Bound GraphQL query size, independently of the number of PRs in the day.
  for (let offset = 0; offset < prs.length; offset += 20) {
    const batch = prs.slice(offset, offset + 20);
    const data = request(repositoryQuery(repo, batch.map(pr => commitField(pr.number)).join("\n")));
    const repository = /** @type {Record<string, {commits: Commits}>} */ (data.repository);
    for (const pr of batch) {
      const commits = readCommits(repo, pr, repository[`p${pr.number}`].commits, request);
      occurrences += commits.length;
      for (const commit of commits) unique.set(commit.oid, commit);
    }
  }
  return { unique, occurrences };
}

/** @param {string} repo @param {PullRequest} pr @param {Commits} connection @param {Graphql} request */
function readCommits(repo, pr, connection, request) {
  /** @type {Map<string, Commit>} */
  const commits = new Map();
  while (true) {
    if (connection.totalCount !== pr.commits.totalCount) throw new Error(`${pr.url}: commit count changed during the report; run again.`);
    for (const { commit } of connection.nodes) commits.set(commit.oid, commit);
    const cursor = nextCursor(connection);
    if (!cursor) break;
    const data = request(repositoryQuery(repo, commitField(pr.number, cursor)));
    const repository = /** @type {Record<string, {commits: Commits}>} */ (data.repository);
    connection = repository[`p${pr.number}`].commits;
  }
  if (commits.size !== pr.commits.totalCount) {
    throw new Error(`${pr.url}: incomplete commit list (${commits.size} of ${pr.commits.totalCount}); cannot compute a complete count.`);
  }
  return [...commits.values()];
}

/** @param {string} repo @param {Day} day @param {Graphql} [request] */
export function countRepository(repo, day, request = graphql) {
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

/** @param {ReturnType<typeof countRepository>[]} repositories */
export function summarize(repositories) {
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

/** @param {string[]} repos @param {string} workspace @param {Day} day @param {Graphql} [request] */
export function buildReport(repos, workspace, day, request = graphql) {
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
