import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CheckoutStatus } from "./checkouts";
import { git } from "./git";
import { checkoutPath } from "./manifest";
import { hasLink, hasSection, headings, nonBlankLines, section } from "./markdown";

const AGENT_TOOL = "@a2f0/agent-tool";
/**
 * The oldest pin the sweep rules support: 0.1.21 provides `branch create`,
 * `branch push`, `pr checks --wait`, and `repo cleanup` with local pruning, so
 * guidance no longer carries fallbacks for older pins.
 */
export const MINIMUM_AGENT_TOOL = "0.1.21";
/**
 * How long a pin may trail a newer agent-tool release before the remote audit
 * fails. agent-tool can release several times a day, and each pin sweep runs
 * every checkout's validation, so upgrades batch weekly instead of chasing
 * every release.
 */
export const AGENT_TOOL_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export type Outcome = { readonly status: "pass" } | { readonly status: "fail" | "skip"; readonly detail: string };

/** One checkout as rules see it: its files, tracked paths, and package manifest. */
export interface Checkout {
  readonly repo: string;
  readonly directory: string;
  read(file: string): string | undefined;
  exists(file: string): boolean;
  tracked(...pathspecs: string[]): string[];
  readonly packageJson?: Record<string, unknown>;
}

export interface AuditContext {
  /** When each published release of a package appeared, by exact version; only remote rules call it. */
  releases(name: string): Record<string, string>;
  /** The time release ages are measured against; defaults to now. */
  readonly now?: Date;
}

export interface Rule {
  readonly id: string;
  readonly summary: string;
  /** The guidance that defines the standard. */
  readonly source: string;
  /** Needs the network; runs only with --remote. */
  readonly remote?: true;
  check(checkout: Checkout, context: AuditContext): Outcome;
}

const pass: Outcome = { status: "pass" };
const fail = (detail: string): Outcome => ({ status: "fail", detail });
const skip = (detail: string): Outcome => ({ status: "skip", detail });
const problems = (list: string[]): Outcome => (list.length === 0 ? pass : fail(list.join("; ")));

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function json(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  try { return object(JSON.parse(source)); } catch { return undefined; }
}

function dependency(manifest: Record<string, unknown> | undefined, name: string): string | undefined {
  for (const field of ["devDependencies", "dependencies"]) {
    const version = object(manifest?.[field])?.[name];
    if (typeof version === "string") return version;
  }
  return undefined;
}

/** agent-tool publishes itself; its checkout runs the source CLI instead of a pin. */
function isProducer(checkout: Checkout): boolean { return checkout.packageJson?.name === AGENT_TOOL; }

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

/**
 * Guidance that a shared command replaced. Matrix stopped carrying these
 * fallbacks once every checkout pinned MINIMUM_AGENT_TOOL; a hit in a
 * checkout's own Markdown is stale guidance. Patterns are POSIX extended
 * regular expressions for `git grep -E`.
 */
export const SUPERSEDED: ReadonlyArray<{ id: string; pattern: string; replacement: string; exempt?: RegExp }> = [
  { id: "review-reply-endpoint", pattern: "pulls/([^/[:space:]`]+/)?comments/[^/[:space:]`]+/replies", replacement: "agent-tool pr threads reply" },
  { id: "untracked-branch-switch", pattern: "git switch --no-track", replacement: "agent-tool branch create" },
  { id: "pr-checks-watch", pattern: "gh pr checks[^`]*--watch", replacement: "agent-tool pr checks --wait" },
  { id: "push-head-upstream", pattern: "git push (-u|--set-upstream) origin HEAD", replacement: "agent-tool branch push <reviewed-head> --remote origin" },
  // A leased deletion is the stronger cleanup some checkouts require, not the hook-running push it replaced.
  { id: "push-delete", pattern: "git push [^`]*--delete", replacement: "agent-tool repo cleanup", exempt: /--force-with-lease/ },
];

function managedSkills(checkout: Checkout): string[] {
  return Object.keys(object(json(checkout.read(".agent-tool-skills.json"))?.files) ?? {});
}

const ONBOARDING = "AGENTS.md#onboarding-a-repository";

export const RULES: readonly Rule[] = [
  {
    id: "agents-md",
    summary: "AGENTS.md holds the repository's agent guidance",
    source: ONBOARDING,
    check: checkout => {
      if (checkout.tracked("AGENTS.md").length === 0) return fail("no tracked AGENTS.md at the root");
      return checkout.read("AGENTS.md") === undefined ? fail("AGENTS.md is tracked but missing from the working tree") : pass;
    },
  },
  {
    id: "no-claude-md",
    summary: "No CLAUDE.md; Claude Code reads AGENTS.md when none exists",
    source: ONBOARDING,
    check: checkout => {
      const files = checkout.tracked(":(glob)**/CLAUDE.md");
      return files.length === 0 ? pass : fail(`tracked ${files.join(", ")}`);
    },
  },
  {
    id: "ds-store-ignored",
    summary: "The root .gitignore lists .DS_Store as a plain pattern",
    source: ONBOARDING,
    check: checkout => {
      const lines = (checkout.read(".gitignore") ?? "").split("\n").map(line => line.trim());
      return lines.includes(".DS_Store") || lines.includes("**/.DS_Store") ? pass : fail("root .gitignore does not list .DS_Store");
    },
  },
  {
    id: "agent-tool-pin",
    summary: `@a2f0/agent-tool is pinned exactly, at ${MINIMUM_AGENT_TOOL} or newer, with agent-tool.json and managed skills`,
    source: ONBOARDING,
    check: checkout => {
      if (isProducer(checkout)) return skip("publishes agent-tool and runs its source CLI");
      const found: string[] = [];
      const pin = dependency(checkout.packageJson, AGENT_TOOL);
      if (pin === undefined) found.push("package.json does not depend on @a2f0/agent-tool");
      else if (!EXACT_VERSION.test(pin)) found.push(`pin '${pin}' is not an exact version`);
      else if (compareVersions(pin, MINIMUM_AGENT_TOOL) < 0) found.push(`pins ${pin}, older than ${MINIMUM_AGENT_TOOL}`);
      if (!checkout.exists("agent-tool.json")) found.push("no agent-tool.json");
      if (!checkout.exists(".agent-tool-skills.json")) found.push("no .agent-tool-skills.json; run agent-tool skills install --apply");
      return problems(found);
    },
  },
  {
    id: "agent-tool-latest",
    summary: `The agent-tool pin has trailed newer releases for under ${AGENT_TOOL_GRACE_DAYS} days`,
    source: "docs/dependency-upgrades.md",
    remote: true,
    check: (checkout, context) => {
      if (isProducer(checkout)) return skip("publishes agent-tool");
      const pin = dependency(checkout.packageJson, AGENT_TOOL);
      if (pin === undefined) return skip("does not pin agent-tool");
      if (!EXACT_VERSION.test(pin)) return skip(`pin '${pin}' is not exact; see agent-tool-pin`);
      const releases = context.releases(AGENT_TOOL);
      if (!(pin in releases)) return fail(`pins ${pin}, which the registry has not published`);
      const newer = Object.keys(releases).filter(version => EXACT_VERSION.test(version) && compareVersions(version, pin) > 0).sort(compareVersions);
      if (newer.length === 0) return pass;
      const detail = `pins ${pin}; latest is ${newer.at(-1)}`;
      const undated = newer.find(version => Number.isNaN(Date.parse(releases[version]!)));
      if (undated) return fail(`${detail}; the registry gives no release time for ${undated}`);
      // Age counts from the first newer release published, which a later backport cannot reset.
      const first = newer.reduce((oldest, version) => (Date.parse(releases[version]!) < Date.parse(releases[oldest]!) ? version : oldest));
      const age = Math.floor(((context.now ?? new Date()).getTime() - Date.parse(releases[first]!)) / DAY_MS);
      const trailing = `${first} has been out ${age} day${age === 1 ? "" : "s"}`;
      return age < AGENT_TOOL_GRACE_DAYS ? skip(`${detail}; ${trailing}, inside the ${AGENT_TOOL_GRACE_DAYS}-day grace`) : fail(`${detail}; ${trailing}`);
    },
  },
  {
    id: "output-capture",
    summary: "agent:run and agent:logs scripts, and an Output capture section in AGENTS.md",
    source: "AGENTS.md#output-capture",
    check: checkout => {
      const found: string[] = [];
      const scripts = object(checkout.packageJson?.scripts) ?? {};
      if (checkout.packageJson === undefined) found.push("no root package.json for the agent:run and agent:logs scripts");
      else for (const name of ["agent:run", "agent:logs"]) if (typeof scripts[name] !== "string") found.push(`no ${name} script`);
      const guidance = checkout.read("AGENTS.md");
      if (guidance === undefined) found.push("no AGENTS.md for the Output capture section");
      else {
        // An AGENTS.md without sections carries the same text as a paragraph.
        const sectioned = headings(guidance).some(heading => heading.level >= 2);
        const text = sectioned ? section(guidance, "Output capture") : guidance;
        if (text === undefined) found.push("AGENTS.md has no Output capture section");
        else for (const name of ["agent:run", "agent:logs"]) if (!text.includes(name)) found.push(`Output capture guidance does not mention ${name}`);
      }
      return problems(found);
    },
  },
  {
    id: "readme-title",
    summary: "The README's H1 is the plain project name, with no link and no link line after it",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const readme = checkout.read("README.md");
      if (readme === undefined) return fail("no README.md");
      const [first, second] = nonBlankLines(readme);
      if (!first || !/^#\s+\S/.test(first)) return fail("README.md does not start with an H1");
      if (hasLink(first, readme)) return fail(`H1 '${first}' contains a link`);
      if (second && /^(\[[^\]]*\](\([^)]*\)|\[[^\]]*\])?|<https?:[^>]*>|https?:\/\/\S+)$/.test(second) && hasLink(second, readme)) {
        return fail(`a standalone link line follows the H1: '${second}'`);
      }
      return pass;
    },
  },
  {
    id: "readme-quick-start",
    summary: "The README has a Quick start section",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const readme = checkout.read("README.md");
      if (readme === undefined) return fail("no README.md");
      return hasSection(readme, "Quick start") ? pass : fail("README.md has no Quick start section");
    },
  },
  {
    id: "readme-agent-free",
    summary: "The README carries no instructions for coding agents",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      if (isProducer(checkout)) return skip("its product is agent tooling");
      const readme = checkout.read("README.md");
      if (readme === undefined) return skip("no README.md");
      const matches = readme.match(/agent:run|agent:logs|\.(?:claude|agents)\/skills|^#+\s+Output capture/gim) ?? [];
      const mentions = [...new Set(matches.map(match => match.replace(/^#+\s+/, "")))];
      return mentions.length === 0 ? pass : fail(`README.md mentions ${mentions.join(", ")}`);
    },
  },
  {
    id: "brand-images",
    summary: "Brand images render from assets/brand/logo.svg through agent-tool.json, with no committed rasters",
    source: "AGENTS.md#brand-images",
    check: checkout => {
      if (!checkout.exists("assets/brand")) return skip("no assets/brand");
      const found: string[] = [];
      if (!checkout.exists("assets/brand/logo.svg")) found.push("no assets/brand/logo.svg");
      if (!object(json(checkout.read("agent-tool.json"))?.images)) found.push("agent-tool.json declares no images");
      const rasters = checkout.tracked("assets/brand").filter(file => /\.(png|ico|icns|jpe?g|gif|webp|bmp|tiff?)$/i.test(file));
      if (rasters.length > 0) found.push(`committed rasters: ${rasters.join(", ")}`);
      return problems(found);
    },
  },
  {
    id: "superseded-guidance",
    summary: "Markdown outside managed skills names no command a shared command replaced",
    source: "docs/audit.md#superseded-guidance",
    check: checkout => problems(supersededGuidance(checkout)),
  },
];

/**
 * Superseded commands in a checkout's tracked Markdown, skipping managed skills
 * and any other paths given, one finding per pattern.
 */
export function supersededGuidance(checkout: Checkout, skip: string[] = []): string[] {
  const exclusions = [...managedSkills(checkout), ...skip].map(file => `:(exclude,literal)${file}`);
  const found: string[] = [];
  for (const entry of SUPERSEDED) {
    // -z separates path, line number, and text with NUL, so a path may contain colons.
    const result = git(checkout.directory, ["grep", "-z", "-n", "-I", "-E", "-e", entry.pattern, "--", "*.md", ...exclusions]);
    if (result.status === 1) continue;
    if (result.status !== 0) throw new Error(`git grep failed in ${checkout.repo}: ${result.stderr}`);
    const hits = result.stdout.split("\n")
      .map(line => line.split("\0"))
      .filter(([, , ...text]) => !entry.exempt?.test(text.join("\0")))
      .map(([file, line]) => `${file}:${line}`);
    if (hits.length === 0) continue;
    found.push(`${entry.id} at ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""} (use ${entry.replacement})`);
  }
  return found;
}

function isFile(file: string): boolean {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

export function openCheckout(repo: string, directory: string): Checkout {
  const read = (file: string) => (isFile(path.join(directory, file)) ? readFileSync(path.join(directory, file), "utf8") : undefined);
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
    packageJson: json(read("package.json")),
  };
}

export interface CheckoutAudit {
  readonly repo: string;
  readonly path: string;
  readonly branch?: string | null;
  readonly head?: string;
  readonly error?: string;
  readonly failed: Array<{ rule: string; detail: string }>;
  readonly skipped: Array<{ rule: string; detail: string }>;
}

export interface Audit {
  /** True when every selected rule passed or was skipped in every present checkout. */
  readonly ok: boolean;
  readonly rules: Array<Pick<Rule, "id" | "summary" | "source">>;
  /** Failing repositories by rule. */
  readonly failures: Record<string, string[]>;
  readonly checkouts: CheckoutAudit[];
}

export function selectRules(ids: string[], remote: boolean): Rule[] {
  for (const id of ids) if (!RULES.some(rule => rule.id === id)) throw new Error(`Unknown audit rule '${id}'. Rules: ${RULES.map(rule => rule.id).join(", ")}.`);
  return RULES.filter(rule => (ids.length > 0 ? ids.includes(rule.id) : true) && (remote || !rule.remote || ids.includes(rule.id)));
}

/** Check each checkout's working tree against the selected rules; reads local files only unless a remote rule runs. */
export function audit(root: string, repos: string[], rules: Rule[], statusOf: (repo: string) => CheckoutStatus, context: AuditContext): Audit {
  const failures: Record<string, string[]> = {};
  const checkouts = repos.map((repo): CheckoutAudit => {
    const status = statusOf(repo);
    const base = { repo, path: status.path, failed: [], skipped: [] };
    if (status.error) return { ...base, error: status.error };
    if (!status.present) return { ...base, error: "checkout missing; run sync" };
    const checkout = openCheckout(repo, checkoutPath(root, repo));
    const result: CheckoutAudit = { ...base, branch: status.branch, head: status.head, failed: [], skipped: [] };
    for (const rule of rules) {
      const outcome = rule.check(checkout, context);
      if (outcome.status === "fail") {
        result.failed.push({ rule: rule.id, detail: outcome.detail });
        (failures[rule.id] ??= []).push(repo);
      } else if (outcome.status === "skip") result.skipped.push({ rule: rule.id, detail: outcome.detail });
    }
    return result;
  });
  return {
    ok: checkouts.every(checkout => !checkout.error && checkout.failed.length === 0),
    rules: rules.map(({ id, summary, source }) => ({ id, summary, source })),
    failures,
    checkouts,
  };
}

/** Ask the registry through Bun, which matrix already requires, when each release of a package appeared. */
export function registryReleases(name: string): Record<string, string> {
  const result = spawnSync(process.execPath, ["info", name, "time", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const times = result.error || result.status !== 0 ? undefined : json(result.stdout);
  const releases = Object.fromEntries(Object.entries(times ?? {}).filter((entry): entry is [string, string] => EXACT_VERSION.test(entry[0]) && typeof entry[1] === "string"));
  if (Object.keys(releases).length === 0) {
    throw new Error(`Could not read ${name}'s releases from the registry: ${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status}`)}`);
  }
  return releases;
}
