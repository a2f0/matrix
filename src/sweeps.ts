import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckoutStatus } from "./checkouts";
import { git, gitOutput } from "./git";
import { repoName } from "./manifest";

export const STATUSES = ["pending", "skipped", "unchanged", "in-progress", "open", "merged", "blocked", "failed"] as const;
export type SweepStatus = (typeof STATUSES)[number];
/** Statuses that still need work. `open` is final when a request stops at open PRs, so retro lists it separately. */
const REMAINING: readonly SweepStatus[] = ["pending", "in-progress", "blocked"];

/** Friction worth learning from: a step rerun, a substitute tool or reviewer, a declined finding, or a person's help. */
export const EVENT_KINDS = ["retry", "fallback", "declined", "manual"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const VERDICTS = ["BLOCKER", "MAJOR", "MINOR", "SUGGESTION", "CLEAN"] as const;
export type Verdict = (typeof VERDICTS)[number];

const CAUSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/;
const ISSUE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*$/;

export interface Sweep {
  readonly schemaVersion: 1;
  readonly branch: string;
  readonly topic?: string;
  /** Tracking issue as owner/repo#number, when the request asked for one. */
  readonly issue?: string;
  readonly startedAt: string;
  readonly repos: string[];
}

export interface SweepEvent {
  readonly kind: EventKind;
  /** A short kebab-case cause, such as `enospc`, that retro groups across repositories and sweeps. */
  readonly cause: string;
  readonly detail?: string;
  readonly at: string;
}

export interface RepoEntry {
  readonly repo: string;
  readonly status: SweepStatus;
  readonly reason?: string;
  readonly base?: string;
  readonly head?: string;
  readonly pr?: string;
  readonly merge?: string;
  readonly validation?: string;
  readonly reviewer?: string;
  readonly verdict?: Verdict;
  readonly deploy?: string;
  readonly cleanup?: string;
  readonly notes: string[];
  readonly events: SweepEvent[];
  readonly updatedAt: string;
}

const TEXT_FIELDS = ["reason", "validation", "reviewer", "deploy", "cleanup"] as const;
const OID_FIELDS = ["base", "head", "merge"] as const;

export interface EntryUpdate {
  status?: SweepStatus;
  reason?: string;
  base?: string;
  head?: string;
  pr?: string;
  merge?: string;
  validation?: string;
  reviewer?: string;
  verdict?: Verdict;
  deploy?: string;
  cleanup?: string;
  notes?: string[];
  events?: Array<Omit<SweepEvent, "at">>;
}

export interface SweepReport {
  readonly sweep: Sweep;
  readonly updatedAt: string;
  readonly counts: Partial<Record<SweepStatus, number>>;
  /** Repositories still pending, in progress, or blocked. */
  readonly remaining: string[];
  readonly events: number;
  readonly repos: RepoEntry[];
}

function oneOf<T extends string>(values: readonly T[], value: string, field: string): T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`--${field} must be one of ${values.join(", ")}.`);
  return value as T;
}

function text(value: string, field: string): string {
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

/** Ledgers live in the Git common directory, beside agent-tool's run receipts, so they are never committed. */
export function sweepsDirectory(root: string): string {
  return path.join(gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "matrix", "sweeps");
}

function checkBranch(root: string, branch: string): void {
  if (branch.startsWith("-") || git(root, ["check-ref-format", `refs/heads/${branch}`]).status !== 0) {
    throw new Error(`'${branch}' is not a valid branch name.`);
  }
}

function sweepDirectory(root: string, branch: string): string {
  checkBranch(root, branch);
  // encodeURIComponent is injective, so distinct branch names never share a directory.
  return path.join(sweepsDirectory(root), encodeURIComponent(branch));
}

/** One repository's numbered update files. */
function entryDirectory(directory: string, repo: string): string { return path.join(directory, "repos", repoName(repo)); }

function readJson<T>(file: string): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch (error) {
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Write through a rename so a reader never sees a partial file. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** An update as stored: the fields it sets, the notes and events it adds, and when. */
type StoredUpdate = EntryUpdate & { readonly at: string };

const UPDATE = /^([0-9]+)\.json$/;

/** Update files in append order. */
function updateFiles(folder: string): string[] {
  return readdirSync(folder).filter(name => UPDATE.test(name)).sort((left, right) => Number(UPDATE.exec(left)![1]) - Number(UPDATE.exec(right)![1]));
}

/**
 * Append an update as the next numbered file; recording never rewrites an earlier one.
 * A hard link publishes the complete file only if its number is still free, so
 * concurrent writers each take a distinct number and replay follows append order.
 */
function appendUpdate(directory: string, repo: string, update: StoredUpdate): void {
  const folder = entryDirectory(directory, repo);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(update, null, 2)}\n`, { mode: 0o600 });
  try {
    for (let sequence = updateFiles(folder).length + 1; ; sequence++) {
      try {
        linkSync(temporary, path.join(folder, `${String(sequence).padStart(6, "0")}.json`));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Replay a repository's updates in append order. A new status without a reason clears the old reason. */
function loadEntry(directory: string, repo: string): RepoEntry {
  const folder = entryDirectory(directory, repo);
  const updates = updateFiles(folder).map(name => readJson<StoredUpdate>(path.join(folder, name)));
  let entry: Record<string, unknown> = { repo, status: "pending", notes: [], events: [], updatedAt: "" };
  for (const update of updates) {
    const { at, notes = [], events = [], ...fields } = update;
    const previous = entry;
    entry = { ...previous, ...fields };
    if (fields.status !== undefined && fields.reason === undefined) delete entry.reason;
    entry.notes = [...(previous.notes as string[]), ...notes];
    entry.events = [...(previous.events as SweepEvent[]), ...events.map(event => ({ ...event, at }))];
    entry.updatedAt = at;
  }
  return entry as unknown as RepoEntry;
}

function loadSweep(root: string, branch: string): { directory: string; sweep: Sweep } {
  const directory = sweepDirectory(root, branch);
  const file = path.join(directory, "sweep.json");
  if (!existsSync(file)) throw new Error(`No sweep ledger for '${branch}'; run sweep start.`);
  const sweep = readJson<Sweep>(file);
  if (sweep.schemaVersion !== 1) throw new Error(`${file} has unsupported schemaVersion ${String(sweep.schemaVersion)}.`);
  // Case-insensitive filesystems, such as macOS's default, map chore/Fix and chore/fix to one directory.
  if (sweep.branch !== branch) throw new Error(`The ledger at ${directory} belongs to '${sweep.branch}', not '${branch}'.`);
  return { directory, sweep };
}

function loadEntries(directory: string, sweep: Sweep): RepoEntry[] {
  return sweep.repos.map(repo => loadEntry(directory, repo));
}

function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? "" : "s"}`; }

/** Why a checkout cannot join a sweep yet, or undefined when it is ready. */
export function notReady(status: CheckoutStatus): string | undefined {
  if (status.error) return status.error;
  if (!status.present) return "checkout missing; run sync";
  if (status.branch === null) return "detached HEAD";
  if (status.branch !== status.defaultBranch) return `on branch ${status.branch}`;
  if (status.changes) return plural(status.changes, "local change");
  if (status.ahead) return plural(status.ahead, "unpushed commit");
  if (status.behind) return `${plural(status.behind, "commit")} behind origin; run sync`;
  return undefined;
}

function report(sweep: Sweep, entries: RepoEntry[]): SweepReport {
  const counts: Partial<Record<SweepStatus, number>> = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const updatedAt = entries.map(entry => entry.updatedAt).reduce((latest, at) => (at > latest ? at : latest), sweep.startedAt);
  return {
    sweep,
    updatedAt,
    counts,
    remaining: entries.filter(entry => REMAINING.includes(entry.status)).map(entry => entry.repo),
    events: entries.reduce((total, entry) => total + entry.events.length, 0),
    repos: entries,
  };
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
  const key = name.toLowerCase();
  const repo = sweep.repos.find(candidate => candidate.toLowerCase() === key || repoName(candidate).toLowerCase() === key);
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

/** Every recorded sweep, newest first. */
export function listSweeps(root: string): SweepReport[] {
  const directory = sweepsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => path.join(directory, name))
    .filter(folder => existsSync(path.join(folder, "sweep.json")))
    .map(folder => {
      const sweep = readJson<Sweep>(path.join(folder, "sweep.json"));
      return report(sweep, loadEntries(folder, sweep));
    })
    .sort((left, right) => right.sweep.startedAt.localeCompare(left.sweep.startedAt) || left.sweep.branch.localeCompare(right.sweep.branch));
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

export interface RetroOptions {
  branches?: string[];
  /** Newest sweeps to read when no branches are named. */
  last?: number;
  /** A cause recurs when it reaches this many repositories... */
  minRepos?: number;
  /** ...or this many sweeps. */
  minSweeps?: number;
}

export interface Recurrence {
  readonly kind: EventKind;
  readonly cause: string;
  readonly occurrences: number;
  readonly repos: string[];
  readonly sweeps: string[];
  readonly details: string[];
}

export interface Retro {
  readonly sweeps: string[];
  /** Causes that recur across repositories or sweeps: each needs a lesson, fix, or recorded decision. */
  readonly recurring: Recurrence[];
  readonly isolated: Recurrence[];
  readonly reviews: { verdicts: Partial<Record<Verdict, number>>; reviewers: Record<string, number> };
  /** Entries left pending, in progress, blocked, or with an open PR. */
  readonly unfinished: Array<{ branch: string; repo: string; status: SweepStatus; reason?: string; pr?: string }>;
}

/** Group friction across sweeps so recurring causes surface as lesson candidates. */
export function retro(root: string, options: RetroOptions = {}): Retro {
  const { branches = [], last = 5, minRepos = 2, minSweeps = 2 } = options;
  const reports = branches.length > 0 ? branches.map(branch => sweepReport(root, branch)) : listSweeps(root).slice(0, last);
  const groups = new Map<string, { kind: EventKind; cause: string; occurrences: number; repos: Set<string>; sweeps: Set<string>; details: string[] }>();
  const verdicts: Partial<Record<Verdict, number>> = {};
  const reviewers: Record<string, number> = {};
  const unfinished: Retro["unfinished"] = [];
  for (const { sweep, repos } of reports) {
    for (const entry of repos) {
      for (const event of entry.events) {
        const key = `${event.kind}:${event.cause}`;
        const group = groups.get(key) ?? { kind: event.kind, cause: event.cause, occurrences: 0, repos: new Set(), sweeps: new Set(), details: [] };
        group.occurrences++;
        group.repos.add(entry.repo);
        group.sweeps.add(sweep.branch);
        if (event.detail) group.details.push(`${sweep.branch} ${entry.repo}: ${event.detail}`);
        groups.set(key, group);
      }
      if (entry.verdict) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
      if (entry.reviewer) reviewers[entry.reviewer] = (reviewers[entry.reviewer] ?? 0) + 1;
      if (REMAINING.includes(entry.status) || entry.status === "open") {
        unfinished.push({ branch: sweep.branch, repo: entry.repo, status: entry.status, ...(entry.reason && { reason: entry.reason }), ...(entry.pr && { pr: entry.pr }) });
      }
    }
  }
  const recurrences = [...groups.values()]
    .map(group => ({ kind: group.kind, cause: group.cause, occurrences: group.occurrences, repos: [...group.repos].sort(), sweeps: [...group.sweeps].sort(), details: group.details }))
    .sort((left, right) => right.occurrences - left.occurrences || `${left.kind}:${left.cause}`.localeCompare(`${right.kind}:${right.cause}`));
  const recurs = (group: Recurrence) => group.repos.length >= minRepos || group.sweeps.length >= minSweeps;
  return {
    sweeps: reports.map(({ sweep }) => sweep.branch),
    recurring: recurrences.filter(recurs),
    isolated: recurrences.filter(group => !recurs(group)),
    reviews: { verdicts, reviewers },
    unfinished,
  };
}
