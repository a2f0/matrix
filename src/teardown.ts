// `matrix teardown`: agent-tool's `teardown` for the workspace and each checkout, so work across
// many repositories is not called done while it leaves processes running. Every repository is
// inspected with the workspace's own pinned agent-tool (`--repo <checkout>`), which behaves the
// same whatever a checkout pins.

/** What agent-tool's `teardown` reports for one repository; only the fields matrix reads. */
export interface AgentToolTeardown {
  ok: boolean;
  leftover: Array<{ id: string; label: string | null; ports: string[] }>;
  kept: Array<{ id: string; label: string | null }>;
  stopped: Array<{ id: string; stopped: boolean }>;
  untracked: Array<{ pid: number; command: string; ports: string[] }>;
  worktrees: Array<{ path: string; branch: string | null }>;
  unavailable: string[];
  skipped: Array<{ file: string }>;
}

export interface RepoTeardown {
  readonly repo: string;
  readonly path: string;
  readonly ok: boolean;
  /** Recorded processes still running that were not started with --keep. */
  readonly leftover: string[];
  /** Untracked processes inside the repository that listen on a port. */
  readonly listeners: string[];
  readonly kept: string[];
  readonly stopped: string[];
  readonly worktrees: string[];
  readonly problems: string[];
}

export interface Teardown {
  readonly ok: boolean;
  readonly applied: boolean;
  readonly repos: RepoTeardown[];
}

const name = (item: { id: string; label: string | null }) => item.label ? `${item.label} (${item.id})` : item.id;

export function summarize(repo: string, path: string, report: AgentToolTeardown): RepoTeardown {
  return {
    repo,
    path,
    ok: report.ok,
    leftover: report.leftover.map(item => `${name(item)}${item.ports.length ? ` on ${item.ports.join(", ")}` : ""}`),
    listeners: report.untracked.filter(item => item.ports.length > 0).map(item => `pid ${item.pid} on ${item.ports.join(", ")}: ${item.command.slice(0, 120)}`),
    kept: report.kept.map(name),
    stopped: report.stopped.filter(item => item.stopped).map(item => item.id),
    worktrees: report.worktrees.map(item => item.branch ? `${item.path} (${item.branch})` : item.path),
    problems: [
      ...report.stopped.filter(item => !item.stopped).map(item => `could not stop ${item.id}`),
      ...report.unavailable.map(item => `could not inspect ${item}`),
      ...report.skipped.map(item => `unreadable record ${item.file}`),
    ],
  };
}

/**
 * Tears down each target, in order. A repository whose inspection fails is reported as not ok
 * with the error, and the rest are still inspected.
 */
export function teardownAll(targets: Array<{ repo: string; path: string }>, inspect: (path: string, apply: boolean) => AgentToolTeardown, apply: boolean): Teardown {
  const repos = targets.map(({ repo, path }) => {
    try { return summarize(repo, path, inspect(path, apply)); }
    catch (error) {
      return { repo, path, ok: false, leftover: [], listeners: [], kept: [], stopped: [], worktrees: [], problems: [(error as Error).message] };
    }
  });
  return { ok: repos.every(item => item.ok), applied: apply, repos };
}

/** Repositories still running something work left behind, for health. */
export function leftoverRepos(teardown: Teardown): string[] {
  return teardown.repos.filter(item => !item.ok).map(item => item.repo);
}
