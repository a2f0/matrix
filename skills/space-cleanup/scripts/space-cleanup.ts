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
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TIERS = ["caches", "builds", "deps"] as const;
export type Tier = (typeof TIERS)[number];

/** Tool and test caches: rebuilt on the next run at little cost. */
const CACHE_NAMES = new Set([
  ".turbo", ".parcel-cache", ".eslintcache", ".stylelintcache", "coverage", ".nyc_output",
  "test-results", "playwright-report", "blob-report",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);
/** Build outputs: rebuilt by the repository's build, which can take minutes. */
const BUILD_NAMES = new Set(["dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".expo", ".gradle", ".build", "DerivedData"]);
/** Installed dependencies: restored by the repository's documented install. */
const DEPS_NAMES = new Set(["node_modules", ".venv"]);
/** Regenerable children of ignored directories that are themselves kept by a lighter tier. */
const NESTED: Record<string, Array<[string, Tier]>> = {
  node_modules: [[".cache", "caches"], [".vite", "caches"]],
  ".next": [["cache", "caches"]],
  // .wrangler/state holds local D1, KV, and R2 data; only tmp is disposable.
  ".wrangler": [["tmp", "caches"]],
  vendor: [["bundle", "deps"]],
};

/** The tier a git-ignored path belongs to, or undefined when it is not known to be regenerable. */
export function classify(rel: string, root: string): Tier | undefined {
  const name = path.posix.basename(rel);
  const parent = path.join(root, path.posix.dirname(rel));
  if (CACHE_NAMES.has(name)) return "caches";
  // Small, but deleting one makes the next typecheck start from scratch.
  if (BUILD_NAMES.has(name) || name.endsWith(".tsbuildinfo")) return "builds";
  if (name === "target" && existsSync(path.join(parent, "Cargo.toml"))) return "builds";
  if (DEPS_NAMES.has(name)) return "deps";
  if (name === "Pods" && existsSync(path.join(parent, "Podfile"))) return "deps";
  return undefined;
}

/** Ignored paths from `git status --porcelain=v1 -z --ignored`, without trailing slashes. */
export function parseIgnored(porcelain: string): string[] {
  return porcelain.split("\0").filter(entry => entry.startsWith("!! ")).map(entry => entry.slice(3).replace(/\/$/, ""));
}

export interface Candidate {
  readonly path: string;
  readonly tier: Tier;
  bytes: number;
}

// From `git rev-parse --local-env-vars`: variables that bind Git to one repository,
// such as those a hook sets, and that would override `-C`.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_VARIABLES) delete clean[name];
  return clean;
}

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: gitEnvironment() });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** Names that mark a tree as holding work or data rather than regenerable output. */
const PROTECTED = [".git", ".env", ".env.*", ".secrets", "*.sqlite", "*.sqlite3", "*.db"];

/** Why a path must not be removed, or undefined when it is safe to. */
export function unsafeReason(root: string, rel: string): string | undefined {
  if (rel === "" || path.isAbsolute(rel) || rel.split("/").some(part => part === ".." || part === "." || part === ".git")) return "outside the repository";
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch { return "missing"; }
    if (stats.isSymbolicLink()) return "symlink";
  }
  // A repository, credentials, or a local database anywhere inside is someone's work or data.
  const protectedFile = spawnSync("find", [current, "(", ...PROTECTED.flatMap((name, index) => [...(index ? ["-o"] : []), "-name", name]), ")",
    "!", "-name", "*.example", "!", "-name", "*.sample", "!", "-name", "*.template", "-print", "-quit"], { encoding: "utf8" });
  if (protectedFile.status !== 0) return "could not search for protected files";
  const found = protectedFile.stdout.trim();
  if (found !== "") return `contains ${path.relative(root, found)}`;
  // Checked here, not only at scan time: a file can be force-added between scan and removal.
  const tracked = git(root, ["ls-files", "-z", "--", rel]);
  if (!tracked.ok) return "could not list tracked files";
  if (tracked.stdout !== "") return "tracked";
  if (!git(root, ["check-ignore", "-q", "--", rel]).ok) return "not ignored";
  return undefined;
}

/** Ignored, untracked, regenerable paths in one repository. */
export function findCandidates(root: string): Candidate[] {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=normal"]);
  if (!status.ok) throw new Error("git status failed");
  const found: Candidate[] = [];
  for (const rel of parseIgnored(status.stdout)) {
    const tier = classify(rel, root);
    if (tier) found.push({ path: rel, tier, bytes: 0 });
    const nested = NESTED[path.posix.basename(rel)];
    for (const [child, childTier] of nested ?? []) {
      const childRel = `${rel}/${child}`;
      if (existsSync(path.join(root, childRel))) found.push({ path: childRel, tier: childTier, bytes: 0 });
    }
  }
  return found.filter(candidate => unsafeReason(root, candidate.path) === undefined);
}

/** Kilobyte-accurate sizes from du, which counts each hard link once per call. */
function measure(paths: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (let start = 0; start < paths.length; start += 200) {
    const batch = paths.slice(start, start + 200);
    const result = spawnSync("du", ["-sk", "--", ...batch], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of (result.stdout ?? "").split("\n")) {
      const match = /^(\d+)\t(.*)$/.exec(line);
      if (match) sizes.set(match[2]!, Number(match[1]) * 1024);
    }
  }
  return sizes;
}

/** Candidates in the chosen tiers, without paths inside another chosen path. */
export function selected(candidates: Candidate[], tiers: ReadonlySet<Tier>): Candidate[] {
  const chosen = candidates.filter(candidate => tiers.has(candidate.tier)).toSorted((a, b) => a.path.length - b.path.length);
  return chosen.filter((candidate, index) => !chosen.slice(0, index).some(other => candidate.path.startsWith(`${other.path}/`)));
}

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  /** Process group: members of the caller's shell pipeline share it. */
  readonly pgid?: number;
  readonly name: string;
  readonly args: string;
  cwd?: string;
}

const PIPELINE_FILTERS = new Set(["head", "tail", "less", "more", "cat", "tee", "grep", "rg", "sed", "awk", "jq", "sort", "uniq", "wc", "cut", "tr", "column"]);
/** An interactive shell waiting at a prompt; `bash build.sh` and `sh -c ...` are working. */
const IDLE_SHELL = /^-?(?:\S*\/)?(?:zsh|bash|sh|fish|dash|tmux)(?:\s+-[il]+)*$/;
export function idleShell(proc: Proc): boolean { return IDLE_SHELL.test(proc.args.trim()); }

/** Every process's cwd; throws when it cannot list them, so busy repositories are never mistaken for idle ones. */
export function processes(): Proc[] {
  const list = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // lsof exits 1 when some processes are unreadable but still lists the rest.
    if (result.error || !result.stdout || (result.status !== 0 && !(command === "lsof" && result.status === 1))) {
      throw new Error(`cannot list processes with ${command} (${result.error?.message ?? `exit ${result.status}`}); without it busy repositories cannot be detected, so pass --include-busy only if none is in use`);
    }
    return result.stdout;
  };
  const names = new Map<number, { ppid: number; pgid: number; name: string }>();
  for (const line of list("ps", ["-axo", "pid=,ppid=,pgid=,comm="]).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) names.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), name: path.basename(match[4]!.trim()) });
  }
  const args = new Map<number, string>();
  for (const line of list("ps", ["-axo", "pid=,args="]).split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]!);
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of list("lsof", ["-nP", "-d", "cwd", "-Fpn"]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return [...names].map(([pid, { ppid, pgid, name }]) => ({ pid, ppid, pgid, name, args: args.get(pid) ?? "", cwd: cwds.get(pid) }));
}

/**
 * Processes working in each root, other than this script, its ancestors (the
 * agent or shell that ran it), its children, idle shells, and text filters
 * in its process group (`| head`, `| jq`: the rest of the caller's pipeline).
 * A build or server in the same group still counts: non-interactive shells
 * put background jobs there too. A process in a
 * nested root counts only for the deepest root containing it.
 */
export function busyRoots(procs: Proc[], roots: string[], self = process.pid): Map<string, Proc[]> {
  const parent = new Map(procs.map(proc => [proc.pid, proc.ppid]));
  const ancestors = new Set<number>();
  for (let pid: number | undefined = self; pid && !ancestors.has(pid); pid = parent.get(pid)) ancestors.add(pid);
  const group = procs.find(proc => proc.pid === self)?.pgid;
  const busy = new Map<string, Proc[]>();
  const byDepth = roots.toSorted((a, b) => b.length - a.length);
  for (const proc of procs) {
    const pipeline = group !== undefined && proc.pgid === group && PIPELINE_FILTERS.has(proc.name);
    if (!proc.cwd || ancestors.has(proc.pid) || proc.ppid === self || pipeline || idleShell(proc)) continue;
    const root = byDepth.find(candidate => proc.cwd === candidate || proc.cwd!.startsWith(`${candidate}/`));
    if (root) busy.set(root, [...(busy.get(root) ?? []), proc]);
  }
  return busy;
}

export interface Target {
  readonly name: string;
  readonly root: string;
}

function toplevel(directory: string): string | undefined {
  const result = git(directory, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : undefined;
}

export function isMatrixWorkspace(root: string): boolean {
  return existsSync(path.join(root, "matrix.json")) && existsSync(path.join(root, "checkouts"));
}

/**
 * Repositories to clean. From a matrix workspace: the workspace and every
 * checkout, or the named checkouts. From anywhere else: the repository
 * containing the working directory, or the named paths.
 */
export function resolveTargets(cwd: string, names: string[]): { workspace?: string; targets: Target[] } {
  // Real paths, so they compare equal to the cwd paths lsof reports.
  const here = toplevel(cwd) && realpathSync(toplevel(cwd)!);
  const workspace = here && isMatrixWorkspace(here) ? here : undefined;
  const checkouts = (root: string) => readdirSync(path.join(root, "checkouts"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(root, "checkouts", entry.name, ".git")))
    .map(entry => ({ name: entry.name, root: realpathSync(path.join(root, "checkouts", entry.name)) }));
  if (names.length === 0) {
    if (workspace) return { workspace, targets: [{ name: path.basename(workspace), root: workspace }, ...checkouts(workspace)] };
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return { targets: [{ name: path.basename(here), root: here }] };
  }
  const targets = names.map(name => {
    const short = name.includes("/") && !existsSync(path.resolve(cwd, name)) ? name.split("/").pop()! : name;
    if (workspace && existsSync(path.join(workspace, "checkouts", short, ".git"))) {
      const root = realpathSync(path.join(workspace, "checkouts", short));
      return { name: path.basename(root), root };
    }
    const top = existsSync(path.resolve(cwd, name)) ? toplevel(path.resolve(cwd, name)) : undefined;
    if (!top) throw new Error(`${name} is neither a checkout name nor a path inside a git repository`);
    const root = realpathSync(top);
    return { name: path.basename(root), root };
  });
  return { workspace, targets: targets.filter((target, index) => targets.findIndex(other => other.root === target.root) === index) };
}

export interface MachineItem {
  readonly id: string;
  readonly description: string;
  bytes?: number;
  /** Only reported: removing it is a judgment call or needs a person. */
  readonly reportOnly: boolean;
  skipped?: string;
  result?: string;
  apply?: () => string;
  /** Why it must wait, given the running processes; rechecked just before it runs. */
  guard?: (procs: Proc[]) => string | undefined;
}

/** What `--machine` needs from the host; tests substitute a fake one. */
export interface Host {
  readonly home: string;
  has(command: string): boolean;
  /** Combined output of a read-only command, empty when it fails. */
  output(command: string, args: string[]): string;
  /** Runs a cleaning command; throws when it fails. */
  run(command: string, args: string[]): string;
}

export const HOST: Host = {
  home: os.homedir(),
  has: command => spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" }).status === 0,
  output: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  },
  run: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim().split("\n").pop()}`);
    return (result.stdout ?? "").trim();
  },
};

/** Running installs read the package caches, so those caches wait for them. */
// Matches the launcher forms too: `brew.rb`, `pnpm.cjs`, `npm-cli.js`, `yarn.js`.
export const INSTALLING = /(^|[\s/])(bun|npm|npm-cli|pnpm|yarn|brew)(\.(?:c|m)?js|\.rb)?(\s+run\s+agent-tool\s+bun)?\s+(install|ci|add|i|upgrade|reinstall)(\s|$)/;

/** Developer caches outside any repository, for `--machine`. */
export function machineItems(procs: Proc[], host: Host = HOST): MachineItem[] {
  const { home, has, run } = host;
  const items: MachineItem[] = [];
  const installing: MachineItem["guard"] = list => {
    const proc = list.find(candidate => INSTALLING.test(candidate.args));
    return proc ? `an install is running (pid ${proc.pid})` : undefined;
  };
  const building: MachineItem["guard"] = list => {
    const proc = list.find(candidate => candidate.name === "xcodebuild" || candidate.name === "Xcode");
    return proc ? `${proc.name} is running (pid ${proc.pid})` : undefined;
  };
  const dir = (id: string, description: string, location: string, reportOnly: boolean, apply?: () => string, guard?: MachineItem["guard"]) => {
    if (existsSync(location)) items.push({ id, description: `${description} (${location.replace(home, "~")})`, reportOnly, bytes: measure([location]).get(location), apply, guard });
  };

  const derived = path.join(home, "Library/Developer/Xcode/DerivedData");
  dir("xcode-derived-data", "Xcode DerivedData, keeping each project's SourcePackages", derived, false, () => {
    // SourcePackages/checkouts are Swift package clones someone may have edited; builds and indexes go.
    for (const entry of readdirSync(derived, { withFileTypes: true })) {
      const project = path.join(derived, entry.name);
      // Xcode can share one SourcePackages directory across projects at the top level.
      if (entry.name === "SourcePackages") continue;
      if (!entry.isDirectory()) { rmSync(project, { force: true }); continue; }
      for (const child of readdirSync(project)) if (child !== "SourcePackages") rmSync(path.join(project, child), { recursive: true, force: true });
    }
    return "cleaned";
  }, building);
  if (has("xcrun")) {
    const listing = host.output("xcrun", ["simctl", "list", "devices", "unavailable"]);
    const count = listing.split("\n").filter(line => /\(unavailable/.test(line)).length;
    // Their app data returns if the runtime is reinstalled, so deleting them is the owner's call.
    if (count > 0) items.push({ id: "unavailable-simulators", description: `${count} simulators whose runtime is no longer installed; \`xcrun simctl delete unavailable\` removes them and their app data`, reportOnly: true });
  }
  if (has("brew")) {
    const match = /free approximately ([\d.]+)([KMGT]?B)/.exec(host.output("brew", ["cleanup", "-n"]));
    const unit: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    // brew cleanup removes downloads an install in progress is using.
    if (match) items.push({ id: "homebrew-cleanup", description: "Old Homebrew versions and downloads (`brew cleanup`)", reportOnly: false, bytes: Number(match[1]) * unit[match[2]!]!, apply: () => { run("brew", ["cleanup"]); return "cleaned"; }, guard: installing });
  }
  if (has("bun")) {
    const cache = host.output("bun", ["pm", "cache"]).trim().split("\n")[0];
    if (cache) dir("bun-cache", "Bun install cache", cache, false, () => run("bun", ["pm", "cache", "rm"]) || "removed", installing);
  }
  if (has("npm")) {
    dir("npm-cache", "npm cache", path.join(home, ".npm/_cacache"), false, () => { run("npm", ["cache", "clean", "--force"]); return "cleaned"; }, installing);
  }
  if (has("pnpm")) {
    items.push({ id: "pnpm-store", description: "Packages no project references in the pnpm store (`pnpm store prune`)", reportOnly: false, apply: () => { run("pnpm", ["store", "prune"]); return "pruned"; }, guard: installing });
  }
  dir("gradle-caches", "Gradle caches; delete with Gradle stopped if Android builds can wait for a re-download", path.join(home, ".gradle/caches"), true);
  dir("playwright-browsers", "Playwright browsers; old versions no project pins can go", path.join(home, "Library/Caches/ms-playwright"), true);
  dir("ios-device-support", "iOS DeviceSupport; versions for devices no longer used can go", path.join(home, "Library/Developer/Xcode/iOS DeviceSupport"), true);
  dir("simulator-devices", "Simulator devices; `xcrun simctl erase` or delete ones no project uses", path.join(home, "Library/Developer/CoreSimulator/Devices"), true);
  if (has("tmutil")) {
    const snapshots = host.output("tmutil", ["listlocalsnapshots", "/"]).split("\n").filter(line => line.includes("com.apple")).length;
    if (snapshots > 0) items.push({ id: "local-snapshots", description: `${snapshots} Time Machine local snapshots hold deleted files' space until macOS thins them`, reportOnly: true });
  }
  if (has("docker")) items.push({ id: "docker", description: "Docker images, containers, and volumes; `docker system df` sizes them, and pruning is the owner's call", reportOnly: true });
  for (const item of items) item.skipped = item.guard?.(procs);
  return items;
}

/**
 * Runs every machine item that is neither report-only nor waiting on a running
 * process, listing processes afresh just before each guarded item.
 * Returns the number that failed.
 */
export function applyMachine(items: MachineItem[], discover: () => Proc[]): number {
  let failures = 0;
  for (const item of items) {
    if (item.reportOnly || !item.apply) continue;
    if (item.guard) {
      try { item.skipped = item.guard(discover()); } catch (error) { item.skipped = (error as Error).message; }
    }
    if (item.reportOnly || item.skipped || !item.apply) continue;
    try { item.result = item.apply(); } catch (error) { item.result = `failed: ${(error as Error).message}`; failures++; }
  }
  return failures;
}

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

export const USAGE = `Usage: space-cleanup [checkout-or-path...] [--builds] [--deps] [--machine] [--include-busy] [--apply] [--json]

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
  let apply = false, json = false, machine = false, includeBusy = false;
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
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function free(directory: string): number {
  const stats = statfsSync(directory);
  return stats.bavail * stats.bsize;
}

export function main(argv: string[], cwd = process.cwd(), discover: () => Proc[] = processes): number {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  const options = parseOptions(argv);
  const { workspace, targets } = resolveTargets(cwd, options.names);
  const volume = workspace ?? targets[0]?.root ?? cwd;
  const before = free(volume);
  let procs: Proc[];
  try { procs = discover(); } catch (error) {
    if (!options.includeBusy) throw error;
    procs = [];
  }
  const busy = busyRoots(procs, targets.map(target => target.root));

  const repos: RepoReport[] = targets.map(target => {
    const report: RepoReport = { ...target, candidates: [] };
    const workers = busy.get(target.root);
    if (workers) report.busy = workers.map(({ pid, name, cwd }) => ({ pid, name, cwd: cwd! }));
    try { report.candidates = findCandidates(target.root); } catch (error) { report.error = (error as Error).message; }
    const sizes = measure(report.candidates.map(candidate => path.join(target.root, candidate.path)));
    for (const candidate of report.candidates) candidate.bytes = sizes.get(path.join(target.root, candidate.path)) ?? 0;
    return report;
  });
  const machine = options.machine ? machineItems(procs) : [];

  let failures = 0;
  if (options.apply) {
    // Scans and sizing take a while; judge activity from a fresh process list.
    let fresh: Proc[];
    try { fresh = discover(); } catch (error) {
      if (!options.includeBusy) throw error;
      fresh = [];
    }
    const nowBusy = busyRoots(fresh, targets.map(target => target.root));
    for (const repo of repos) {
      const workers = nowBusy.get(repo.root);
      repo.busy = workers?.map(({ pid, name, cwd }) => ({ pid, name, cwd: cwd! }));
    }
    for (const repo of repos) {
      if (repo.error || (repo.busy && !options.includeBusy)) continue;
      repo.removed = [];
      repo.failed = [];
      for (const candidate of selected(repo.candidates, options.tiers)) {
        // Re-check at removal time: the tree may have changed since the scan.
        const reason = unsafeReason(repo.root, candidate.path);
        if (reason) { if (reason !== "missing") repo.failed.push({ path: candidate.path, error: reason }); continue; }
        try { rmSync(path.join(repo.root, candidate.path), { recursive: true, force: true }); repo.removed.push(candidate.path); }
        catch (error) { repo.failed.push({ path: candidate.path, error: (error as Error).message }); }
      }
      failures += repo.failed.length;
    }
    failures += applyMachine(machine, () => {
      try { return discover(); } catch (error) { if (options.includeBusy) return []; throw error; }
    });
  }
  const after = options.apply ? free(volume) : undefined;

  const tierTotal = (tier: Tier) => repos.reduce((sum, repo) => sum + selected(repo.candidates, new Set([tier])).reduce((total, candidate) => total + candidate.bytes, 0), 0);
  const totals = Object.fromEntries(TIERS.map(tier => [tier, tierTotal(tier)])) as Record<Tier, number>;
  if (options.json) {
    console.log(JSON.stringify({
      applied: options.apply, workspace: workspace ?? null, tiers: [...options.tiers], free: { before, ...(after !== undefined && { after }) }, totals,
      repos: repos.map(repo => ({ ...repo, skipped: repo.busy && !options.includeBusy ? "busy" : undefined })),
      ...(options.machine && { machine: machine.map(({ apply: _apply, ...item }) => item) }),
    }, null, 2));
    return failures > 0 ? 1 : 0;
  }

  const lines = [`Space cleanup ${options.apply ? "(applied)" : "(dry run)"}: ${size(before)} free${workspace ? ` in matrix workspace ${workspace}` : ""}`];
  for (const repo of repos) {
    const chosen = selected(repo.candidates, options.tiers);
    const status = repo.error ? ` error: ${repo.error}`
      : repo.busy && !options.includeBusy ? ` skipped, busy: ${repo.busy.slice(0, 3).map(proc => `${proc.name} ${proc.pid}`).join(", ")}${repo.busy.length > 3 ? ", ..." : ""}`
      : "";
    const perTier = TIERS.map(tier => `${tier} ${size(selected(repo.candidates, new Set([tier])).reduce((sum, candidate) => sum + candidate.bytes, 0))}`).join(", ");
    lines.push(`\n${repo.name}${status}\n  ${perTier}`);
    for (const candidate of chosen.toSorted((a, b) => b.bytes - a.bytes).slice(0, 8)) lines.push(`  ${options.apply && repo.removed?.includes(candidate.path) ? "removed" : candidate.tier.padEnd(7)} ${size(candidate.bytes).padStart(10)}  ${candidate.path}`);
    if (chosen.length > 8) lines.push(`  ... and ${chosen.length - 8} more`);
    for (const failure of repo.failed ?? []) lines.push(`  FAILED ${failure.path}: ${failure.error}`);
  }
  if (options.machine) {
    lines.push("\nmachine");
    for (const item of machine) {
      const state = item.reportOnly ? "review" : item.skipped ? `skipped (${item.skipped})` : item.result ?? (options.apply ? "" : "would clean");
      lines.push(`  ${size(item.bytes).padStart(10)}  ${item.description}: ${state}`);
    }
  }
  lines.push(`\nTotals: caches ${size(totals.caches)}, builds ${size(totals.builds)}${options.tiers.has("builds") ? "" : " (--builds)"}, deps ${size(totals.deps)}${options.tiers.has("deps") ? "" : " (--deps)"}`);
  if (after !== undefined) lines.push(`Free: ${size(before)} -> ${size(after)}`);
  else lines.push("Nothing changed; rerun with --apply to remove the listed tiers.");
  console.log(lines.join("\n"));
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error((error as Error).message); process.exitCode = 2; }
}
