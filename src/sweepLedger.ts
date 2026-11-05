// Sweep ledgers on disk: where they live, how updates are appended and replayed, and how a
// ledger reads back as a report. Parsing options and summarizing friction build on this.
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, gitOutput } from "./git";
import { repoName } from "./manifest";
import { object } from "./packageJson";
import { errorMessage } from "./text";

export const STATUSES = ["pending", "skipped", "unchanged", "in-progress", "open", "merged", "blocked", "failed"] as const;
export type SweepStatus = (typeof STATUSES)[number];
/** Statuses that still need work. `open` is final when a request stops at open PRs, so retro lists it separately. */
export const REMAINING: readonly SweepStatus[] = ["pending", "in-progress", "blocked"];

/** Friction worth learning from: a step rerun, a substitute tool or reviewer, a declined finding, or a person's help. */
export const EVENT_KINDS = ["retry", "fallback", "declined", "manual"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const VERDICTS = ["BLOCKER", "MAJOR", "MINOR", "SUGGESTION", "CLEAN"] as const;
export type Verdict = (typeof VERDICTS)[number];

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

/** Ledgers live in the Git common directory, beside agent-tool's run receipts, so they are never committed. */
export function sweepsDirectory(root: string): string {
  return path.join(gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "matrix", "sweeps");
}

function checkBranch(root: string, branch: string): void {
  if (branch.startsWith("-") || git(root, ["check-ref-format", `refs/heads/${branch}`]).status !== 0) {
    throw new Error(`'${branch}' is not a valid branch name.`);
  }
}

export function sweepDirectory(root: string, branch: string): string {
  checkBranch(root, branch);
  // encodeURIComponent is injective, so distinct branch names never share a directory.
  return path.join(sweepsDirectory(root), encodeURIComponent(branch));
}

/** One repository's numbered update files. */
function entryDirectory(directory: string, repo: string): string {
  return path.join(directory, "repos", repoName(repo));
}

/** Read a ledger file, checking the fields that locate and order its records. */
export function readJson<T>(file: string, valid: (value: unknown) => value is T): T {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${file}: ${errorMessage(error)}`);
  }
  if (!valid(value)) throw new Error(`Could not read ${file}: it is not a sweep ledger record.`);
  return value;
}

function isSweep(value: unknown): value is Sweep {
  const sweep = object(value);
  return (
    typeof sweep?.branch === "string" &&
    typeof sweep.startedAt === "string" &&
    Array.isArray(sweep.repos) &&
    sweep.repos.every(repo => typeof repo === "string")
  );
}

function isStoredUpdate(value: unknown): value is StoredUpdate {
  return typeof object(value)?.at === "string";
}

/** Write JSON to a new private file in `folder`, to publish under its final name. */
function writeTemporary(folder: string, value: unknown): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return temporary;
}

/** Write through a rename so a reader never sees a partial file. */
export function writeJson(file: string, value: unknown): void {
  renameSync(writeTemporary(path.dirname(file), value), file);
}

/** An update as stored: the fields it sets, the notes and events it adds, and when. */
export type StoredUpdate = EntryUpdate & { readonly at: string };

const UPDATE = /^([0-9]+)\.json$/;

/** Update files in append order. */
function updateFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter(name => UPDATE.test(name))
    .sort((left, right) => Number(UPDATE.exec(left)![1]) - Number(UPDATE.exec(right)![1]));
}

/**
 * Append an update as the next numbered file; recording never rewrites an earlier one.
 * A hard link publishes the complete file only if its number is still free, so
 * concurrent writers each take a distinct number and replay follows append order.
 */
export function appendUpdate(directory: string, repo: string, update: StoredUpdate): void {
  const folder = entryDirectory(directory, repo);
  const temporary = writeTemporary(folder, update);
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

/** Replay a repository's updates in append order. A different status without a reason clears the old reason. */
export function loadEntry(directory: string, repo: string): RepoEntry {
  const folder = entryDirectory(directory, repo);
  const updates = updateFiles(folder).map(name => readJson(path.join(folder, name), isStoredUpdate));
  let entry: RepoEntry = { repo, status: "pending", notes: [], events: [], updatedAt: "" };
  for (const { at, notes = [], events = [], ...fields } of updates) {
    const next: { -readonly [Field in keyof RepoEntry]: RepoEntry[Field] } = {
      ...entry,
      ...fields,
      notes: [...entry.notes, ...notes],
      events: [...entry.events, ...events.map(event => ({ ...event, at }))],
      updatedAt: at,
    };
    if (fields.status !== undefined && fields.status !== entry.status && fields.reason === undefined) delete next.reason;
    entry = next;
  }
  return entry;
}

export function loadSweep(root: string, branch: string): { directory: string; sweep: Sweep } {
  const directory = sweepDirectory(root, branch);
  const file = path.join(directory, "sweep.json");
  if (!existsSync(file)) throw new Error(`No sweep ledger for '${branch}'; run sweep start.`);
  const sweep = readJson(file, isSweep);
  if (sweep.schemaVersion !== 1) throw new Error(`${file} has unsupported schemaVersion ${String(sweep.schemaVersion)}.`);
  // Case-insensitive filesystems, such as macOS's default, map chore/Fix and chore/fix to one directory.
  if (sweep.branch !== branch) throw new Error(`The ledger at ${directory} belongs to '${sweep.branch}', not '${branch}'.`);
  return { directory, sweep };
}

export function loadEntries(directory: string, sweep: Sweep): RepoEntry[] {
  return sweep.repos.map(repo => loadEntry(directory, repo));
}

export function report(sweep: Sweep, entries: RepoEntry[]): SweepReport {
  const counts: Partial<Record<SweepStatus, number>> = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  // ISO timestamps sort as text, so the last one is the latest.
  const updatedAt = [sweep.startedAt, ...entries.map(entry => entry.updatedAt)].sort().at(-1)!;
  return {
    sweep,
    updatedAt,
    counts,
    remaining: entries.filter(entry => REMAINING.includes(entry.status)).map(entry => entry.repo),
    events: entries.reduce((total, entry) => total + entry.events.length, 0),
    repos: entries,
  };
}

/** Every recorded sweep, newest first. */
export function listSweeps(root: string): SweepReport[] {
  const directory = sweepsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => path.join(directory, name))
    .filter(folder => existsSync(path.join(folder, "sweep.json")))
    .map(folder => {
      const sweep = readJson(path.join(folder, "sweep.json"), isSweep);
      return report(sweep, loadEntries(folder, sweep));
    })
    .sort((left, right) => right.sweep.startedAt.localeCompare(left.sweep.startedAt) || left.sweep.branch.localeCompare(right.sweep.branch));
}
