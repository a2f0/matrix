import { spawnSync } from "node:child_process";

interface GitResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/** Run Git without checkout hooks or credential prompts; workspace upkeep never runs repository code. */
export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
