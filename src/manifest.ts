import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHECKOUTS = "checkouts";
const PROTOCOLS = ["ssh", "https"] as const;
const VISIBILITIES = ["public", "private", "all"] as const;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export interface Manifest {
  schemaVersion: 1;
  protocol: (typeof PROTOCOLS)[number];
  discover: { owner: string; visibility: (typeof VISIBILITIES)[number]; exclude: string[] };
  repos: string[];
}

function invalid(field: string, detail = "is invalid"): never {
  throw new Error(`matrix.json: ${field} ${detail}.`);
}

function record(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field, "must be an object");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) invalid(`${field}.${key}`, "is not a known setting");
  for (const key of allowed) if (!(key in object)) invalid(`${field}.${key}`, "is required");
  return object;
}

function repoList(value: unknown, field: string, uniqueNames: boolean): string[] {
  if (!Array.isArray(value)) invalid(field, "must be an array");
  const seen = new Set<string>();
  return value.map((repo, index) => {
    if (typeof repo !== "string" || !REPO.test(repo) || [".", ".."].includes(repoName(repo))) invalid(`${field}[${index}]`, "must be owner/name");
    const name = repoName(repo).toLowerCase();
    if (uniqueNames && seen.has(name)) invalid(`${field}[${index}]`, `reuses checkout name '${repoName(repo)}'`);
    seen.add(name);
    return repo;
  });
}

export function parseManifest(source: string): Manifest {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { invalid("manifest", `is not JSON (${error instanceof Error ? error.message : String(error)})`); }
  const input = record(value, "manifest", ["schemaVersion", "protocol", "discover", "repos"]);
  if (input.schemaVersion !== 1) invalid("schemaVersion", "must be 1");
  if (!PROTOCOLS.includes(input.protocol as Manifest["protocol"])) invalid("protocol", `must be one of ${PROTOCOLS.join(", ")}`);
  const discover = record(input.discover, "discover", ["owner", "visibility", "exclude"]);
  if (typeof discover.owner !== "string" || !/^[A-Za-z0-9-]+$/.test(discover.owner)) invalid("discover.owner");
  if (!VISIBILITIES.includes(discover.visibility as Manifest["discover"]["visibility"])) invalid("discover.visibility", `must be one of ${VISIBILITIES.join(", ")}`);
  return {
    schemaVersion: 1,
    protocol: input.protocol as Manifest["protocol"],
    discover: {
      owner: discover.owner,
      visibility: discover.visibility as Manifest["discover"]["visibility"],
      exclude: repoList(discover.exclude, "discover.exclude", false),
    },
    repos: repoList(input.repos, "repos", true),
  };
}

export function manifestPath(root: string): string { return path.join(root, "matrix.json"); }
export function loadManifest(root: string): Manifest { return parseManifest(readFileSync(manifestPath(root), "utf8")); }
export function saveManifest(root: string, manifest: Manifest): void {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function repoName(repo: string): string { return repo.slice(repo.indexOf("/") + 1); }
export function checkoutPath(root: string, repo: string): string { return path.join(root, CHECKOUTS, repoName(repo)); }

export function cloneUrl(repo: string, protocol: Manifest["protocol"]): string {
  return protocol === "ssh" ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
}

/** Normalize the GitHub remote URL forms Git accepts to owner/name. */
export function parseGitHubRepo(url: string): string | undefined {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match?.[1];
}

/** Select managed repos by owner/name or checkout name; no names selects all. */
export function selectRepos(manifest: Manifest, names: string[]): string[] {
  if (names.length === 0) return manifest.repos;
  return names.map(name => {
    const key = name.toLowerCase();
    const repo = manifest.repos.find(candidate => candidate.toLowerCase() === key || repoName(candidate).toLowerCase() === key);
    if (!repo) throw new Error(`'${name}' is not a managed repository in matrix.json.`);
    return repo;
  });
}
