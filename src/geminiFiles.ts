// Files Gemini CLI loads that no review sees. Gemini reads `GEMINI.md` beside `AGENTS.md` under the
// documented user settings, settings, policies, commands, and skills from `.gemini/` in the
// directory a session starts in, and the nearest `.gemini/.env` (in a
// trusted folder) or `.env` from there upward, then `~/.gemini/.env` or `~/.env`, into the
// environment of every shell command it runs (Gemini CLI 0.71.1, `findEnvFile`). The audit reads
// only tracked files, so health lists the untracked and ignored ones in the workspace and each
// checkout, and the `.env` files above them, by name only. Removing one stays a person's decision.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gitUntrimmed } from "./git";

/**
 * Installed and build trees, whose ignored files are skipped, since no session starts there and
 * their search would take a while in a large checkout: packages, a Python `.venv`, Ruby's `vendor`, CocoaPods, Xcode's DerivedData,
 * Gradle, Cargo's `target`, Expo, Dart, Terraform, Wrangler, Python caches, and build,
 * test-coverage, cache, and framework output.
 */
const BUILD_TREES = [
  "node_modules",
  ".venv",
  "vendor",
  "Pods",
  "DerivedData",
  ".gradle",
  "target",
  ".expo",
  ".dart_tool",
  ".terraform",
  ".wrangler",
  "__pycache__",
  ".pytest_cache",
  "build",
  "dist",
  "out",
  "coverage",
  ".cache",
  ".next",
  ".astro",
  ".svelte-kit",
  ".turbo",
];
/** `GEMINI.md`, which the documented user settings load beside `AGENTS.md`, `.gemini/` contents, and `.env` files at any depth. */
const GEMINI_PATHSPECS = [":(glob)**/GEMINI.md", ":(glob)**/.gemini/**", ":(glob)**/.env"];

/** How long one listing may take before its checkout is reported as unscanned. */
const LIST_TIMEOUT_MS = 60_000;

/**
 * Untracked and ignored files under `directory` that Gemini CLI would load, relative to it, outside
 * the directories `skip` names as gitignore patterns, such as `/checkouts/`. Untracked files Git
 * does not ignore are listed everywhere, since a folder named `build` can hold source; ignored ones
 * outside BUILD_TREES. Both use `-x` patterns, which Git does not descend into, unlike exclude
 * pathspecs; without `--exclude-standard`, the second pass reads no `.gitignore`.
 */
export function untrackedGeminiFiles(directory: string, skip: string[] = []): string[] {
  const unignored = listFiles(directory, ["--others", "--exclude-standard", ...excluding(skip)]);
  const outsideTrees = listFiles(directory, ["--others", ...excluding([...BUILD_TREES.map(tree => `${tree}/`), ...skip])]);
  return [...new Set([...unignored, ...outsideTrees])].sort();
}

function excluding(patterns: string[]): string[] {
  return patterns.flatMap(pattern => ["-x", pattern]);
}

/** One listing, through the hardened Git, so a scanned folder's fsmonitor and hooks never run. */
function listFiles(directory: string, options: string[]): string[] {
  const result = gitUntrimmed(directory, ["ls-files", "-z", ...options, "--", ...GEMINI_PATHSPECS], LIST_TIMEOUT_MS);
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

/** What a scan found, and the checkouts, relative to the workspace, that Git could not list. */
export interface GeminiScan {
  readonly files: string[];
  readonly unscanned: string[];
}

/**
 * Every file Gemini CLI would load that no review sees: untracked and ignored ones in the
 * workspace (outside `checkouts/`) and in each checkout, relative to the workspace, then the
 * `.env` files above them. A folder Git cannot list, the workspace as `.`, is reported, not
 * allowed to hide the rest.
 */
export function geminiFiles(root: string, checkouts: string[], home = homedir()): GeminiScan {
  const files: string[] = [];
  const unscanned: string[] = [];
  for (const [directory, skip] of [[root, ["/checkouts/"]] as const, ...checkouts.map(directory => [directory, []] as const)]) {
    try {
      files.push(...untrackedGeminiFiles(directory, [...skip]).map(file => path.relative(root, path.join(directory, file))));
    } catch {
      unscanned.push(path.relative(root, directory) || ".");
    }
  }
  return { files: [...files, ...envFilesAbove(root, home)], unscanned };
}
