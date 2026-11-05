import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { object } from "./packageJson";
import { EVENT_KINDS, type EventKind, listSweeps, REMAINING, readJson, type SweepStatus, sweepsDirectory, type Verdict, writeJson } from "./sweepLedger";
import { oneOf, PULL_REQUEST, parseEvent, sweepReport, text } from "./sweeps";

/** Resolutions sit beside the ledgers, since one can close a cause seen across many sweeps. */
function resolutionsDirectory(root: string): string {
  return path.join(path.dirname(sweepsDirectory(root)), "resolutions");
}

function isResolution(value: unknown): value is Resolution {
  const resolution = object(value);
  return ["kind", "cause", "resolution", "at"].every(field => typeof resolution?.[field] === "string");
}

/** How a recurring cause was resolved: a fix, guidance, or a recorded decision. */
export interface Resolution {
  readonly kind: EventKind;
  readonly cause: string;
  readonly resolution: string;
  readonly pr?: string;
  readonly at: string;
}

/** Record that a cause was resolved; retro stops listing it as recurring until it happens again. */
export function recordResolution(root: string, kind: string, cause: string, resolution: string, pr?: string, now = new Date()): Resolution {
  const event = parseEvent(oneOf(EVENT_KINDS, kind, "kind"), cause);
  if (event.detail !== undefined) throw new Error(`Name the cause alone, such as '${event.cause}', without a detail.`);
  if (pr !== undefined && !PULL_REQUEST.test(pr)) throw new Error("--pr must be a GitHub pull request URL.");
  const value: Resolution = {
    kind: event.kind,
    cause: event.cause,
    resolution: text(resolution, "resolution"),
    ...(pr !== undefined && { pr }),
    at: now.toISOString(),
  };
  // A unique file per resolution, so concurrent writers never overwrite each other.
  writeJson(path.join(resolutionsDirectory(root), `${now.getTime()}-${randomUUID()}.json`), value);
  return value;
}

/** Every recorded resolution, oldest first. */
function listResolutions(root: string): Resolution[] {
  const directory = resolutionsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .map(name => readJson(path.join(directory, name), isResolution))
    .sort((left, right) => left.at.localeCompare(right.at));
}

/** Causes earlier ledgers used, by kind, so a new spelling of an old cause can be caught. */
export function knownCauses(root: string): Map<EventKind, Set<string>> {
  const known = new Map<EventKind, Set<string>>();
  for (const { repos } of listSweeps(root)) {
    for (const event of repos.flatMap(entry => entry.events)) {
      const causes = known.get(event.kind) ?? new Set<string>();
      causes.add(event.cause);
      known.set(event.kind, causes);
    }
  }
  return known;
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
  /** When it last happened. */
  readonly lastSeen: string;
  /** The newest resolution recorded after it last happened. */
  readonly resolution?: Resolution;
}

export interface Retro {
  readonly sweeps: string[];
  /** Causes that recur across repositories or sweeps and have no resolution since: each needs a lesson, fix, or recorded decision. */
  readonly recurring: Recurrence[];
  /** Recurring causes resolved after they last happened. */
  readonly resolved: Recurrence[];
  readonly isolated: Recurrence[];
  readonly reviews: { verdicts: Partial<Record<Verdict, number>>; reviewers: Record<string, number> };
  /** Entries left pending, in progress, blocked, or with an open PR. */
  readonly unfinished: Array<{ branch: string; repo: string; status: SweepStatus; reason?: string; pr?: string }>;
}

/** Group friction across sweeps so recurring causes surface as lesson candidates. */
export function retro(root: string, options: RetroOptions = {}): Retro {
  const { branches = [], last = 5, minRepos = 2, minSweeps = 2 } = options;
  const reports = branches.length > 0 ? branches.map(branch => sweepReport(root, branch)) : listSweeps(root).slice(0, last);
  const groups = new Map<
    string,
    { kind: EventKind; cause: string; occurrences: number; repos: Set<string>; sweeps: Set<string>; details: string[]; lastSeen: string }
  >();
  const verdicts: Partial<Record<Verdict, number>> = {};
  const reviewers: Record<string, number> = {};
  const unfinished: Retro["unfinished"] = [];
  for (const { sweep, repos } of reports) {
    for (const entry of repos) {
      for (const event of entry.events) {
        const key = `${event.kind}:${event.cause}`;
        const group = groups.get(key) ?? {
          kind: event.kind,
          cause: event.cause,
          occurrences: 0,
          repos: new Set(),
          sweeps: new Set(),
          details: [],
          lastSeen: event.at,
        };
        group.occurrences++;
        if (event.at > group.lastSeen) group.lastSeen = event.at;
        group.repos.add(entry.repo);
        group.sweeps.add(sweep.branch);
        if (event.detail) group.details.push(`${sweep.branch} ${entry.repo}: ${event.detail}`);
        groups.set(key, group);
      }
      if (entry.verdict) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
      if (entry.reviewer) reviewers[entry.reviewer] = (reviewers[entry.reviewer] ?? 0) + 1;
      if (REMAINING.includes(entry.status) || entry.status === "open") {
        unfinished.push({
          branch: sweep.branch,
          repo: entry.repo,
          status: entry.status,
          ...(entry.reason && { reason: entry.reason }),
          ...(entry.pr && { pr: entry.pr }),
        });
      }
    }
  }
  const resolutions = listResolutions(root);
  const recurrences: Recurrence[] = [...groups.values()]
    .map(group => {
      const resolution = resolutions.filter(entry => entry.kind === group.kind && entry.cause === group.cause && entry.at > group.lastSeen).at(-1);
      return {
        kind: group.kind,
        cause: group.cause,
        occurrences: group.occurrences,
        repos: [...group.repos].sort(),
        sweeps: [...group.sweeps].sort(),
        details: group.details,
        lastSeen: group.lastSeen,
        ...(resolution && { resolution }),
      };
    })
    .sort((left, right) => right.occurrences - left.occurrences || `${left.kind}:${left.cause}`.localeCompare(`${right.kind}:${right.cause}`));
  const recurs = (group: Recurrence) => group.repos.length >= minRepos || group.sweeps.length >= minSweeps;
  return {
    sweeps: reports.map(({ sweep }) => sweep.branch),
    recurring: recurrences.filter(group => recurs(group) && !group.resolution),
    resolved: recurrences.filter(group => recurs(group) && group.resolution),
    isolated: recurrences.filter(group => !recurs(group)),
    reviews: { verdicts, reviewers },
    unfinished,
  };
}
