// User-wide skills: a repository lists them under `skills.user` in its agent-tool.json, and
// agent-tool's `skills link` links each one into ~/.agents/skills and into every Claude Code
// configuration directory's skills/ (~/.claude, CLAUDE_CONFIG_DIR, and other ~/.claude*
// directories such as ~/.claude2). `matrix sync` applies the links for the workspace and each
// checkout with the workspace's pinned agent-tool, and `matrix health` reports what
// `skills check-links` still finds, so no one links a skill by hand.

import { homedir } from "node:os";
import { object } from "./packageJson";

const STATUSES = ["create", "repair", "unchanged", "kept", "conflict"] as const;
const RESULTS = ["written", "failed"] as const;

/** One entry of agent-tool's `skills link` or `skills check-links` report (0.1.67+), as far as matrix reads it. */
export interface UserSkillLink {
  readonly skill: string;
  readonly path: string;
  readonly target: string;
  /** `kept` is a link to the same skill in another clone, which stays. */
  readonly status: (typeof STATUSES)[number];
  /** After `--apply`, for each link it tried to write. */
  readonly result?: (typeof RESULTS)[number];
  readonly error?: string;
}

/** One repository's links, or why agent-tool could not report them. */
export type UserSkillReport = { readonly links: UserSkillLink[] } | { readonly error: string };

/** The repository a report came from, `workspace` for matrix itself. */
export interface RepoUserSkills {
  readonly repo: string;
  readonly report: UserSkillReport;
}

/** What `sync` linked, and what still needs a person. */
export interface UserSkillSync {
  readonly linked: string[];
  readonly problems: string[];
}

/** What `health` found: links to create or repair, names a file or another skill holds, and repositories it could not read. */
export interface UserSkillsHealth {
  readonly missing: string[];
  readonly conflicts: string[];
  readonly unreadable: string[];
}

function isLink(value: unknown): value is UserSkillLink {
  const entry = object(value);
  return (
    typeof entry?.skill === "string" &&
    typeof entry.path === "string" &&
    typeof entry.target === "string" &&
    // A status or result a later agent-tool adds makes the report unreadable rather than silently fine.
    (STATUSES as readonly unknown[]).includes(entry.status) &&
    (entry.result === undefined || (RESULTS as readonly unknown[]).includes(entry.result)) &&
    (entry.error === undefined || typeof entry.error === "string")
  );
}

/** The `changes` of a `skills link` or `skills check-links` report; undefined for any other output. */
export function parseUserSkillReport(stdout: string): UserSkillLink[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const changes = object(report)?.changes;
  return Array.isArray(changes) && changes.every(isLink) ? changes : undefined;
}

/** A path under the home directory as `~/...`, so reports stay short and name no account. */
export function tilde(file: string, home = homedir()): string {
  return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

/** Each distinct value once, in first-seen order; two repositories can report the same link. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** A conflict names what holds the path, so the person clearing it knows what to look at. */
function conflict(link: UserSkillLink, home: string): string {
  return `${tilde(link.path, home)} (held by something other than a link to ${link.skill})`;
}

/** Every link the reports hold, and `<repo>: <reason>` for each report agent-tool could not produce. */
function split(reports: RepoUserSkills[]): { links: UserSkillLink[]; errors: string[] } {
  return {
    links: reports.flatMap(({ report }) => ("links" in report ? report.links : [])),
    errors: reports.flatMap(({ repo, report }) => ("error" in report ? [`${repo}: ${report.error}`] : [])),
  };
}

/** What sync could not do about one link: a failed write, a conflict, or a link left unwritten because a conflict blocked the repository's apply. */
function syncProblem(link: UserSkillLink, home: string): string[] {
  if (link.result === "failed") return [`${tilde(link.path, home)}: ${link.error ?? "could not be written"}`];
  if (link.status === "conflict") return [conflict(link, home)];
  if ((link.status === "create" || link.status === "repair") && link.result === undefined)
    return [`${tilde(link.path, home)}: not linked, since a conflict in the same repository stopped every write`];
  return [];
}

/** Summarize `skills link --apply` across repositories: links written, then what each repository could not link, then unreadable reports. */
export function summarizeSync(reports: RepoUserSkills[], home = homedir()): UserSkillSync {
  const { links, errors } = split(reports);
  const linked = links.filter(link => link.result === "written").map(link => `${tilde(link.path, home)} -> ${tilde(link.target, home)}`);
  const problems = links.flatMap(link => syncProblem(link, home));
  return { linked: unique(linked), problems: unique([...problems, ...errors]) };
}

/** Summarize `skills check-links` across repositories for health. */
export function summarizeCheck(reports: RepoUserSkills[], home = homedir()): UserSkillsHealth {
  const { links, errors } = split(reports);
  return {
    missing: unique(links.filter(link => link.status === "create" || link.status === "repair").map(link => tilde(link.path, home))),
    conflicts: unique(links.filter(link => link.status === "conflict").map(link => conflict(link, home))),
    unreadable: errors,
  };
}
