#!/usr/bin/env bun
/**
 * Dry-run-first disk cleanup for one repository, a matrix workspace and its
 * checkouts, and optionally this machine's developer caches.
 *
 * In a repository it removes only paths that git reports as ignored and
 * untracked, whose names mark them as regenerable output, that are not
 * symlinks or nested repositories, in repositories no other process is
 * working in. It never runs `git clean`, never touches tracked or untracked
 * (unignored) files, and never deletes clones.
 *
 * Uses only Node built-ins so it runs by path from any repository.
 */
import { rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { type Candidate, findCandidates, measure, selected, TIERS, type Tier, unsafeReason } from "./candidates";
import { applyMachine, type MachineItem, machineItems } from "./machine";
import { busyRoots, type Proc, processes } from "./processes";
import { resolveTargets, type Target } from "./targets";

interface RepoReport {
  readonly name: string;
  readonly root: string;
  busy?: Array<{ pid: number; name: string; cwd: string }>;
  error?: string;
  candidates: Candidate[];
  removed?: string[];
  failed?: Array<{ path: string; error: string }>;
}

export interface Options {
  readonly names: string[];
  readonly tiers: Set<Tier>;
  readonly apply: boolean;
  readonly json: boolean;
  readonly machine: boolean;
  readonly includeBusy: boolean;
}

const USAGE = `Usage: space-cleanup [checkout-or-path...] [--builds] [--deps] [--machine] [--include-busy] [--apply] [--json]

Reports regenerable, git-ignored, untracked paths and removes them with --apply.
From a matrix workspace it covers the workspace and every checkout, or the
named checkouts; elsewhere, the repository holding the working directory.

  (default)        caches: .turbo, coverage, test reports, node_modules/.cache, ...
  --builds         also build outputs: dist, build, out, .next, .gradle, target, *.tsbuildinfo, ...
  --deps           also installed dependencies: node_modules, .venv, Pods, vendor/bundle
  --machine        also developer caches outside repositories (DerivedData, brew, bun, npm)
  --include-busy   clean repositories other processes are working in
  --apply          remove what the report lists; without it nothing changes
  --json           JSON output for agents`;

export function parseOptions(argv: string[]): Options {
  const names: string[] = [];
  const tiers = new Set<Tier>(["caches"]);
  let apply = false,
    json = false,
    machine = false,
    includeBusy = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--machine") machine = true;
    else if (arg === "--include-busy") includeBusy = true;
    else if (arg === "--builds") tiers.add("builds");
    else if (arg === "--deps") tiers.add("deps");
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }
  return { names, tiers, apply, json, machine, includeBusy };
}

function size(bytes: number | undefined): string {
  if (bytes === undefined) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

/** Bytes one tier would free, counting a nested path once with its parent. */
function tierBytes(candidates: Candidate[], tier: Tier): number {
  return selected(candidates, new Set([tier])).reduce((sum, candidate) => sum + candidate.bytes, 0);
}

/** The busy processes reported for a repository; undefined when there are none. */
function workersOf(procs: Proc[] | undefined): RepoReport["busy"] {
  return procs?.map(({ pid, name, cwd }) => ({ pid, name, cwd: cwd! }));
}

function free(directory: string): number {
  const stats = statfsSync(directory);
  return stats.bavail * stats.bsize;
}

export function main(argv: string[], cwd = process.cwd(), discover: () => Proc[] = processes): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const options = parseOptions(argv);
  const { workspace, targets } = resolveTargets(cwd, options.names);
  const volume = workspace ?? targets[0]?.root ?? cwd;
  const before = free(volume);
  const procs = listProcesses(discover, options.includeBusy);
  const busy = busyRoots(
    procs,
    targets.map(target => target.root),
  );

  const repos: RepoReport[] = targets.map(target => scanRepo(target, busy));
  const machine = options.machine ? machineItems(procs) : [];

  // A repository that could not be scanned was not cleaned: report it as a failure.
  let failures = repos.filter(repo => repo.error).length;
  if (options.apply) {
    failures += cleanRepos(repos, targets, options, discover);
    // --include-busy covers repositories only: package caches and DerivedData always wait for installs and builds.
    failures += applyMachine(machine, discover);
  }
  const after = options.apply ? free(volume) : undefined;

  const totals: Record<Tier, number> = { caches: 0, builds: 0, deps: 0 };
  for (const tier of TIERS) for (const repo of repos) totals[tier] += tierBytes(repo.candidates, tier);
  const report: Report = { options, workspace, before, after, totals, repos, machine };
  console.log(options.json ? jsonReport(report) : textReport(report));
  return failures > 0 ? 1 : 0;
}

/** Everything one run found and did, as both reports print it. */
interface Report {
  readonly options: Options;
  readonly workspace: string | undefined;
  readonly before: number;
  readonly after: number | undefined;
  readonly totals: Record<Tier, number>;
  readonly repos: RepoReport[];
  readonly machine: MachineItem[];
}

/** The process list; with --include-busy a failure to list them counts as no processes. */
function listProcesses(discover: () => Proc[], includeBusy: boolean): Proc[] {
  try {
    return discover();
  } catch (error) {
    if (!includeBusy) throw error;
    return [];
  }
}

/** One repository's candidates, each sized, and the processes working in it. */
function scanRepo(target: Target, busy: Map<string, Proc[]>): RepoReport {
  const report: RepoReport = { ...target, candidates: [] };
  report.busy = workersOf(busy.get(target.root));
  try {
    report.candidates = findCandidates(target.root);
  } catch (error) {
    report.error = (error as Error).message;
  }
  // du counts a directory once per call, so a nested cache measured alongside its parent
  // would read as empty: measure outer paths and nested ones in separate calls.
  const nested = (candidate: Candidate) => report.candidates.some(other => candidate.path.startsWith(`${other.path}/`));
  for (const group of [report.candidates.filter(candidate => !nested(candidate)), report.candidates.filter(nested)]) {
    const sizes = measure(group.map(candidate => path.join(target.root, candidate.path)));
    for (const candidate of group) candidate.bytes = sizes.get(path.join(target.root, candidate.path)) ?? 0;
  }
  return report;
}

/** Removes the chosen tiers from every scanned repository that is not busy; returns the number of failed removals. */
function cleanRepos(repos: RepoReport[], targets: Target[], options: Options, discover: () => Proc[]): number {
  let failures = 0;
  for (const repo of repos) {
    if (repo.error) continue;
    // Scans and earlier removals take a while; judge each repository from a fresh process list.
    if (!options.includeBusy) {
      repo.busy = workersOf(
        busyRoots(
          discover(),
          targets.map(target => target.root),
        ).get(repo.root),
      );
      if (repo.busy) continue;
    }
    failures += removeCandidates(repo, options.tiers);
  }
  return failures;
}

/** Removes one repository's chosen candidates, rechecking each first; returns the number that failed. */
function removeCandidates(repo: RepoReport, tiers: Set<Tier>): number {
  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  repo.removed = removed;
  repo.failed = failed;
  for (const candidate of selected(repo.candidates, tiers)) {
    // Re-check at removal time: the tree may have changed since the scan.
    const reason = unsafeReason(repo.root, candidate.path);
    if (reason) {
      if (reason !== "missing") failed.push({ path: candidate.path, error: reason });
      continue;
    }
    try {
      rmSync(path.join(repo.root, candidate.path), { recursive: true, force: true });
      removed.push(candidate.path);
    } catch (error) {
      failed.push({ path: candidate.path, error: (error as Error).message });
    }
  }
  return failed.length;
}

function jsonReport({ options, workspace, before, after, totals, repos, machine }: Report): string {
  return JSON.stringify(
    {
      applied: options.apply,
      workspace: workspace ?? null,
      tiers: [...options.tiers],
      free: { before, ...(after !== undefined && { after }) },
      totals,
      repos: repos.map(repo => ({ ...repo, skipped: repo.busy && !options.includeBusy ? "busy" : undefined })),
      ...(options.machine && { machine: machine.map(({ apply: _apply, ...item }) => item) }),
    },
    null,
    2,
  );
}

function textReport({ options, workspace, before, after, totals, repos, machine }: Report): string {
  const lines = [`Space cleanup ${options.apply ? "(applied)" : "(dry run)"}: ${size(before)} free${workspace ? ` in matrix workspace ${workspace}` : ""}`];
  for (const repo of repos) lines.push(...repoLines(repo, options));
  if (options.machine) {
    lines.push("\nmachine");
    for (const item of machine) lines.push(`  ${size(item.bytes).padStart(10)}  ${item.description}: ${machineState(item, options.apply)}`);
  }
  lines.push(
    `\nTotals: caches ${size(totals.caches)}, builds ${size(totals.builds)}${options.tiers.has("builds") ? "" : " (--builds)"}, deps ${size(totals.deps)}${options.tiers.has("deps") ? "" : " (--deps)"}`,
  );
  if (after !== undefined) lines.push(`Free: ${size(before)} -> ${size(after)}`);
  else lines.push("Nothing changed; rerun with --apply to remove the listed tiers.");
  return lines.join("\n");
}

/** One repository's section: its status, per-tier sizes, largest chosen paths, and failures. */
function repoLines(repo: RepoReport, options: Options): string[] {
  const chosen = selected(repo.candidates, options.tiers);
  const perTier = TIERS.map(tier => `${tier} ${size(tierBytes(repo.candidates, tier))}`).join(", ");
  const lines = [`\n${repo.name}${repoStatus(repo, options.includeBusy)}\n  ${perTier}`];
  for (const candidate of chosen.toSorted((a, b) => b.bytes - a.bytes).slice(0, 8))
    lines.push(
      `  ${options.apply && repo.removed?.includes(candidate.path) ? "removed" : candidate.tier.padEnd(7)} ${size(candidate.bytes).padStart(10)}  ${candidate.path}`,
    );
  if (chosen.length > 8) lines.push(`  ... and ${chosen.length - 8} more`);
  for (const failure of repo.failed ?? []) lines.push(`  FAILED ${failure.path}: ${failure.error}`);
  return lines;
}

function repoStatus(repo: RepoReport, includeBusy: boolean): string {
  if (repo.error) return ` error: ${repo.error}`;
  if (!repo.busy || includeBusy) return "";
  const shown = repo.busy
    .slice(0, 3)
    .map(proc => `${proc.name} ${proc.pid}`)
    .join(", ");
  return ` skipped, busy: ${shown}${repo.busy.length > 3 ? ", ..." : ""}`;
}

function machineState(item: MachineItem, apply: boolean): string {
  if (item.reportOnly) return "review";
  if (item.skipped) return `skipped (${item.skipped})`;
  return item.result ?? (apply ? "" : "would clean");
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
