import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { git, gitOutput, gitSucceeds } from "./git";
import { CHECKOUTS, checkoutPath, parseGitHubRepo, repoName } from "./manifest";

export interface SyncResult {
  readonly repo: string;
  readonly path: string;
  readonly action: "cloned" | "updated" | "current" | "skipped" | "error";
  readonly branch?: string | null;
  readonly defaultBranch?: string;
  readonly head?: string;
  readonly reason?: string;
}

export interface CheckoutStatus {
  readonly repo: string;
  readonly path: string;
  readonly present: boolean;
  /** On origin's default branch at its last fetched commit, with no local changes. */
  readonly ready: boolean;
  readonly branch?: string | null;
  readonly defaultBranch?: string;
  readonly head?: string;
  readonly changes?: number;
  /** Commits on HEAD that origin's default branch lacks, and the reverse. */
  readonly ahead?: number;
  readonly behind?: number;
  readonly error?: string;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Drop URL userinfo so a credential-bearing remote never reaches output. */
function redact(url: string): string { return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"); }

function verifyCheckout(directory: string, repo: string, url: string): void {
  const top = git(directory, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || top.stdout !== realpathSync(directory)) throw new Error("not a separate Git checkout");
  const origin = git(directory, ["remote", "get-url", "origin"]);
  if (origin.status !== 0) throw new Error("has no origin remote");
  const actual = parseGitHubRepo(origin.stdout);
  if (actual ? actual.toLowerCase() !== repo.toLowerCase() : origin.stdout !== url) {
    throw new Error(`origin is ${actual ?? redact(origin.stdout)}, expected ${repo}`);
  }
}

function defaultBranch(directory: string): string {
  const ref = git(directory, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (ref.status !== 0) throw new Error("origin/HEAD is unknown; run sync");
  return ref.stdout.replace(/^refs\/remotes\/origin\//, "");
}

function currentBranch(directory: string): string | null {
  const ref = git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return ref.status === 0 ? ref.stdout : null;
}

function changeCount(directory: string): number {
  const status = gitOutput(directory, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
  return status ? status.split("\n").length : 0;
}

function snapshot(directory: string) {
  return { branch: currentBranch(directory), defaultBranch: defaultBranch(directory), head: gitOutput(directory, ["rev-parse", "HEAD"]) };
}

/**
 * Clone a missing checkout, or fetch an existing one and fast-forward its default
 * branch when that branch is checked out and clean. Anything else is reported,
 * never reset, stashed, or replaced.
 */
export function syncRepo(root: string, repo: string, url: string): SyncResult {
  const directory = checkoutPath(root, repo);
  const base = { repo, path: path.relative(root, directory) };
  try {
    if (!existsSync(directory)) {
      mkdirSync(path.dirname(directory), { recursive: true });
      gitOutput(root, ["clone", "--quiet", url, directory]);
      return { ...base, action: "cloned", ...snapshot(directory) };
    }
    verifyCheckout(directory, repo, url);
    gitOutput(directory, ["fetch", "--quiet", "--prune", "origin"]);
    gitOutput(directory, ["remote", "set-head", "origin", "--auto"]);
    const state = { ...base, ...snapshot(directory) };
    if (state.branch === null) return { ...state, action: "skipped", reason: "detached HEAD" };
    if (changeCount(directory) > 0) return { ...state, action: "skipped", reason: "uncommitted changes" };
    if (state.branch !== state.defaultBranch) return { ...state, action: "skipped", reason: `on branch ${state.branch}` };
    const remote = gitOutput(directory, ["rev-parse", `refs/remotes/origin/${state.defaultBranch}`]);
    if (remote === state.head) return { ...state, action: "current" };
    if (!gitSucceeds(directory, ["merge-base", "--is-ancestor", "HEAD", remote])) {
      const ahead = gitSucceeds(directory, ["merge-base", "--is-ancestor", remote, "HEAD"]);
      return { ...state, action: "skipped", reason: `local ${state.branch} ${ahead ? "has unpushed commits" : "has diverged from origin"}` };
    }
    // Git otherwise replaces ignored local files, such as .env, that upstream starts tracking.
    gitOutput(directory, ["merge", "--quiet", "--ff-only", "--no-overwrite-ignore", remote]);
    return { ...state, action: "updated", head: remote };
  } catch (error) {
    return { ...base, action: "error", reason: message(error) };
  }
}

/** Report a checkout from local state only; run sync first for current remote state. */
export function checkoutStatus(root: string, repo: string, url: string): CheckoutStatus {
  const directory = checkoutPath(root, repo);
  const base = { repo, path: path.relative(root, directory) };
  if (!existsSync(directory)) return { ...base, present: false, ready: false };
  try {
    verifyCheckout(directory, repo, url);
    const state = snapshot(directory);
    const changes = changeCount(directory);
    const counts = gitOutput(directory, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${state.defaultBranch}`]);
    const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number);
    const ready = state.branch === state.defaultBranch && changes === 0 && ahead === 0 && behind === 0;
    return { ...base, present: true, ready, ...state, changes, ahead, behind };
  } catch (error) {
    return { ...base, present: true, ready: false, error: message(error) };
  }
}

/** Entries under checkouts/ that matrix.json does not manage. They are reported, never removed. */
export function unmanagedCheckouts(root: string, repos: string[]): string[] {
  const directory = path.join(root, CHECKOUTS);
  if (!existsSync(directory)) return [];
  const managed = new Set(repos.map(repo => repoName(repo).toLowerCase()));
  return readdirSync(directory)
    .filter(name => !name.startsWith(".") && !managed.has(name.toLowerCase()))
    .sort()
    .map(name => path.join(CHECKOUTS, name));
}
