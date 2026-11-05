/** Git bound to the repository it is asked about, whatever the caller's environment. Node built-ins only, like state-machines.ts. */
import { spawnSync } from "node:child_process";

// Kept in sync with space-cleanup/scripts/git.ts REPOSITORY_VARIABLES.
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

/** Kept in sync with space-cleanup/scripts/git.ts git, which also clears REPOSITORY_VARIABLES. */
export function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: gitEnvironment() });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}
