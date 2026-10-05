import { spawnSync } from "node:child_process";

interface GitResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }

// From `git rev-parse --local-env-vars`: variables that bind Git to one repository,
// such as those set while a hook runs. Git clears the same set when it enters another.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return env;
}

/**
 * Run Git in `cwd` without hooks, fsmonitor, credential prompts, or inherited
 * repository variables. Configured filter drivers such as Git LFS still run, as
 * they must for a correct checkout.
 */
export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function gitOutput(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  return result.stdout;
}

export function gitSucceeds(cwd: string, args: string[]): boolean { return git(cwd, args).status === 0; }
