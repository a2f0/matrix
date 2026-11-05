import { spawnSync } from "node:child_process";

/** Runs gh with arguments and returns its stdout; tests replace it. */
export type Gh = (args: string[]) => string;

/** Run gh without a terminal, throwing on failure. */
export function runGh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Could not run gh: ${result.error.message}`);
  if (result.status !== 0) {
    // gh can quote the file it was setting from, so a failed set reports no output.
    const detail = args[1] === "set" ? `exit ${result.status}; output withheld because it can contain values` : result.stderr.trim();
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${detail}).`);
  }
  return result.stdout;
}
