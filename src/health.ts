import type { Audit } from "./audit";
import type { CheckoutStatus } from "./checkouts";
import { notReady, type Recurrence, type Retro } from "./sweeps";

export interface HealthInputs {
  readonly statuses: CheckoutStatus[];
  readonly unmanaged: string[];
  readonly audit: Audit;
  readonly retro: Retro;
  /** Present only with --remote, which asks GitHub for the owner's repositories. */
  readonly discovery?: { added: string[]; notDiscovered: string[] };
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
  readonly audit: { readonly rules: string[]; readonly failures: Record<string, string[]> };
  readonly discovery?: { added: string[]; notDiscovered: string[] };
  readonly sweeps: {
    readonly read: string[];
    readonly recurring: Array<Pick<Recurrence, "kind" | "cause" | "repos" | "sweeps">>;
    readonly unfinished: Retro["unfinished"];
  };
  /** Highest-leverage work first: checkout state, new repositories, standards, then friction. */
  readonly suggestions: string[];
}

function list(items: string[], limit = 4): string {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")}, and ${items.length - limit} more`;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string { return `${count} ${count === 1 ? noun : nouns}`; }

/** Combine status, audit, discovery, and sweep retro into one report with suggested next steps. */
export function assessHealth(inputs: HealthInputs): Health {
  const notReadyList = inputs.statuses.flatMap(status => {
    const reason = notReady(status);
    return reason === undefined ? [] : [{ repo: status.repo, reason }];
  });
  const staleInstalls = inputs.statuses.filter(status => status.agentTool && !status.agentTool.current).map(status => status.repo);
  const suggestions: string[] = [];
  for (const { repo, reason } of notReadyList) suggestions.push(`Inspect ${repo} before the next sweep: ${reason}.`);
  if (staleInstalls.length > 0) suggestions.push(`Reinstall dependencies in ${list(staleInstalls)}; their node_modules hold a different agent-tool than they pin.`);
  for (const repo of inputs.discovery?.added ?? []) suggestions.push(`Onboard ${repo}: \`bun run discover --apply\`, then the onboarding steps in AGENTS.md.`);
  for (const repo of inputs.discovery?.notDiscovered ?? []) suggestions.push(`Check ${repo}: it is managed, but discovery no longer finds it (renamed, archived, or no longer public?).`);
  for (const [rule, repos] of Object.entries(inputs.audit.failures)) {
    suggestions.push(`Fix \`${rule}\` in ${plural(repos.length, "checkout")} (${list(repos)}); \`bun run audit --rule ${rule}\` has the details.`);
  }
  for (const group of inputs.retro.recurring) {
    suggestions.push(`Resolve recurring ${group.kind} \`${group.cause}\` (${plural(group.repos.length, "repository", "repositories")}, ${plural(group.sweeps.length, "sweep")}); see docs/sweeps.md#retro.`);
  }
  for (const entry of inputs.retro.unfinished) suggestions.push(`Finish ${entry.repo} in sweep \`${entry.branch}\`: ${entry.status}${entry.reason ? `, ${entry.reason}` : ""}${entry.pr ? ` (${entry.pr})` : ""}.`);
  if (inputs.unmanaged.length > 0) suggestions.push(`Remove or manage ${list(inputs.unmanaged)}; matrix leaves unmanaged entries alone.`);
  return {
    ok: suggestions.length === 0,
    remote: inputs.discovery !== undefined,
    checkouts: { total: inputs.statuses.length, ready: inputs.statuses.filter(status => status.ready).length, notReady: notReadyList, staleInstalls, unmanaged: inputs.unmanaged },
    audit: { rules: inputs.audit.rules.map(rule => rule.id), failures: inputs.audit.failures },
    ...(inputs.discovery && { discovery: inputs.discovery }),
    sweeps: {
      read: inputs.retro.sweeps,
      recurring: inputs.retro.recurring.map(({ kind, cause, repos, sweeps }) => ({ kind, cause, repos, sweeps })),
      unfinished: inputs.retro.unfinished,
    },
    suggestions,
  };
}

/** The report as Markdown, for a person, a scheduled run's message, or an issue. */
export function markdownHealth(health: Health, at = new Date()): string {
  const { checkouts, audit, discovery, sweeps } = health;
  const failing = Object.entries(audit.failures);
  const lines = [
    "# Matrix health",
    "",
    `Checked ${at.toISOString()}${health.remote ? ", including GitHub discovery and the npm registry" : " from local checkouts"}.`,
    "",
    `- Checkouts: ${checkouts.ready} of ${checkouts.total} ready; ${checkouts.staleInstalls.length > 0 ? `stale installs in ${list(checkouts.staleInstalls)}` : "no stale installs"}; ${checkouts.unmanaged.length > 0 ? `unmanaged ${list(checkouts.unmanaged)}` : "no unmanaged entries"}.`,
    `- Audit (${plural(audit.rules.length, "rule")}): ${failing.length === 0 ? "every checkout passes" : failing.map(([rule, repos]) => `\`${rule}\` fails in ${repos.length}`).join(", ")}.`,
    `- Discovery: ${discovery ? (discovery.added.length + discovery.notDiscovered.length === 0 ? "matrix.json matches the owner's repositories" : `${plural(discovery.added.length, "new repository", "new repositories")}, ${discovery.notDiscovered.length} no longer found`) : "not checked; run with --remote"}.`,
    `- Sweeps: ${plural(sweeps.read.length, "ledger")} read; ${sweeps.recurring.length === 0 ? "no recurring friction" : sweeps.recurring.map(group => `${group.kind} \`${group.cause}\` in ${group.repos.length}`).join(", ")}; ${sweeps.unfinished.length === 0 ? "nothing unfinished" : `${sweeps.unfinished.length} unfinished`}.`,
    "",
    "## Next steps",
    "",
    ...(health.suggestions.length === 0 ? ["Nothing to do."] : health.suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`)),
  ];
  return `${lines.join("\n")}\n`;
}
