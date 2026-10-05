import { spawnSync } from "node:child_process";
import type { Manifest } from "./manifest";

const LIMIT = 1000;

function key(repo: string): string { return repo.toLowerCase(); }
export function byName(left: string, right: string): number { return key(left).localeCompare(key(right)); }

/** List the owner's non-fork, unarchived repositories with the configured visibility. */
export function listOwnerRepos(discover: Manifest["discover"]): string[] {
  const args = ["repo", "list", discover.owner, "--source", "--no-archived", "--limit", String(LIMIT), "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"];
  if (discover.visibility !== "all") args.push("--visibility", discover.visibility);
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Could not run gh: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh repo list failed: ${result.stderr.trim()}`);
  const repos = result.stdout.split("\n").filter(Boolean);
  if (repos.length >= LIMIT) throw new Error(`gh repo list returned ${LIMIT} repositories; discovery may be truncated.`);
  return repos;
}

/** New repositories to manage, and managed ones discovery no longer finds (reported, not removed). */
export function planDiscovery(manifest: Manifest, discovered: string[]): { added: string[]; notDiscovered: string[] } {
  const excluded = new Set(manifest.discover.exclude.map(key));
  const managed = new Set(manifest.repos.map(key));
  const found = discovered.filter(repo => !excluded.has(key(repo)));
  const foundKeys = new Set(found.map(key));
  return {
    added: found.filter(repo => !managed.has(key(repo))).sort(byName),
    notDiscovered: manifest.repos.filter(repo => !foundKeys.has(key(repo))),
  };
}
