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
import { applyMachine, machineItems } from "./machine";
import { busyRoots, type Proc, processes } from "./processes";
import { resolveTargets } from "./targets";

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
  let procs: Proc[];
  try {
    procs = discover();
  } catch (error) {
    if (!options.includeBusy) throw error;
    procs = [];
  }
  const busy = busyRoots(
    procs,
    targets.map(target => target.root),
  );

  const repos: RepoReport[] = targets.map(target => {
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
  });
  const machine = options.machine ? machineItems(procs) : [];

  // A repository that could not be scanned was not cleaned: report it as a failure.
  let failures = repos.filter(repo => repo.error).length;
  if (options.apply) {
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
      repo.removed = [];
      repo.failed = [];
      for (const candidate of selected(repo.candidates, options.tiers)) {
        // Re-check at removal time: the tree may have changed since the scan.
        const reason = unsafeReason(repo.root, candidate.path);
        if (reason) {
          if (reason !== "missing") repo.failed.push({ path: candidate.path, error: reason });
          continue;
        }
        try {
          rmSync(path.join(repo.root, candidate.path), { recursive: true, force: true });
          repo.removed.push(candidate.path);
        } catch (error) {
          repo.failed.push({ path: candidate.path, error: (error as Error).message });
        }
      }
      failures += repo.failed.length;
    }
    // --include-busy covers repositories only: package caches and DerivedData always wait for installs and builds.
    failures += applyMachine(machine, discover);
  }
  const after = options.apply ? free(volume) : undefined;

  const totals: Record<Tier, number> = { caches: 0, builds: 0, deps: 0 };
  for (const tier of TIERS) for (const repo of repos) totals[tier] += tierBytes(repo.candidates, tier);
  if (options.json) {
    console.log(
      JSON.stringify(
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
      ),
    );
    return failures > 0 ? 1 : 0;
  }

  const lines = [`Space cleanup ${options.apply ? "(applied)" : "(dry run)"}: ${size(before)} free${workspace ? ` in matrix workspace ${workspace}` : ""}`];
  for (const repo of repos) {
    const chosen = selected(repo.candidates, options.tiers);
    const status = repo.error
      ? ` error: ${repo.error}`
      : repo.busy && !options.includeBusy
        ? ` skipped, busy: ${repo.busy
            .slice(0, 3)
            .map(proc => `${proc.name} ${proc.pid}`)
            .join(", ")}${repo.busy.length > 3 ? ", ..." : ""}`
        : "";
    const perTier = TIERS.map(tier => `${tier} ${size(tierBytes(repo.candidates, tier))}`).join(", ");
    lines.push(`\n${repo.name}${status}\n  ${perTier}`);
    for (const candidate of chosen.toSorted((a, b) => b.bytes - a.bytes).slice(0, 8))
      lines.push(
        `  ${options.apply && repo.removed?.includes(candidate.path) ? "removed" : candidate.tier.padEnd(7)} ${size(candidate.bytes).padStart(10)}  ${candidate.path}`,
      );
    if (chosen.length > 8) lines.push(`  ... and ${chosen.length - 8} more`);
    for (const failure of repo.failed ?? []) lines.push(`  FAILED ${failure.path}: ${failure.error}`);
  }
  if (options.machine) {
    lines.push("\nmachine");
    for (const item of machine) {
      const state = item.reportOnly ? "review" : item.skipped ? `skipped (${item.skipped})` : (item.result ?? (options.apply ? "" : "would clean"));
      lines.push(`  ${size(item.bytes).padStart(10)}  ${item.description}: ${state}`);
    }
  }
  lines.push(
    `\nTotals: caches ${size(totals.caches)}, builds ${size(totals.builds)}${options.tiers.has("builds") ? "" : " (--builds)"}, deps ${size(totals.deps)}${options.tiers.has("deps") ? "" : " (--deps)"}`,
  );
  if (after !== undefined) lines.push(`Free: ${size(before)} -> ${size(after)}`);
  else lines.push("Nothing changed; rerun with --apply to remove the listed tiers.");
  console.log(lines.join("\n"));
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
