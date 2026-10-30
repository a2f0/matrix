#!/usr/bin/env bun
/**
 * Shared screenshot store for every clone of a repository.
 *
 * Captured screenshots live outside the clones, in
 * `<artifacts>/<project>/screenshots`, and each clone's gitignored
 * `.screenshots` is a symlink to it. A capture in any clone therefore updates
 * every clone, and a build or deploy in any clone publishes the newest capture
 * instead of whatever that clone last took.
 *
 * `capture` runs the repository's own `bun run screenshots` under a per-project
 * lock and records its provenance in `.screenshots/capture.json`, which builds
 * read before they publish. `link` and `capture` are dry runs until `--apply`.
 *
 * Uses only Node built-ins so it runs by path from any repository.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** The link every clone carries, and the directory its capture writes. */
export const LINK = ".screenshots";
/** Provenance of the newest capture, inside the shared directory. */
export const RECORD = "capture.json";
/** Held for the length of one capture, beside the shared directory. */
export const LOCK = ".capture.lock";

export const USAGE = `Usage: artifacts.ts <command> [repo...] [options]

  status [repo...]          Link state and newest capture of each repository
  link [repo...] [--apply] [--supersede]
                            Point each repository's .screenshots at the shared store,
                            moving an existing capture there when the store is empty;
                            --supersede moves it to <project>/superseded/ instead
  capture [repo] [--apply] [--allow-dirty] [-- capture args...]
                            Run the repository's \`bun run screenshots\` under a lock
                            and record the capture's commit in .screenshots/capture.json

Repos are checkout names or paths; none selects the current repository, or in a
matrix workspace every checkout that captures screenshots. MATRIX_ARTIFACTS_DIR
overrides the store, which defaults to matrix-artifacts beside the workspace
(or beside the repository outside one). --json prints the report as JSON.
`;

export interface CaptureRecord {
  readonly schemaVersion: 1;
  readonly project: string;
  /** owner/name from origin, when it is a GitHub remote. */
  readonly repo?: string;
  readonly status: "running" | "complete" | "failed";
  readonly commit: string;
  readonly branch: string | null;
  /** The working tree had changes the commit does not hold. */
  readonly dirty: boolean;
  /** HEAD was reachable from origin's default branch; null when that is unknown. */
  readonly merged: boolean | null;
  /** Arguments passed to the capture; non-empty usually means a partial capture. */
  readonly args: string[];
  readonly checkout: string;
  readonly host: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number | null;
}

export type LinkState =
  | { readonly state: "linked" }
  | { readonly state: "missing" }
  | { readonly state: "directory"; readonly entries: number }
  | { readonly state: "elsewhere"; readonly target: string }
  | { readonly state: "other" };

export interface Target {
  readonly name: string;
  readonly root: string;
  readonly project: string;
  readonly repo?: string;
}

/** Git without hooks, prompts, or variables that bind it to another repository. */
function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) delete env[name];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim() };
}

function gitValue(cwd: string, ...args: string[]): string | undefined {
  const result = git(cwd, ...args);
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}

function toplevel(cwd: string): string | undefined { return gitValue(cwd, "rev-parse", "--show-toplevel"); }

export function isMatrixWorkspace(root: string): boolean {
  return existsSync(path.join(root, "matrix.json")) && existsSync(path.join(root, "checkouts"));
}

/** The matrix workspace a repository is, or is a checkout of. */
export function workspaceOf(root: string): string | undefined {
  if (isMatrixWorkspace(root)) return root;
  const parent = path.dirname(root);
  return path.basename(parent) === "checkouts" && isMatrixWorkspace(path.dirname(parent)) ? path.dirname(parent) : undefined;
}

/** MATRIX_ARTIFACTS_DIR, or matrix-artifacts beside the workspace (beside the repository outside one), like matrix-secrets. */
export function artifactsRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MATRIX_ARTIFACTS_DIR || path.join(workspaceOf(root) ?? root, "..", "matrix-artifacts"));
}

/** owner/name from a GitHub remote URL in any form Git accepts. */
export function githubRepo(url: string): string | undefined {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** A repository's store namespace: its GitHub name like matrix-secrets', or its directory name. */
export function targetFor(root: string, project?: string): Target {
  const remote = gitValue(root, "remote", "get-url", "origin");
  const repo = remote ? githubRepo(remote) : undefined;
  const name = project ?? repo?.split("/")[1] ?? path.basename(root);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`'${name}' is not a usable project name`);
  return { name: path.basename(root), root, project: name, ...(repo ? { repo } : {}) };
}

export function packageScripts(root: string): Record<string, unknown> {
  try {
    const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: unknown }).scripts;
    return typeof scripts === "object" && scripts !== null ? scripts as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Whether a repository captures screenshots: a `screenshots` script, or a capture left in .screenshots. */
export function captures(root: string): boolean {
  return typeof packageScripts(root).screenshots === "string" || lexists(path.join(root, LINK));
}

function lexists(file: string): boolean {
  try { lstatSync(file); return true; } catch { return false; }
}

export function resolveTargets(cwd: string, names: string[], project?: string): { workspace?: string; targets: Target[] } {
  const here = toplevel(cwd);
  const workspace = here && isMatrixWorkspace(realpathSync(here)) ? realpathSync(here) : undefined;
  if (project && names.length > 1) throw new Error("--project names one repository's namespace; select one repository");
  if (names.length === 0) {
    if (workspace) {
      const roots = readdirSync(path.join(workspace, "checkouts"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(path.join(workspace, "checkouts", entry.name, ".git")))
        .map(entry => realpathSync(path.join(workspace, "checkouts", entry.name)))
        .filter(captures)
        .sort();
      if (project) throw new Error("--project needs one named repository");
      return { workspace, targets: roots.map(root => targetFor(root)) };
    }
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return { targets: [targetFor(realpathSync(here), project)] };
  }
  const roots = names.map(name => {
    const short = name.includes("/") && !existsSync(path.resolve(cwd, name)) ? name.split("/").pop()! : name;
    if (workspace && existsSync(path.join(workspace, "checkouts", short, ".git"))) return realpathSync(path.join(workspace, "checkouts", short));
    const top = existsSync(path.resolve(cwd, name)) ? toplevel(path.resolve(cwd, name)) : undefined;
    if (!top) throw new Error(`${name} is neither a checkout name nor a path inside a git repository`);
    return realpathSync(top);
  });
  return { workspace, targets: [...new Set(roots)].map(root => targetFor(root, project)) };
}

export function storeDir(target: Target, artifacts: string): string { return path.join(artifacts, target.project, "screenshots"); }

function sameFile(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

export function linkState(target: Target, artifacts: string): LinkState {
  const link = path.join(target.root, LINK);
  let stats;
  try { stats = lstatSync(link); } catch { return { state: "missing" }; }
  if (stats.isSymbolicLink()) {
    const destination = path.resolve(target.root, readlinkSync(link));
    // A link to the store's path counts even before the first capture creates the directory.
    return destination === storeDir(target, artifacts) || sameFile(destination, storeDir(target, artifacts))
      ? { state: "linked" }
      : { state: "elsewhere", target: destination };
  }
  if (stats.isDirectory()) return { state: "directory", entries: readdirSync(link).length };
  return { state: "other" };
}

/**
 * Whether the root .gitignore ignores `.screenshots` whatever its type. A
 * trailing slash (`.screenshots/`) matches only a directory, so the link would
 * show up as untracked and hold back `matrix sync`.
 */
export function ignorePatternMatchesFile(root: string): boolean {
  let text = "";
  try { text = readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { return false; }
  return text.split("\n").map(line => line.trim()).some(line => [LINK, `/${LINK}`, `**/${LINK}`].includes(line));
}

function emptyOrMissing(directory: string): boolean {
  try { return readdirSync(directory).length === 0; } catch { return !lexists(directory); }
}

export interface LinkResult {
  readonly name: string;
  readonly project: string;
  readonly store: string;
  readonly before: LinkState["state"];
  /** What --apply does or did; absent when nothing needs doing. */
  readonly action?: "link" | "move-and-link" | "replace-empty-directory" | "supersede-and-link";
  /** With --supersede, where the clone's own capture was moved. */
  readonly superseded?: string;
  readonly applied?: boolean;
  /** Why it cannot be linked automatically. */
  readonly blocked?: string;
}

/** Plan, and with apply perform, the link for one repository. */
export function link(target: Target, artifacts: string, apply: boolean, supersede = false, now = new Date()): LinkResult {
  const store = storeDir(target, artifacts);
  const base = { name: target.name, project: target.project, store };
  const state = linkState(target, artifacts);
  if (state.state === "linked") return { ...base, before: "linked" };
  const blocked = (reason: string): LinkResult => ({ ...base, before: state.state, blocked: reason });
  if (isInside(artifacts, target.root)) return blocked(`the store ${artifacts} is inside the repository`);
  if (!ignorePatternMatchesFile(target.root)) return blocked(`the root .gitignore must list ${LINK} without a trailing slash, so the link is ignored`);
  if (state.state === "elsewhere") return blocked(`${LINK} already links to ${state.target}; remove it by hand if that is stale`);
  if (state.state === "other") return blocked(`${LINK} is neither a directory nor a link`);
  let action: LinkResult["action"] = "link";
  if (state.state === "directory") {
    if (state.entries === 0) action = "replace-empty-directory";
    else if (emptyOrMissing(store)) action = "move-and-link";
    else if (supersede) action = "supersede-and-link";
    else return blocked(`${LINK} holds a capture and the store already holds another; compare them, then rerun with --supersede to move this clone's aside`);
  }
  // Kept, never deleted: a person removes superseded captures once nothing needs them.
  const superseded = action === "supersede-and-link"
    ? path.join(artifacts, target.project, "superseded", `${target.name}-${now.toISOString().replace(/[:.]/g, "-")}`)
    : undefined;
  if (!apply) return { ...base, before: state.state, action, ...(superseded ? { superseded } : {}) };
  // Recheck at apply time: another process may have linked or written since the plan.
  const current = linkState(target, artifacts);
  if (current.state !== state.state || (current.state === "directory" && current.entries !== (state as { entries: number }).entries)) {
    return blocked(`${LINK} changed while planning; run link again`);
  }
  mkdirSync(path.dirname(store), { recursive: true });
  const linkPath = path.join(target.root, LINK);
  const relative = path.relative(realpathSync(target.root), path.join(realpathSync(path.dirname(store)), path.basename(store)));
  if (action === "move-and-link") {
    if (lexists(store)) rmdirSync(store); // empty, checked above; rename cannot replace it across all platforms
    try { renameSync(linkPath, store); } catch (error) {
      return blocked(`could not move ${LINK} into the store (${(error as NodeJS.ErrnoException).code ?? String(error)}); move it by hand`);
    }
  } else if (action === "supersede-and-link") {
    mkdirSync(path.dirname(superseded!), { recursive: true });
    if (lexists(superseded!)) return blocked(`${superseded} already exists; run link again`);
    renameSync(linkPath, superseded!);
  } else if (action === "replace-empty-directory") {
    rmdirSync(linkPath); // fails, safely, if something was written meanwhile
    mkdirSync(store, { recursive: true });
  } else {
    mkdirSync(store, { recursive: true });
  }
  try { symlinkSync(relative, linkPath); } catch (error) {
    if (action === "move-and-link") renameSync(store, linkPath);
    if (action === "supersede-and-link") renameSync(superseded!, linkPath);
    throw error;
  }
  return { ...base, before: state.state, action, applied: true, ...(superseded ? { superseded } : {}) };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function readRecord(store: string): CaptureRecord | undefined {
  try { return JSON.parse(readFileSync(path.join(store, RECORD), "utf8")) as CaptureRecord; } catch { return undefined; }
}

/** Where a capture's commit sits relative to a repository's HEAD. */
export function relation(root: string, commit: string): { relation: "current" | "behind" | "ahead" | "diverged" | "unknown"; commits?: number } {
  const head = gitValue(root, "rev-parse", "HEAD");
  if (!head) return { relation: "unknown" };
  if (commit === head) return { relation: "current" };
  if (git(root, "cat-file", "-e", `${commit}^{commit}`).status !== 0) return { relation: "unknown" };
  const count = (range: string) => Number(gitValue(root, "rev-list", "--count", range) ?? NaN);
  if (git(root, "merge-base", "--is-ancestor", commit, head).status === 0) return { relation: "behind", commits: count(`${commit}..${head}`) };
  if (git(root, "merge-base", "--is-ancestor", head, commit).status === 0) return { relation: "ahead", commits: count(`${head}..${commit}`) };
  return { relation: "diverged" };
}

export interface StatusEntry {
  readonly name: string;
  readonly project: string;
  readonly store: string;
  readonly link: LinkState;
  readonly capture?: CaptureRecord;
  readonly sinceCapture?: ReturnType<typeof relation>;
  readonly lock?: LockInfo;
}

export function status(target: Target, artifacts: string): StatusEntry {
  const store = storeDir(target, artifacts);
  const capture = readRecord(store);
  const lock = readLock(path.join(artifacts, target.project, LOCK));
  return {
    name: target.name,
    project: target.project,
    store,
    link: linkState(target, artifacts),
    ...(capture ? { capture, sinceCapture: relation(target.root, capture.commit) } : {}),
    ...(lock ? { lock } : {}),
  };
}

interface LockInfo { readonly pid: number; readonly host: string; readonly checkout: string; readonly startedAt: string }

function readLock(file: string): LockInfo | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as LockInfo; } catch { return undefined; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Take the project's capture lock, replacing one left by a process that died on
 * this host. The lock is written to a private file and then hard-linked into
 * place, so it never exists without its holder: a reader that cannot parse it
 * is looking at a damaged lock, which stays held until a person removes it.
 */
export function acquireLock(file: string, info: LockInfo): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${info.pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o644 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temporary, file);
        return () => { if (readLock(file)?.pid === info.pid) unlinkSync(file); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const held = readLock(file);
        if (!held) throw new Error(`the capture lock ${file} is unreadable; remove it once no capture is running`);
        if (held.host !== info.host || alive(held.pid)) {
          throw new Error(`another capture of this project is running: pid ${held.pid} on ${held.host} in ${held.checkout} since ${held.startedAt}`);
        }
        // The holder died on this host. Move the lock aside, and keep it only if it
        // turns out to be another process's lock taken since it was read.
        const aside = `${temporary}.stale`;
        try { renameSync(file, aside); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const moved = readLock(aside);
        if (moved?.pid === held.pid && moved.host === held.host && moved.startedAt === held.startedAt) { unlinkSync(aside); continue; }
        try { linkSync(aside, file); } finally { unlinkSync(aside); }
        throw new Error(`the capture lock ${file} changed while it was replaced; run capture again`);
      }
    }
    throw new Error(`could not take the capture lock ${file}`);
  } finally {
    unlinkSync(temporary);
  }
}

/** Replace the record atomically, so a reader never sees half a file. */
export function writeRecord(store: string, record: CaptureRecord): void {
  mkdirSync(store, { recursive: true });
  const temporary = path.join(store, `.${RECORD}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path.join(store, RECORD));
}

export interface Runner {
  /** Runs the repository's capture with inherited output; returns its exit code. */
  capture(root: string, args: string[]): number | null;
}

const RUNNER: Runner = {
  capture(root, args) {
    const result = spawnSync("bun", ["run", "screenshots", ...args], { cwd: root, stdio: "inherit" });
    if (result.error) throw new Error(`Could not run bun: ${result.error.message}`);
    return result.status;
  },
};

export interface CapturePlan {
  readonly name: string;
  readonly project: string;
  readonly store: string;
  readonly command: string;
  readonly commit: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly merged: boolean | null;
  readonly previous?: CaptureRecord;
  readonly applied?: boolean;
  readonly record?: CaptureRecord;
}

export function capture(target: Target, artifacts: string, options: { apply: boolean; allowDirty: boolean; args: string[] }, runner: Runner = RUNNER): CapturePlan {
  if (typeof packageScripts(target.root).screenshots !== "string") {
    throw new Error(`${target.name} has no \`screenshots\` package script; see the take-screenshots skill's repository contract`);
  }
  const state = linkState(target, artifacts);
  if (state.state !== "linked") throw new Error(`${target.name}/${LINK} is ${state.state}, not linked to the store; run \`link --apply\` first`);
  const commit = gitValue(target.root, "rev-parse", "HEAD");
  if (!commit) throw new Error(`${target.name} has no commit to capture`);
  const dirty = (gitValue(target.root, "status", "--porcelain=v1", "--untracked-files=normal") ?? "") !== "";
  if (dirty && !options.allowDirty) {
    throw new Error(`${target.name} has local changes; a shared capture would publish them. Commit first, or pass --allow-dirty for a local-only look`);
  }
  const branch = gitValue(target.root, "symbolic-ref", "--quiet", "--short", "HEAD") ?? null;
  const upstream = gitValue(target.root, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD");
  const merged = upstream ? git(target.root, "merge-base", "--is-ancestor", commit, upstream).status === 0 : null;
  const store = storeDir(target, artifacts);
  const plan: CapturePlan = {
    name: target.name, project: target.project, store,
    command: ["bun", "run", "screenshots", ...options.args].join(" "),
    commit, branch, dirty, merged,
    ...(readRecord(store) ? { previous: readRecord(store)! } : {}),
  };
  if (!options.apply) return plan;
  const startedAt = new Date().toISOString();
  const release = acquireLock(path.join(artifacts, target.project, LOCK), { pid: process.pid, host: os.hostname(), checkout: target.root, startedAt });
  // Hold SIGINT and SIGTERM until the capture exits, so the record and lock are settled.
  let signal: NodeJS.Signals | undefined;
  const hold = (received: NodeJS.Signals) => { signal = received; };
  process.on("SIGINT", hold);
  process.on("SIGTERM", hold);
  try {
    const base = {
      schemaVersion: 1 as const, project: target.project, ...(target.repo ? { repo: target.repo } : {}),
      commit, branch, dirty, merged, args: options.args, checkout: target.root, host: os.hostname(), startedAt,
    };
    writeRecord(store, { ...base, status: "running" });
    let exitCode: number | null = null;
    try { exitCode = runner.capture(target.root, options.args); } finally {
      // A capture that deleted and recreated .screenshots wrote into the clone, not the store.
      const kept = linkState(target, artifacts).state === "linked";
      if (!kept) process.stderr.write(`${target.name}/${LINK} is no longer linked: the capture replaced it, so the store did not receive it. Never remove ${LINK} itself; clear its contents.\n`);
      const finished: CaptureRecord = { ...base, status: exitCode === 0 && !signal && kept ? "complete" : "failed", finishedAt: new Date().toISOString(), exitCode };
      // The capture may have replaced the shared directory's contents; the record goes back in either way.
      writeRecord(store, finished);
      Object.assign(plan, { applied: true, record: finished });
    }
    return plan;
  } finally {
    release();
    process.off("SIGINT", hold);
    process.off("SIGTERM", hold);
  }
}

export interface Options {
  readonly command: "status" | "link" | "capture";
  readonly names: string[];
  readonly apply: boolean;
  readonly json: boolean;
  readonly allowDirty: boolean;
  readonly supersede: boolean;
  readonly project?: string;
  readonly captureArgs: string[];
}

export function parseOptions(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "link" && command !== "capture") throw new Error(`unknown command '${command ?? ""}'\n\n${USAGE}`);
  const split = rest.indexOf("--");
  const own = split === -1 ? rest : rest.slice(0, split);
  const captureArgs = split === -1 ? [] : rest.slice(split + 1);
  if (captureArgs.length > 0 && command !== "capture") throw new Error("only capture forwards arguments after --");
  const names: string[] = [];
  let apply = false, json = false, allowDirty = false, supersede = false, project: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--allow-dirty") allowDirty = true;
    else if (arg === "--supersede") supersede = true;
    else if (arg === "--project") project = own[++index] ?? (() => { throw new Error("--project needs a name"); })();
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }
  if (apply && command === "status") throw new Error("status changes nothing; --apply does not apply");
  if (allowDirty && command !== "capture") throw new Error("--allow-dirty applies only to capture");
  if (supersede && command !== "link") throw new Error("--supersede applies only to link");
  return { command, names, apply, json, allowDirty, supersede, captureArgs, ...(project ? { project } : {}) };
}

function describeCapture(entry: StatusEntry): string {
  const record = entry.capture;
  if (!record) return "no capture recorded";
  const since = entry.sinceCapture!;
  const where = since.relation === "current" ? "at HEAD"
    : since.relation === "behind" ? `${since.commits} commit(s) behind HEAD`
      : since.relation === "ahead" ? `${since.commits} commit(s) ahead of HEAD`
        : since.relation === "diverged" ? "on a branch HEAD does not contain" : "commit not in this clone; fetch";
  const flags = [record.dirty ? "dirty" : "", record.merged === false ? "unmerged" : "", record.args.length > 0 ? `partial: ${record.args.join(" ")}` : ""].filter(Boolean);
  return `${record.status} ${record.finishedAt ?? record.startedAt} at ${record.commit.slice(0, 10)}${record.branch ? ` (${record.branch})` : ""}, ${where}${flags.length ? `; ${flags.join(", ")}` : ""}`;
}

export function main(argv: string[], cwd = process.cwd(), runner: Runner = RUNNER, print: (text: string) => void = text => console.log(text)): number {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { print(USAGE); return argv.length === 0 ? 2 : 0; }
  const options = parseOptions(argv);
  const { targets } = resolveTargets(cwd, options.names, options.project);
  if (targets.length === 0) { print(options.json ? "[]" : "No repository here captures screenshots."); return 0; }
  const artifacts = artifactsRoot(targets[0]!.root);
  if (targets.some(target => artifactsRoot(target.root) !== artifacts)) throw new Error("the selected repositories resolve different stores; set MATRIX_ARTIFACTS_DIR");
  if (options.command === "status") {
    const entries = targets.map(target => status(target, artifacts));
    if (options.json) print(JSON.stringify({ artifacts, entries }, null, 2));
    else for (const entry of entries) {
      const lock = entry.lock ? `; capture running in ${entry.lock.checkout} (pid ${entry.lock.pid})` : "";
      print(`${entry.name} [${entry.project}] ${entry.link.state}: ${describeCapture(entry)}${lock}`);
    }
    return entries.every(entry => entry.link.state === "linked") ? 0 : 1;
  }
  if (options.command === "link") {
    const results = targets.map(target => link(target, artifacts, options.apply, options.supersede));
    if (options.json) print(JSON.stringify({ artifacts, apply: options.apply, results }, null, 2));
    else for (const result of results) {
      const outcome = result.blocked ? `blocked: ${result.blocked}`
        : !result.action ? "already linked"
          : `${result.applied ? "done" : "would"} ${result.action} -> ${result.store}${result.superseded ? `; its own capture to ${result.superseded}` : ""}`;
      print(`${result.name} [${result.project}] ${outcome}`);
    }
    if (!options.apply && results.some(result => result.action && !result.blocked)) print("Dry run; rerun with --apply.");
    return results.some(result => result.blocked) ? 1 : 0;
  }
  if (targets.length !== 1) throw new Error("capture runs one repository at a time; name it");
  const plan = capture(targets[0]!, artifacts, { apply: options.apply, allowDirty: options.allowDirty, args: options.captureArgs }, runner);
  if (options.json) print(JSON.stringify(plan, null, 2));
  else if (!plan.applied) {
    print(`Would run \`${plan.command}\` in ${targets[0]!.root} at ${plan.commit.slice(0, 10)}${plan.merged === false ? " (not on origin's default branch)" : ""}, writing ${plan.store}.`);
    if (plan.previous) print(`Replaces the ${plan.previous.status} capture of ${plan.previous.commit.slice(0, 10)} from ${plan.previous.checkout}.`);
    print("Dry run; rerun with --apply.");
  } else print(`Capture ${plan.record!.status} (exit ${plan.record!.exitCode}); recorded in ${path.join(plan.store, RECORD)}.`);
  return plan.applied && plan.record!.status !== "complete" ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error((error as Error).message); process.exitCode = 2; }
}
