/** Git for the take-screenshots scripts, bound to the repository it is asked about. Node built-ins only, like artifacts.ts. */
import { spawnSync } from "node:child_process";

// Kept in sync with space-cleanup/scripts/git.ts REPOSITORY_VARIABLES.
// From `git rev-parse --local-env-vars`: variables that bind Git to one repository,
// such as those a hook sets, and that would override `cwd`.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/**
 * Git without hooks, prompts, or variables that bind it to another repository.
 * Kept in sync with space-cleanup/scripts/git.ts git, which also clears them.
 */
export function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim() };
}

export function gitValue(cwd: string, ...args: string[]): string | undefined {
  const result = git(cwd, ...args);
  return result.status === 0 && result.stdout ? result.stdout : undefined;
}

// Kept in sync with space-cleanup/scripts/targets.ts toplevel.
export function toplevel(cwd: string): string | undefined { return gitValue(cwd, "rev-parse", "--show-toplevel"); }
