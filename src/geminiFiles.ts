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
 * `.gemini/` contents and `.env` files at any depth, outside `node_modules`, where no session
 * starts and whose search would take a while in a large checkout.
 */
const GEMINI_PATHSPECS = [":(glob)**/.gemini/**", ":(glob)**/.env", ":(exclude,glob)**/node_modules/**"];

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
export function envFilesAbove(root: string, home = homedir()): string[] {
  // Gemini starts from process.cwd(), a real path.
  const workspace = realpathSync(root);
  const directories = [path.join(workspace, "checkouts")];
  for (let directory = path.dirname(workspace); ; directory = path.dirname(directory)) {
    directories.push(directory);
    if (path.dirname(directory) === directory) break;
  }
  directories.push(home);
  const files = [...new Set(directories.flatMap(directory => [path.join(directory, ".gemini", ".env"), path.join(directory, ".env")]))];
  return files.filter(file => existsSync(file)).map(file => (file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file));
}

/**
 * Every file Gemini CLI would load that no review sees: untracked and ignored ones in the
 * workspace (outside `checkouts/`) and in each checkout, relative to the workspace, then the
 * `.env` files above them.
 */
export function geminiFiles(root: string, checkouts: string[], home = homedir()): string[] {
  const workspace = untrackedGeminiFiles(root, ["checkouts/**"]);
  const inside = checkouts.flatMap(directory => untrackedGeminiFiles(directory).map(file => path.relative(root, path.join(directory, file))));
  return [...workspace, ...inside, ...envFilesAbove(root, home)];
}
