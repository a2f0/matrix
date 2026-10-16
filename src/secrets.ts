import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoName } from "./manifest";

const KINDS = { secret: "secrets.env", variable: "variables.env" } as const;
type Kind = keyof typeof KINDS;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export type Gh = (args: string[]) => string;

export interface CiFile {
  /** Repository settings this file manages; set on apply, never deleted. */
  deploy: string[];
  /** Settings already on GitHub that this file does not name; left untouched. */
  unmanaged: string[];
}

export interface DeployResult {
  repo: string;
  path: string;
  skipped?: string;
  secrets?: CiFile;
  variables?: CiFile;
  applied: boolean;
}

/** The workspace's secrets folder: MATRIX_SECRETS_DIR, or matrix-secrets beside the matrix repository. */
export function secretsRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MATRIX_SECRETS_DIR || path.join(root, "..", "matrix-secrets"));
}

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

/** Return true when text holds the unescaped quote that closes a value. */
function closes(text: string, quote: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (quote === "\"" && text[index] === "\\") index++;
    else if (text[index] === quote) return true;
  }
  return false;
}

/** Names a dotenv file assigns, in order. Values, including quoted multi-line ones, are skipped unread. */
export function dotenvNames(source: string, file: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) throw new Error(`${file}:${index + 1} is not a NAME=value line.`);
    const [, name, value] = match as unknown as [string, string, string];
    if (/^GITHUB_/i.test(name)) throw new Error(`${file}:${index + 1}: GitHub reserves names that start with GITHUB_.`);
    // GitHub names are case-insensitive, so TOKEN and token are one setting.
    if (seen.has(name.toUpperCase())) throw new Error(`${file}:${index + 1}: ${name} is assigned twice.`);
    seen.add(name.toUpperCase());
    names.push(name);
    const quote = value[0];
    if (quote !== "\"" && quote !== "'") continue;
    let rest = value.slice(1);
    const start = index;
    while (!closes(rest, quote)) {
      if (++index >= lines.length) throw new Error(`${file}:${start + 1}: ${name} has an unterminated quoted value.`);
      rest = lines[index]!;
    }
  }
  return names;
}

function remoteNames(gh: Gh, kind: Kind, repo: string): string[] {
  return gh([kind, "list", "--repo", repo, "--json", "name", "--jq", ".[].name"]).split("\n").filter(Boolean);
}

/** Compare a repository's ci folder with GitHub; with apply, set every named value from its file. */
export function deploySecrets(secrets: string, repo: string, apply: boolean, gh: Gh = runGh): DeployResult {
  const directory = path.join(secrets, repoName(repo), "ci");
  if (!existsSync(directory)) return { repo, path: directory, skipped: "no ci folder", applied: false };
  const files = (Object.keys(KINDS) as Kind[]).map(kind => {
    const file = path.join(directory, KINDS[kind]);
    const names = existsSync(file) ? dotenvNames(readFileSync(file, "utf8"), file) : [];
    const listed = new Set(names.map(name => name.toUpperCase()));
    return { kind, file, plan: { deploy: names, unmanaged: remoteNames(gh, kind, repo).filter(name => !listed.has(name.toUpperCase())) } };
  });
  if (apply) {
    // gh reads the values from the file itself, so they never pass through this process.
    for (const { kind, file, plan } of files) if (plan.deploy.length > 0) gh([kind, "set", "--repo", repo, "--env-file", file]);
  }
  const [secret, variable] = files;
  return { repo, path: directory, secrets: secret!.plan, variables: variable!.plan, applied: apply };
}
