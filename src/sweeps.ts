import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { type CheckoutStatus, notReady } from "./checkouts";
import { findRepo } from "./manifest";
import {
  appendUpdate, type EntryUpdate, EVENT_KINDS, type EventKind, loadEntries, loadEntry, loadSweep, type RepoEntry, report,
  STATUSES, type StoredUpdate, type Sweep, type SweepEvent, type SweepReport, sweepDirectory, VERDICTS, writeJson,
} from "./sweepLedger";

const CAUSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/;
const ISSUE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*$/;

const TEXT_FIELDS = ["reason", "validation", "reviewer", "deploy", "cleanup"] as const;
const OID_FIELDS = ["base", "head", "merge"] as const;

export function oneOf<T extends string>(values: readonly T[], value: string, field: string): T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`--${field} must be one of ${values.join(", ")}.`);
  return value as T;
}

export function text(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`--${field} must not be empty.`);
  return trimmed;
}

/** Parse `cause` or `cause:detail`. */
export function parseEvent(kind: EventKind, value: string): Omit<SweepEvent, "at"> {
  const colon = value.indexOf(":");
  const cause = (colon === -1 ? value : value.slice(0, colon)).trim();
  if (!CAUSE.test(cause)) throw new Error(`--${kind} needs a kebab-case cause such as 'enospc' or 'enospc:detail', not '${value}'.`);
  const detail = colon === -1 ? "" : value.slice(colon + 1).trim();
  return detail ? { kind, cause, detail } : { kind, cause };
}

/** Validate `sweep record` options into an update. */
export function parseUpdate(values: Record<string, string>, lists: Record<string, string[]>): EntryUpdate {
  const update: EntryUpdate = {};
  if (values.status !== undefined) update.status = oneOf(STATUSES, values.status, "status");
  if (values.verdict !== undefined) update.verdict = oneOf(VERDICTS, values.verdict.toUpperCase(), "verdict");
  for (const field of TEXT_FIELDS) if (values[field] !== undefined) update[field] = text(values[field], field);
  for (const field of OID_FIELDS) {
    const value = values[field];
    if (value !== undefined && !OID.test(value)) throw new Error(`--${field} must be a full commit ID.`);
    if (value !== undefined) update[field] = value;
  }
  if (values.pr !== undefined && !PULL_REQUEST.test(values.pr)) throw new Error("--pr must be a GitHub pull request URL.");
  if (values.pr !== undefined) update.pr = values.pr;
  if (lists.note) update.notes = lists.note.map(note => text(note, "note"));
  const events = EVENT_KINDS.flatMap(kind => (lists[kind] ?? []).map(value => parseEvent(kind, value)));
  if (events.length > 0) update.events = events;
  return update;
}

export interface StartOptions { topic?: string; issue?: string }

/**
 * Create a ledger for a sweep branch. Ready checkouts start `pending` at their
 * current commit; the rest are `skipped` with the reason, as sweep step 1 requires.
 */
export function startSweep(root: string, branch: string, selected: string[], statusOf: (repo: string) => CheckoutStatus, options: StartOptions = {}, now = new Date()): SweepReport {
  // Naming one repository twice, as owner/name and as a checkout name, must not count it twice.
  const seen = new Set<string>();
  const repos = selected.filter(repo => !seen.has(repo.toLowerCase()) && seen.add(repo.toLowerCase()));
  if (repos.length === 0) throw new Error("A sweep needs at least one repository.");
  if (options.issue !== undefined && !ISSUE.test(options.issue)) throw new Error("--issue must be owner/repo#number.");
  const topic = options.topic === undefined ? undefined : text(options.topic, "topic");
  const directory = sweepDirectory(root, branch);
  const at = now.toISOString();
  const sweep: Sweep = { schemaVersion: 1, branch, ...(topic !== undefined && { topic }), ...(options.issue !== undefined && { issue: options.issue }), startedAt: at, repos };
  const initial = repos.map((repo): StoredUpdate => {
    const status = statusOf(repo);
    const reason = notReady(status);
    const install = status.agentTool;
    const notes = install && !install.current
      ? [`node_modules holds agent-tool ${install.installed ?? "none"}, pinned ${install.pinned}; run the checkout's install before its scripts`]
      : [];
    return reason === undefined
      ? { at, status: "pending", ...(status.head && { base: status.head }), notes }
      : { at, status: "skipped", reason, notes };
  });
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`A sweep ledger already exists at ${directory}; use sweep record or sweep report, or choose a branch name that differs by more than case.`);
    throw error;
  }
  try {
    repos.forEach((repo, index) => appendUpdate(directory, repo, initial[index]!));
    // Written last: list and report treat a directory without sweep.json as absent.
    writeJson(path.join(directory, "sweep.json"), sweep);
  } catch (error) {
    // This call created the directory, so a failed start leaves nothing behind to block a retry.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return report(sweep, loadEntries(directory, sweep));
}

function resolveRepo(sweep: Sweep, name: string): string {
  const repo = findRepo(sweep.repos, name);
  if (!repo) throw new Error(`'${name}' is not part of sweep '${sweep.branch}'.`);
  return repo;
}

/** Record an update to one repository's entry and return the entry it produces. */
export function recordEntry(root: string, branch: string, name: string, update: EntryUpdate, now = new Date()): RepoEntry {
  const { directory, sweep } = loadSweep(root, branch);
  const repo = resolveRepo(sweep, name);
  appendUpdate(directory, repo, { ...update, at: now.toISOString() });
  return loadEntry(directory, repo);
}

export function sweepReport(root: string, branch: string): SweepReport {
  const { directory, sweep } = loadSweep(root, branch);
  return report(sweep, loadEntries(directory, sweep));
}


function cell(value: string | undefined): string { return (value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(); }

function pullLink(url: string | undefined): string {
  const match = url && /github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)$/.exec(url);
  return match ? `[${match[1]}#${match[2]}](${url})` : "";
}

/** A ledger table for a tracking issue or PR body. It holds only what the ledger holds, never logs. */
export function markdownReport(result: SweepReport): string {
  const { sweep } = result;
  const counts = STATUSES.filter(status => result.counts[status]).map(status => `${status} ${result.counts[status]}`).join(", ");
  const lines = [
    `Sweep \`${sweep.branch}\`${sweep.topic ? `: ${cell(sweep.topic)}` : ""}`,
    "",
    `${counts}${result.remaining.length > 0 ? `; remaining: ${result.remaining.join(", ")}` : ""}`,
    "",
    "| Repository | Status | PR | Review | Detail | Friction |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of result.repos) {
    const review = entry.verdict ? `${entry.verdict}${entry.reviewer ? ` (${entry.reviewer})` : ""}` : "";
    const detail = [entry.reason, entry.validation, entry.deploy, entry.cleanup, ...entry.notes].filter(Boolean).join("; ");
    const friction = entry.events.map(event => `${event.kind} ${event.cause}`).join(", ");
    lines.push(`| ${entry.repo} | ${entry.status} | ${pullLink(entry.pr)} | ${cell(review)} | ${cell(detail)} | ${cell(friction)} |`);
  }
  return `${lines.join("\n")}\n`;
}
