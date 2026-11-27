// Files Gemini CLI loads that no review sees. Gemini reads settings, policies, commands, and skills
// from `.gemini/` in the directory a session starts in, and the nearest `.gemini/.env` (in a
// trusted folder) or `.env` from there upward, then `~/.gemini/.env` or `~/.env`, into the
// environment of every shell command it runs (Gemini CLI 0.71.1, `findEnvFile`). The audit reads
// only tracked files, so health lists the untracked and ignored ones in the workspace and each
// checkout, and the `.env` files above them, by name only. Removing one stays a person's decision.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * `.gemini/` contents and `.env` files at any depth, outside installed and generated trees such as
 * `node_modules`, a Python `.venv`, CocoaPods, Xcode's DerivedData, and Next.js output, where no
 * session starts and whose search would take a while in a large checkout.
 */
const GEMINI_PATHSPECS = [
  ":(glob)**/.gemini/**",
  ":(glob)**/.env",
  ...["node_modules", ".venv", "Pods", "DerivedData", ".next"].map(directory => `:(exclude,glob)**/${directory}/**`),
];

/** Untracked and ignored files under `directory` that Gemini CLI would load, relative to it; `exclude` names more pathspecs to skip. */
export function untrackedGeminiFiles(directory: string, exclude: string[] = []): string[] {
  const result = spawnSync("git", ["ls-files", "--others", "-z", "--", ...GEMINI_PATHSPECS, ...exclude.map(pattern => `:(exclude)${pattern}`)], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git ls-files could not run in ${directory}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ls-files failed in ${directory}: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean).sort();
}

/**
 * `.gemini/.env` and `.env` files that Gemini's upward search reaches from a checkout before the
 * workspace's own: the checkouts folder, each parent of the workspace, and the home fallbacks,
 * nearest first, as `~/...` under the home directory. Gemini loads only the nearest one it finds,
 * but removing that one exposes the next.
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
  return files.filter(file => existsSync(file)).map(file => (file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file));
}

/** What a scan found, and the checkouts, relative to the workspace, that Git could not list. */
export interface GeminiScan {
  readonly files: string[];
  readonly unscanned: string[];
}

/**
 * Every file Gemini CLI would load that no review sees: untracked and ignored ones in the
 * workspace (outside `checkouts/`) and in each checkout, relative to the workspace, then the
 * `.env` files above them. A checkout Git cannot list is reported, not allowed to hide the rest.
 */
export function geminiFiles(root: string, checkouts: string[], home = homedir()): GeminiScan {
  const files = untrackedGeminiFiles(root, ["checkouts/**"]);
  const unscanned: string[] = [];
  for (const directory of checkouts) {
    try {
      files.push(...untrackedGeminiFiles(directory).map(file => path.relative(root, path.join(directory, file))));
    } catch {
      unscanned.push(path.relative(root, directory));
    }
  }
  return { files: [...files, ...envFilesAbove(root, home)], unscanned };
}
