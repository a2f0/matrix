import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git";
import { object, parseObject } from "./packageJson";

/** One checkout as audit rules see it: its files, tracked paths, and manifests. */
export interface Checkout {
  readonly repo: string;
  readonly directory: string;
  read(file: string): string | undefined;
  exists(file: string): boolean;
  tracked(...pathspecs: string[]): string[];
  readonly packageJson?: Record<string, unknown>;
  /** The root package.json's scripts; empty without one. */
  readonly scripts: Record<string, unknown>;
  readonly agentToolJson?: Record<string, unknown>;
}

function isFile(file: string): boolean {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

export function openCheckout(repo: string, directory: string): Checkout {
  const read = (file: string) => (isFile(path.join(directory, file)) ? readFileSync(path.join(directory, file), "utf8") : undefined);
  const packageJson = parseObject(read("package.json"));
  return {
    repo,
    directory,
    read,
    exists: file => existsSync(path.join(directory, file)),
    tracked: (...pathspecs) => {
      const result = git(directory, ["ls-files", "-z", "--", ...pathspecs]);
      if (result.status !== 0) throw new Error(`git ls-files failed in ${repo}: ${result.stderr}`);
      return result.stdout.split("\0").filter(Boolean);
    },
    packageJson,
    scripts: object(packageJson?.scripts) ?? {},
    agentToolJson: parseObject(read("agent-tool.json")),
  };
}

/** Test files by name. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/;
/** Test files, and anything under a test or fixture directory. */
export const TEST_PATH = new RegExp(String.raw`(^|\/)(tests?|__tests__|fixtures?)\/|` + TEST_FILE.source);

/** Pathspecs for TypeScript and JavaScript sources under a glob prefix such as `**\/`. */
export function sourceGlobs(prefix: string): string[] {
  return ["ts", "mts", "js", "mjs"].map(extension => `:(glob)${prefix}*.${extension}`);
}

/** The text of each tracked GitHub Actions workflow. */
export function workflows(checkout: Checkout): string[] {
  return checkout.tracked(".github/workflows/*.yml", ".github/workflows/*.yaml").map(file => checkout.read(file) ?? "");
}

/** Pathspecs that exclude agent-tool's managed skills, and any other paths given, from a search. */
export function excludeManaged(checkout: Checkout, others: string[] = []): string[] {
  const managed = Object.keys(object(parseObject(checkout.read(".agent-tool-skills.json"))?.files) ?? {});
  return [...managed, ...others].map(file => `:(exclude,literal)${file}`);
}
