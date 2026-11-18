import type { Audit } from "./audit";
import { type CheckoutStatus, notReady, staleInstalls } from "./checkouts";
import type { GitTransport } from "./gitTransport";
import type { Recurrence, Retro } from "./sweepRetro";
import { leftoverRepos, type Teardown } from "./teardown";
import { plural } from "./text";

/** Bytes available to this user, and the volume's size. */
export interface DiskSpace {
  readonly free: number;
  readonly total: number;
}

/**
 * Validation suites, native builds, and browser caches need room: sweeps hit
 * ENOSPC with about 30 GiB free, so health asks for this much before one starts.
 */
const MIN_FREE_DISK_GIB = 50;
const GIB = 1024 ** 3;

/**
 * A default branch's CI, from agent-tool's `repo base-health`: `red` names the
 * failing checks and the merges since they last passed, and `unknown` says why
 * GitHub could not be read.
 */
export type DefaultBranchHealth =
  | { readonly repo: string; readonly status: "green" | "pending" | "no-ci" }
  | { readonly repo: string; readonly status: "red" | "unknown"; readonly detail: string };

export interface HealthInputs {
  readonly statuses: CheckoutStatus[];
  readonly unmanaged: string[];
  readonly audit: Audit;
  readonly retro: Retro;
  /** Space on the volume holding the checkouts. */
  readonly disk?: DiskSpace;
  /** Present only with --remote, which asks GitHub for the owner's repositories. */
  readonly discovery?: { added: string[]; notDiscovered: string[] };
  /** What the workspace and its checkouts still run, from `matrix teardown`. */
  readonly running?: Teardown;
  /** How Git and gh reach GitHub on this machine. */
  readonly git?: GitTransport;
  /** Present only with --remote: each checkout's default-branch CI. */
  readonly defaultBranches?: DefaultBranchHealth[];
}

export interface Health {
  /** True when there is nothing to suggest. */
  readonly ok: boolean;
  readonly remote: boolean;
  readonly checkouts: {
    readonly total: number;
    readonly ready: number;
    readonly notReady: Array<{ repo: string; reason: string }>;
    readonly staleInstalls: string[];
    readonly unmanaged: string[];
  };
  /** `unaudited` lists checkouts the audit could not read; `status` explains why. */
  readonly audit: { readonly rules: string[]; readonly failures: Record<string, string[]>; readonly unaudited: string[] };
  readonly discovery?: { added: string[]; notDiscovered: string[] };
  readonly disk?: DiskSpace & { readonly low: boolean };
  /**
   * Repositories where teardown fails (earlier work left something running, or could not be
   * inspected), and the agent session's background shells still running, which are informational.
   */
  readonly running?: { readonly leftover: string[]; readonly sessionShells: string[] };
  /** Ways this machine's Git or gh can leave SSH for GitHub. */
  readonly git?: GitTransport;
  /** With --remote: default branches by CI result; `red` and `unknown` carry why. */
  readonly defaultBranches?: {
    readonly green: string[];
    readonly pending: string[];
    readonly noCi: string[];
    readonly red: Array<{ repo: string; detail: string }>;
    readonly unknown: Array<{ repo: string; detail: string }>;
  };
  readonly sweeps: {
    readonly read: string[];
    readonly recurring: Array<Pick<Recurrence, "kind" | "cause" | "repos" | "sweeps">>;
    /** Recurring causes with a resolution recorded since they last happened. */
    readonly resolved: Array<Pick<Recurrence, "kind" | "cause">>;
    readonly unfinished: Retro["unfinished"];
  };
  /** Highest-leverage work first: disk space, leftover processes, Git transport, checkout state, new repositories, standards, then friction. */
  readonly suggestions: string[];
}

function list(items: string[], limit = 4): string {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, and ${items.length - limit} more`;
}

function gib(bytes: number): string {
  return `${Math.floor(bytes / GIB)} GiB`;
}

/** Suggestions about this machine: disk space, leftover processes, and Git transport. */
function machineSuggestions(inputs: HealthInputs, low: boolean, leftover: string[]): string[] {
  const suggestions: string[] = [];
  if (low)
    suggestions.push(
      `Free disk space before the next sweep: ${gib(inputs.disk!.free)} free of ${gib(inputs.disk!.total)}; validation needs at least ${MIN_FREE_DISK_GIB} GiB; \`bun run space\` lists what is safe to remove.`,
    );
  if (leftover.length > 0)
    suggestions.push(
      `Stop what earlier work left running in ${list(leftover)}: \`bun run teardown\` lists it, \`--apply\` stops recorded processes, and untracked ones need stopping by hand.`,
    );
  for (const problem of inputs.git?.problems ?? []) suggestions.push(`Keep Git on SSH: ${problem}; see docs/health.md#github-over-ssh.`);
  return suggestions;
}

/** A red default branch blocks shipping there, so its repair comes with the checkout's state. */
function defaultBranchSuggestions(branches: DefaultBranchHealth[]): string[] {
  return branches.flatMap(branch => {
    if (branch.status === "red")
      return [`Repair ${branch.repo}'s default branch: ${branch.detail}. The next \`ship-pr\` there starts with it; see docs/tooling.md#base-freshness.`];
    if (branch.status === "unknown") return [`Check ${branch.repo}'s default-branch CI by hand: ${branch.detail}.`];
    return [];
  });
}

/** Suggestions about the checkouts themselves: their state, installs, and repositories discovery adds or loses. */
function checkoutSuggestions(inputs: HealthInputs, notReadyList: Array<{ repo: string; reason: string }>, stale: string[]): string[] {
  const suggestions: string[] = [];
  for (const { repo, reason } of notReadyList) suggestions.push(`Inspect ${repo} before the next sweep: ${reason}.`);
  suggestions.push(...defaultBranchSuggestions(inputs.defaultBranches ?? []));
  if (stale.length > 0) suggestions.push(`Reinstall dependencies in ${list(stale)}; their node_modules hold a different agent-tool than they pin.`);
  for (const repo of inputs.discovery?.added ?? []) suggestions.push(`Onboard ${repo}: \`bun run discover --apply\`, then the onboarding steps in AGENTS.md.`);
  for (const repo of inputs.discovery?.notDiscovered ?? [])
    suggestions.push(`Check ${repo}: it is managed, but discovery no longer finds it (renamed, archived, or no longer public?).`);
  return suggestions;
}

/** Suggestions about standards and sweeps: audit failures, recurring friction, unfinished sweep work, and unmanaged entries. */
function followUpSuggestions(inputs: HealthInputs): string[] {
  const suggestions: string[] = [];
  for (const [rule, repos] of Object.entries(inputs.audit.failures)) {
    suggestions.push(`Fix \`${rule}\` in ${plural(repos.length, "checkout")} (${list(repos)}); \`bun run audit --rule ${rule}\` has the details.`);
  }
  for (const group of inputs.retro.recurring) {
    suggestions.push(
      `Resolve recurring ${group.kind} \`${group.cause}\` (${plural(group.repos.length, "repository", "repositories")}, ${plural(group.sweeps.length, "sweep")}), then \`bun run sweep resolve ${group.kind} ${group.cause}\`; see docs/sweeps.md#retro.`,
    );
  }
  for (const entry of inputs.retro.unfinished)
    suggestions.push(
      `Finish ${entry.repo} in sweep \`${entry.branch}\`: ${entry.status}${entry.reason ? `, ${entry.reason}` : ""}${entry.pr ? ` (${entry.pr})` : ""}.`,
    );
  if (inputs.unmanaged.length > 0) suggestions.push(`Remove or manage ${list(inputs.unmanaged)}; matrix leaves unmanaged entries alone.`);
  return suggestions;
}

function groupDefaultBranches(branches: DefaultBranchHealth[]): NonNullable<Health["defaultBranches"]> {
  const named = (status: DefaultBranchHealth["status"]) => branches.filter(branch => branch.status === status).map(branch => branch.repo);
  const detailed = (status: "red" | "unknown") => branches.flatMap(branch => (branch.status === status ? [{ repo: branch.repo, detail: branch.detail }] : []));
  return { green: named("green"), pending: named("pending"), noCi: named("no-ci"), red: detailed("red"), unknown: detailed("unknown") };
}

/** Combine status, audit, discovery, and sweep retro into one report with suggested next steps. */
export function assessHealth(inputs: HealthInputs): Health {
  const notReadyList = inputs.statuses.flatMap(status => {
    const reason = notReady(status);
    return reason === undefined ? [] : [{ repo: status.repo, reason }];
  });
  const stale = staleInstalls(inputs.statuses);
  const low = inputs.disk !== undefined && inputs.disk.free < MIN_FREE_DISK_GIB * GIB;
  const leftover = inputs.running ? leftoverRepos(inputs.running) : [];
  const suggestions = [...machineSuggestions(inputs, low, leftover), ...checkoutSuggestions(inputs, notReadyList, stale), ...followUpSuggestions(inputs)];
  return {
    ok: suggestions.length === 0,
    remote: inputs.discovery !== undefined,
    checkouts: {
      total: inputs.statuses.length,
      ready: inputs.statuses.filter(status => status.ready).length,
      notReady: notReadyList,
      staleInstalls: stale,
      unmanaged: inputs.unmanaged,
    },
    audit: {
      rules: inputs.audit.rules.map(rule => rule.id),
      failures: inputs.audit.failures,
      unaudited: inputs.audit.checkouts.filter(checkout => checkout.error).map(checkout => checkout.repo),
    },
    ...(inputs.discovery && { discovery: inputs.discovery }),
    ...(inputs.disk && { disk: { ...inputs.disk, low } }),
    ...(inputs.running && { running: { leftover, sessionShells: inputs.running.sessionShells } }),
    ...(inputs.git && { git: inputs.git }),
    ...(inputs.defaultBranches && { defaultBranches: groupDefaultBranches(inputs.defaultBranches) }),
    sweeps: {
      read: inputs.retro.sweeps,
      recurring: inputs.retro.recurring.map(({ kind, cause, repos, sweeps }) => ({ kind, cause, repos, sweeps })),
      resolved: inputs.retro.resolved.map(({ kind, cause }) => ({ kind, cause })),
      unfinished: inputs.retro.unfinished,
    },
    suggestions,
  };
}

function auditLine(audit: Health["audit"]): string {
  const failing = Object.entries(audit.failures);
  return `- Audit (${plural(audit.rules.length, "rule")}): ${[
    failing.length === 0
      ? audit.unaudited.length === 0
        ? "every checkout passes"
        : "every audited checkout passes"
      : failing.map(([rule, repos]) => `\`${rule}\` fails in ${repos.length}`).join(", "),
    ...(audit.unaudited.length > 0 ? [`${list(audit.unaudited)} not audited`] : []),
  ].join("; ")}.`;
}

function checkoutsLine(checkouts: Health["checkouts"]): string {
  return `- Checkouts: ${checkouts.ready} of ${checkouts.total} ready; ${checkouts.staleInstalls.length > 0 ? `stale installs in ${list(checkouts.staleInstalls)}` : "no stale installs"}; ${checkouts.unmanaged.length > 0 ? `unmanaged ${list(checkouts.unmanaged)}` : "no unmanaged entries"}.`;
}

function diskLine(disk: NonNullable<Health["disk"]>): string {
  return `- Disk: ${gib(disk.free)} free of ${gib(disk.total)}${disk.low ? `, under the ${MIN_FREE_DISK_GIB} GiB a sweep needs` : ""}.`;
}

function gitLine(git: NonNullable<Health["git"]>): string {
  return `- Git: ${git.problems.length === 0 ? "GitHub over SSH through ssh.github.com:443, no HTTPS credential helper, gh on SSH" : `${plural(git.problems.length, "way", "ways")} to leave SSH for GitHub`}.`;
}

function runningLine(running: NonNullable<Health["running"]>): string {
  const repos = running.leftover.length === 0 ? "repository teardown checks pass" : `teardown fails in ${list(running.leftover)}`;
  const shells =
    running.sessionShells.length === 0
      ? ""
      : `; this session still runs ${plural(running.sessionShells.length, "background shell")} (${running.sessionShells.join("; ")})`;
  return `- Running: ${repos}${shells}.`;
}

function discoveryLine(discovery: Health["discovery"]): string {
  return `- Discovery: ${discovery ? (discovery.added.length + discovery.notDiscovered.length === 0 ? "matrix.json matches the owner's repositories" : `${plural(discovery.added.length, "new repository", "new repositories")}, ${discovery.notDiscovered.length} no longer found`) : "not checked; run with --remote"}.`;
}

function defaultBranchesLine(branches: Health["defaultBranches"]): string {
  if (!branches) return "- Default branches: not checked; run with --remote.";
  const parts = [
    `${branches.green.length} green`,
    ...(branches.red.length > 0 ? [`red in ${list(branches.red.map(branch => branch.repo))}`] : []),
    ...(branches.pending.length > 0 ? [`running in ${list(branches.pending)}`] : []),
    ...(branches.noCi.length > 0 ? [`no push CI in ${list(branches.noCi)}`] : []),
    ...(branches.unknown.length > 0 ? [`unread in ${list(branches.unknown.map(branch => branch.repo))}`] : []),
  ];
  return `- Default branches: ${parts.join(", ")}.`;
}

function sweepsLine(sweeps: Health["sweeps"]): string {
  return `- Sweeps: ${plural(sweeps.read.length, "ledger")} read; ${sweeps.recurring.length === 0 ? "no unresolved recurring friction" : sweeps.recurring.map(group => `${group.kind} \`${group.cause}\` in ${group.repos.length}`).join(", ")}${sweeps.resolved.length > 0 ? ` (${sweeps.resolved.length} resolved)` : ""}; ${sweeps.unfinished.length === 0 ? "nothing unfinished" : `${sweeps.unfinished.length} unfinished`}.`;
}

/** The report as Markdown, for a person, a scheduled run's message, or an issue. */
export function markdownHealth(health: Health, at = new Date()): string {
  const { checkouts, audit, discovery, disk, running, git, defaultBranches, sweeps } = health;
  const lines = [
    "# Matrix health",
    "",
    `Checked ${at.toISOString()}${health.remote ? ", including GitHub discovery and the npm registry" : " from local checkouts"}.`,
    "",
    checkoutsLine(checkouts),
    auditLine(audit),
    ...(disk ? [diskLine(disk)] : []),
    ...(git ? [gitLine(git)] : []),
    ...(running ? [runningLine(running)] : []),
    discoveryLine(discovery),
    defaultBranchesLine(defaultBranches),
    sweepsLine(sweeps),
    "",
    "## Next steps",
    "",
    ...(health.suggestions.length === 0 ? ["Nothing to do."] : health.suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`)),
  ];
  return `${lines.join("\n")}\n`;
}
