/** Which ignored paths in a repository are regenerable, and which must be kept. Node built-ins only, like space-cleanup.ts. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { git } from "./git";

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
function classify(rel: string, root: string): Tier | undefined {
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

/** Names that mark a tree as holding work or data rather than regenerable output. */
// `.env*` covers `.envrc` and `.env-production` as well as `.env.local`.
const PROTECTED = [".git", ".env*", ".secrets", "*.sqlite", "*.sqlite3", "*.db"];
const TEMPLATE = /\.(example|sample|template)$/;

/** Whether one path component is protected, by the same patterns `find` applies below. */
export function protectedName(name: string): boolean {
  if (TEMPLATE.test(name)) return false;
  return PROTECTED.some(pattern => pattern.startsWith("*.") ? name.endsWith(pattern.slice(1))
    : pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1))
    : name === pattern);
}

/** A working tree (`.git` inside) or a bare repository (`HEAD`, `objects`, `refs`). */
export function isRepository(directory: string): boolean {
  return existsSync(path.join(directory, ".git"))
    || (existsSync(path.join(directory, "HEAD")) && existsSync(path.join(directory, "objects")) && existsSync(path.join(directory, "refs")));
}

/** The first repository at or under `directory`, undefined when there is none; throws when it cannot search. */
function findRepository(directory: string): string | undefined {
  if (isRepository(directory)) return directory;
  const result = spawnSync("find", [directory, "(", "-name", ".git", "-o", "-name", "HEAD", ")", "-print"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`could not search ${directory} for repositories`);
  for (const found of result.stdout.split("\n").filter(Boolean)) {
    if (path.basename(found) === ".git") return path.dirname(found);
    if (isRepository(path.dirname(found))) return path.dirname(found);
  }
  return undefined;
}

/**
 * Why a directory must be kept because a repository, credentials, or a local
 * database is somewhere inside it; undefined when nothing is. Paths in the
 * reason are relative to `base`.
 */
export function holdsProtected(directory: string, base: string): string | undefined {
  const protectedFile = spawnSync("find", [directory, "(", ...PROTECTED.flatMap((name, index) => [...(index ? ["-o"] : []), "-name", name]), ")",
    "!", "-name", "*.example", "!", "-name", "*.sample", "!", "-name", "*.template", "-print", "-quit"], { encoding: "utf8" });
  if (protectedFile.status !== 0) return "could not search for protected files";
  const found = protectedFile.stdout.trim();
  if (found !== "") return `contains ${path.relative(base, found)}`;
  let repository: string | undefined;
  try { repository = findRepository(directory); } catch { return "could not search for repositories"; }
  if (repository) return `contains repository ${path.relative(base, repository) || "."}`;
  return undefined;
}

/** Why a path must not be removed, or undefined when it is safe to. */
export function unsafeReason(root: string, rel: string): string | undefined {
  if (rel === "" || path.isAbsolute(rel) || rel.split("/").some(part => part === ".." || part === "." || part === ".git")) return "outside the repository";
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch { return "missing"; }
    if (stats.isSymbolicLink()) return "symlink";
    // A nested clone above the candidate owns it (an ignored node_modules that is a repository).
    if (isRepository(current)) return `inside repository ${path.relative(root, current)}`;
    // An ignored `.secrets/build` is still inside credentials.
    if (protectedName(part)) return `inside ${path.relative(root, current)}`;
  }
  const held = holdsProtected(current, root);
  if (held) return held;
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
export function measure(paths: string[]): Map<string, number> {
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
