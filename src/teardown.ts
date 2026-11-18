// `matrix teardown`: agent-tool's `teardown` for the workspace and each checkout, so work across
// many repositories is not called done while it leaves processes running. Every repository is
// inspected with the workspace's own pinned agent-tool (`--repo <checkout>`), which behaves the
// same whatever a checkout pins.

import { object } from "./packageJson";
import { errorMessage } from "./text";

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
  /** The agent session's background `-c` shells still running (agent-tool 0.1.65+); never their arguments. */
  sessionShells?: Array<{ pid: number; ageSeconds: number; shell: string }>;
  notes?: string[];
}

interface RepoTeardown {
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
  /**
   * The agent session's background shells still running, listed once: every inspection runs
   * from this process, so each one sees the same session. Informational; they never fail
   * teardown and are never stopped, since a sibling may be another agent's live work.
   */
  readonly sessionShells: string[];
  readonly notes: string[];
}

/** Whether parsed JSON has the shape of agent-tool's teardown report, checked as far as matrix reads it. */
export function isAgentToolTeardown(value: unknown): value is AgentToolTeardown {
  const report = object(value);
  return (
    typeof report?.ok === "boolean" &&
    [report.leftover, report.kept, report.stopped, report.untracked, report.worktrees, report.unavailable, report.skipped].every(Array.isArray) &&
    // Optional, since agent-tool before 0.1.65 reports neither; when present, every entry must be readable.
    (report.sessionShells === undefined || (Array.isArray(report.sessionShells) && report.sessionShells.every(isSessionShell))) &&
    (report.notes === undefined || (Array.isArray(report.notes) && report.notes.every(note => typeof note === "string")))
  );
}

function isSessionShell(value: unknown): boolean {
  const shell = object(value);
  return Number.isInteger(shell?.pid) && typeof shell?.ageSeconds === "number" && Number.isFinite(shell.ageSeconds) && typeof shell.shell === "string";
}

const name = (item: { id: string; label: string | null }) => (item.label ? `${item.label} (${item.id})` : item.id);

function summarize(repo: string, path: string, report: AgentToolTeardown): RepoTeardown {
  return {
    repo,
    path,
    ok: report.ok,
    leftover: report.leftover.map(item => `${name(item)}${item.ports.length ? ` on ${item.ports.join(", ")}` : ""}`),
    listeners: report.untracked.filter(item => item.ports.length > 0).map(item => `pid ${item.pid} on ${item.ports.join(", ")}: ${item.command.slice(0, 120)}`),
    kept: report.kept.map(name),
    stopped: report.stopped.filter(item => item.stopped).map(item => item.id),
    worktrees: report.worktrees.map(item => (item.branch ? `${item.path} (${item.branch})` : item.path)),
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
export function teardownAll(
  targets: Array<{ repo: string; path: string }>,
  inspect: (path: string, apply: boolean) => AgentToolTeardown,
  apply: boolean,
): Teardown {
  // Each inspection sees the same session, so the latest successful one is the current picture;
  // merging them would keep shells that exited during the scan.
  let session: Pick<AgentToolTeardown, "sessionShells" | "notes"> = {};
  const repos = targets.map(({ repo, path }) => {
    try {
      const report = inspect(path, apply);
      const summary = summarize(repo, path, report);
      session = report;
      return summary;
    } catch (error) {
      return { repo, path, ok: false, leftover: [], listeners: [], kept: [], stopped: [], worktrees: [], problems: [errorMessage(error)] };
    }
  });
  return {
    ok: repos.every(item => item.ok),
    applied: apply,
    repos,
    sessionShells: [...(session.sessionShells ?? [])].sort((a, b) => a.pid - b.pid).map(describeShell),
    notes: [...new Set(session.notes ?? [])],
  };
}

/** One session shell as `pid <pid> <shell>, running <age>`; agent-tool never reports its arguments. */
function describeShell(shell: { pid: number; ageSeconds: number; shell: string }): string {
  const minutes = Math.floor(shell.ageSeconds / 60);
  const age = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `pid ${shell.pid} ${shell.shell}, running ${age}`;
}

/** Repositories still running something work left behind, for health. */
export function leftoverRepos(teardown: Teardown): string[] {
  return teardown.repos.filter(item => !item.ok).map(item => item.repo);
}
