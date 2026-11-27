// Files Gemini CLI loads that no review sees. Gemini reads `GEMINI.md` beside `AGENTS.md` under the
// documented user settings, settings, policies, commands, and skills from `.gemini/` in the
// directory a session starts in, and the nearest `.gemini/.env` (in a
// trusted folder) or `.env` from there upward, then `~/.gemini/.env` or `~/.env`, into the
// environment of every shell command it runs (Gemini CLI 0.71.1, `findEnvFile`). The audit reads
// only tracked files, so health lists the untracked and ignored ones in the workspace and each
// checkout, and the `.env` files above them, by name only. Removing one stays a person's decision.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gitUntrimmed } from "./git";

/**
 * Installed and build trees, whose ignored files are skipped, since no session starts there and
 * their search would take a while in a large checkout: packages, Python environments, Ruby's
 * `vendor`, CocoaPods, Xcode's DerivedData, Gradle, Cargo's `target`, Expo, Dart, Terraform,
 * Wrangler, Python caches, and build, test, cache, and framework output.
 */
const BUILD_TREES = [
  "node_modules",
  ".yarn",
  ".venv",
  "venv",
  "env",
  ".direnv",
  "vendor",
  "Pods",
  "DerivedData",
  ".build",
  ".cxx",
  ".gradle",
  "target",
  ".expo",
  ".dart_tool",
  ".terraform",
  ".wrangler",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "build",
  "dist",
  "out",
  "coverage",
  "playwright-report",
  "storybook-static",
  "test-results",
  ".cache",
  ".parcel-cache",
  ".nx",
  ".next",
  ".astro",
  ".nuxt",
  ".vercel",
  ".output",
  ".svelte-kit",
  ".turbo",
];
/**
 * `GEMINI.md`, which the documented user settings load beside `AGENTS.md`, `.gemini/` contents,
 * and `.env` files at any depth, in any case, since Gemini opens them by name and macOS's default
 * file system matches `.ENV` or `gemini.md` too.
 */
const GEMINI_PATHSPECS = [":(glob,icase)**/GEMINI.md", ":(glob,icase)**/.gemini/**", ":(glob,icase)**/.env"];

/** How long one listing, and the whole scan, may take before what they did not list is reported as unscanned. */
const LIST_TIMEOUT_MS = 30_000;
const SCAN_BUDGET_MS = 60_000;

/**
 * Untracked and ignored files under `directory` that Gemini CLI would load, relative to it, outside
 * the directories `skip` names as gitignore patterns, such as `/checkouts/`. Untracked files Git
 * does not ignore are listed everywhere, since a folder named `build` can hold source; ignored ones
 * outside BUILD_TREES. Both use `-x` patterns, which Git does not descend into, unlike exclude
 * pathspecs; without `--exclude-standard`, the second pass reads no `.gitignore`.
 */
export function untrackedGeminiFiles(directory: string, skip: string[] = [], deadline = Date.now() + 2 * LIST_TIMEOUT_MS): string[] {
  const unignored = listFiles(directory, ["--others", "--exclude-standard", ...excluding(skip)], deadline);
  const outsideTrees = listFiles(directory, ["--others", ...excluding([...BUILD_TREES.map(tree => `${tree}/`), ...skip])], deadline);
  return [...new Set([...unignored, ...outsideTrees])].sort();
}

function excluding(patterns: string[]): string[] {
  return patterns.flatMap(pattern => ["-x", pattern]);
}

/** Tracked files under `directory` that Gemini CLI would load, which only review sees, relative to it. */
function trackedGeminiFiles(directory: string, deadline = Date.now() + LIST_TIMEOUT_MS): string[] {
  return listFiles(directory, ["--cached"], deadline);
}

/** One listing, through the hardened Git, so a scanned folder's fsmonitor and hooks never run, within its limit and `deadline`. */
function listFiles(directory: string, options: string[], deadline: number): string[] {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`no time left to list ${directory}`);
  const result = gitUntrimmed(directory, ["ls-files", "-z", ...options, "--", ...GEMINI_PATHSPECS], Math.min(LIST_TIMEOUT_MS, remaining));
  if (result.status !== 0) throw new Error(`git ls-files failed in ${directory}: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * `.gemini/.env` and `.env` files that Gemini's upward search reaches from a checkout before the
 * workspace's own: the checkouts folder, relative to the workspace, then each parent of the
 * workspace and the home fallbacks, nearest first, as `~/...` under the home directory. Gemini
 * loads only the nearest one it finds, but removing that one exposes the next.
 */
export function envFilesAbove(root: string, homeDirectory = homedir()): string[] {
  // Gemini starts from process.cwd(), a real path; a linked home resolves too, so its files show once, as `~/...`.
  const workspace = realpathSync(root);
  const home = existsSync(homeDirectory) ? realpathSync(homeDirectory) : homeDirectory;
  const directories = [path.join(workspace, "checkouts")];
  for (let directory = path.dirname(workspace); ; directory = path.dirname(directory)) {
    directories.push(directory);
    if (path.dirname(directory) === directory) break;
  }
  directories.push(home);
  const files = [...new Set(directories.flatMap(directory => [path.join(directory, ".gemini", ".env"), path.join(directory, ".env")]))];
  const name = (file: string) =>
    file.startsWith(`${workspace}/`) ? path.relative(workspace, file) : file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
  return files.filter(file => existsSync(file)).map(name);
}

/**
 * The checkout folders a scan covers: managed ones, whose tracked files the audit checks, and the
 * rest, such as another clone under `checkouts/`, whose tracked files nothing else reports.
 */
export interface CheckoutFolders {
  readonly managed: readonly string[];
  readonly unmanaged: readonly string[];
}

/** What a scan found, and the checkouts, relative to the workspace, that Git could not list. */
export interface GeminiScan {
  readonly files: string[];
  readonly unscanned: string[];
}

/**
 * Every file Gemini CLI would load that no review sees: untracked and ignored ones in the
 * workspace (outside `checkouts/`) and in each checkout, and tracked ones in an unmanaged
 * checkout, which no audit covers, relative to the workspace, then the `.env` files above them. A folder Git cannot list, the workspace as `.`, is reported, not
 * allowed to hide the rest, and so is every folder the scan's `budget` in milliseconds leaves and
 * every checkout that is a link or sits in a linked folder, which the scan does not follow.
 */
export function geminiFiles(root: string, folders: CheckoutFolders, home = homedir(), budget = SCAN_BUDGET_MS): GeminiScan {
  const deadline = Date.now() + budget;
  const files: string[] = [];
  const unscanned: string[] = [];
  const scans = [
    { directory: root, skip: ["/checkouts/"], tracked: false },
    ...folders.managed.map(directory => ({ directory, skip: [], tracked: false })),
    ...folders.unmanaged.map(directory => ({ directory, skip: [], tracked: true })),
  ];
  for (const { directory, skip, tracked } of scans) {
    if (directory !== root && !ownFolder(directory)) {
      unscanned.push(path.relative(root, directory));
      continue;
    }
    try {
      const found = [...untrackedGeminiFiles(directory, skip, deadline), ...(tracked ? trackedGeminiFiles(directory, deadline) : [])];
      files.push(...[...new Set(found)].sort().map(file => path.relative(root, path.join(directory, file))));
    } catch {
      unscanned.push(path.relative(root, directory) || ".");
    }
  }
  return { files: [...files, ...envFilesAbove(root, home)], unscanned };
}

/** A real folder in a real parent, neither a link nor inside a linked folder such as a linked `checkouts/`. */
function ownFolder(directory: string): boolean {
  const real = (entry: string) => lstatSync(entry, { throwIfNoEntry: false })?.isDirectory() === true;
  return real(path.dirname(directory)) && real(directory);
}
