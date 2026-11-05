#!/usr/bin/env bun
/**
 * Lists files that look like they hold implicit state machines: several
 * lifecycle booleans toggled together, or a status string assigned many
 * values from many places. Read-only; it ranks files for a person or agent to
 * read, and never edits anything.
 *
 * From a matrix workspace it covers the workspace and every checkout, or the
 * named checkouts; elsewhere, the repository holding the working directory.
 * Uses only Node built-ins so it runs by path from any repository.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git";
import { type FileReport, language, scanFile } from "./scan";
import { resolveTargets } from "./targets";

export interface Options {
  readonly names: string[];
  readonly json: boolean;
  readonly limit: number;
  readonly minScore: number;
}

export interface RepoReport {
  readonly name: string;
  readonly root: string;
  readonly scanned: number;
  readonly files: FileReport[];
  /** Candidates beyond --limit, so a reader knows the list was cut. */
  readonly more: number;
  readonly error?: string;
}

const USAGE = `Usage: state-machines [checkout-or-path...] [--limit N] [--min-score N] [--json]

Ranks tracked source files by signals of implicit state machines: lifecycle
booleans toggled together (isLoading + hasError) and status strings assigned
many values from many places. Read-only. From a matrix workspace it covers the
workspace and every checkout, or the named checkouts; elsewhere, the repository
holding the working directory.

  --limit N       files listed per repository (default 25; 0 lists all)
  --min-score N   skip files scoring below N (default 4)
  --json          JSON output for agents`;

function count(flag: string, value: string | undefined): number {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag} must be a non-negative integer.`);
  return number;
}

export function parseOptions(argv: string[]): Options {
  const names: string[] = [];
  let json = false, limit = 25, minScore = 4;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--limit") limit = count(arg, argv[++index]);
    else if (arg === "--min-score") minScore = count(arg, argv[++index]);
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    else names.push(arg);
  }
  return { names, json, limit, minScore };
}

/** Scans the files git tracks in one repository (submodules and nested checkouts excluded). */
export function scanRepository(name: string, root: string, options: Pick<Options, "limit" | "minScore">): RepoReport {
  const listed = git(root, ["ls-files", "-z", "--cached"]);
  if (!listed.ok) return { name, root, scanned: 0, files: [], more: 0, error: "git ls-files failed" };
  const files: FileReport[] = [];
  let scanned = 0;
  for (const file of listed.stdout.split("\0")) {
    // checkouts/ is gitignored in a workspace, so a checkout's files are never
    // listed under the workspace; each checkout is scanned as its own target.
    if (!file || !language(file)) continue;
    let text: string;
    try { text = readFileSync(path.join(root, file), "utf8"); } catch { continue; }
    scanned++;
    const report = scanFile(file, text);
    if (report && report.score >= options.minScore) files.push(report);
  }
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const shown = options.limit === 0 ? files : files.slice(0, options.limit);
  return { name, root, scanned, files: shown, more: files.length - shown.length };
}

function describe(report: FileReport): string[] {
  return report.signals.map(signal => {
    const lines = signal.lines.slice(0, 8).join(",") + (signal.lines.length > 8 ? ",..." : "");
    return signal.kind === "flags"
      ? `    flags  ${signal.names.join(", ")}  (lines ${lines})`
      : `    status ${signal.names[0]} = ${signal.values!.join(" | ")}  (lines ${lines})`;
  });
}

export function render(reports: RepoReport[]): string {
  const out: string[] = [];
  for (const repo of reports) {
    out.push(`${repo.name} (${repo.root}): ${repo.error ?? `${repo.files.length + repo.more} candidate files of ${repo.scanned} scanned`}`);
    for (const file of repo.files) out.push(`  ${file.score.toString().padStart(3)}  ${file.path}`, ...describe(file));
    if (repo.more) out.push(`  ... ${repo.more} more (raise --limit)`);
  }
  out.push("", "Candidates are leads, not findings: read each file and apply the skill's criteria before changing it.");
  return out.join("\n");
}

export function main(argv: string[], cwd = process.cwd(), print: (text: string) => void = console.log): number {
  if (argv.includes("--help") || argv.includes("-h")) { print(USAGE); return 0; }
  let options: Options;
  try { options = parseOptions(argv); } catch (error) {
    print(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  let targets;
  try { targets = resolveTargets(cwd, options.names).targets; } catch (error) {
    print((error as Error).message);
    return 2;
  }
  const reports = targets.map(target => scanRepository(target.name, target.root, options));
  print(options.json ? JSON.stringify({ repos: reports }, null, 2) : render(reports));
  return reports.some(report => report.error) ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
