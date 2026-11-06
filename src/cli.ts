import { spawnSync } from "node:child_process";
import { existsSync, statfsSync, writeSync } from "node:fs";
import path from "node:path";
import { audit, registryReleases, selectRules } from "./audit";
import { type CheckoutStatus, checkoutStatus, staleInstalls, syncRepo, unmanagedCheckouts } from "./checkouts";
import { byName, listOwnerRepos, planDiscovery } from "./discover";
import { type Gh, runGh } from "./gh";
import { type GitTransport, inspectGitTransport } from "./gitTransport";
import { assessHealth, type DiskSpace, markdownHealth } from "./health";
import { checkoutPath, cloneUrl, loadManifest, type Manifest, parseManifest, saveManifest, selectRepos } from "./manifest";
import { count, parseOptions } from "./options";
import { deployAll, secretsRoot } from "./secrets";
import { listSweeps } from "./sweepLedger";
import { knownCauses, recordResolution, retro } from "./sweepRetro";
import { markdownReport, parseUpdate, recordEntry, startSweep, sweepReport } from "./sweeps";
import { type AgentToolTeardown, isAgentToolTeardown, teardownAll } from "./teardown";

export const ROOT = path.resolve(import.meta.dir, "..");

export const HELP = `Usage: matrix <command>

  sync [repo...]        Clone missing checkouts, fetch, and fast-forward clean default branches
  status [repo...]      Report branch, local changes, and distance from origin's default branch
  discover [--apply]    Compare matrix.json with the owner's repositories; --apply adds new ones
  audit [repo...] [--rule id]... [--remote]
                        Check checkouts against matrix standards; --remote adds registry rules
  health [--remote] [--markdown]
                        Status, audit, discovery (--remote), and sweep retro as next steps
  deploy-secrets [repo...] [--apply]
                        Compare each repo's matrix-secrets ci/ files with its GitHub Actions
                        secrets and variables; --apply sets them (nothing is deleted)
  sweep start <branch> [--topic text] [--issue owner/repo#n] [repo...]
                        Open a ledger; ready checkouts are pending, the rest skipped with a reason
  sweep record <branch> <repo> [--status s] [--reason text] [--base oid] [--head oid]
                        [--pr url] [--merge oid] [--validation text] [--reviewer name]
                        [--verdict v] [--deploy text] [--cleanup text] [--note text]...
                        [--retry|--fallback|--declined|--manual cause[:detail]]...
  sweep report <branch> [--markdown]
  sweep list            Recorded sweeps, newest first
  sweep retro [branch...] [--last n] [--min-repos n] [--min-sweeps n]
                        Group friction across sweeps; recurring causes need a lesson
  sweep resolve <kind> <cause> --resolution text [--pr url]
                        Record a recurring cause's fix, guidance, or decision
  state-machines [repo...] [--limit N] [--min-score N] [--json]
                        Rank files that look like implicit state machines in the workspace and
                        each checkout (agent-tool state-machines); leads, not findings
  teardown [repo...] [--apply]
                        What the workspace and each checkout still run (agent-tool teardown);
                        --apply stops recorded processes. Exits 1 while anything remains
  --help

Repos are owner/name or checkout name; none selects all. Output is JSON.
Checkouts are never reset, stashed, or deleted. Sweep ledgers live in Git's
common directory and are never committed.
`;

/** What commands reach outside the workspace for; tests replace them. */
export interface Services {
  /** Writes command output, stdout by default. */
  write(text: string): void;
  /** Writes a note for the person or agent running the command, stderr by default. */
  warn(text: string): void;
  listOwnerRepos(discover: Manifest["discover"]): string[];
  registryReleases(name: string): Record<string, string>;
  diskSpace(directory: string): DiskSpace;
  /** agent-tool's `teardown` for one repository, run with the workspace's pinned agent-tool. */
  teardown(root: string, directory: string, apply: boolean): AgentToolTeardown;
  /** How this machine's Git and gh reach GitHub. */
  gitTransport(root: string): GitTransport;
  /** agent-tool's `state-machines` over the given repositories, printing straight to the terminal; returns its exit status. */
  stateMachines(root: string, directories: string[], flags: string[]): number;
}

function teardown(root: string, directory: string, apply: boolean): AgentToolTeardown {
  const result = spawnSync(path.join(root, "node_modules", ".bin", "agent-tool"), ["--repo", directory, "teardown", ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`agent-tool teardown could not run: ${result.error.message}`);
  // It exits 1 when something remains, with the same report.
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`agent-tool teardown failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? `exit ${result.status}`}`);
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  if (!isAgentToolTeardown(report)) throw new Error(`agent-tool teardown printed no report: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  return report;
}

function stateMachines(root: string, directories: string[], flags: string[]): number {
  const result = spawnSync(path.join(root, "node_modules", ".bin", "agent-tool"), ["state-machines", ...directories, ...flags], { stdio: "inherit" });
  if (result.error) throw new Error(`agent-tool state-machines could not run: ${result.error.message}`);
  return result.status ?? 1;
}

function diskSpace(directory: string): DiskSpace {
  const stats = statfsSync(directory);
  return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
}

const SERVICES: Services = {
  write: text => {
    writeSync(1, text);
  },
  warn: text => {
    writeSync(2, text);
  },
  listOwnerRepos,
  registryReleases,
  diskSpace,
  teardown,
  gitTransport: root => inspectGitTransport(root),
  stateMachines,
};

/** The workspace, then every checkout present, or only the named checkouts. */
function workspaceTargets(root: string, manifest: Manifest, names: string[]): Array<{ repo: string; path: string }> {
  const checkouts = selectRepos(manifest, names)
    .map(repo => ({ repo, path: checkoutPath(root, repo) }))
    .filter(target => existsSync(target.path));
  return names.length > 0 ? checkouts : [{ repo: "workspace", path: root }, ...checkouts];
}

function json(services: Services, value: unknown): void {
  services.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Read each checkout's status once, however many reports ask for it. */
function statusReader(root: string, manifest: Manifest): (repo: string) => CheckoutStatus {
  const cache = new Map<string, CheckoutStatus>();
  return repo => cache.get(repo) ?? cache.set(repo, checkoutStatus(root, repo, cloneUrl(repo, manifest.protocol))).get(repo)!;
}

/** Ask the registry once per package, and only when a remote rule needs it. */
function registry(services: Services): { releases(name: string): Record<string, string> } {
  const releases = new Map<string, Record<string, string>>();
  return { releases: name => releases.get(name) ?? releases.set(name, services.registryReleases(name)).get(name)! };
}

function usage(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const RECORD_FLAGS = {
  status: "value",
  reason: "value",
  base: "value",
  head: "value",
  pr: "value",
  merge: "value",
  validation: "value",
  reviewer: "value",
  verdict: "value",
  deploy: "value",
  cleanup: "value",
  note: "list",
  retry: "list",
  fallback: "list",
  declined: "list",
  manual: "list",
} as const;

/** What every command handler reads: the workspace, its manifest, and the services that reach outside it. */
interface CommandContext {
  readonly root: string;
  readonly manifest: Manifest;
  readonly gh: Gh;
  readonly services: Services;
  readonly output: (value: unknown) => void;
}

type Handler = (args: string[], context: CommandContext) => number;

/** Retro groups friction by exact cause, so a new spelling of an old cause hides a recurrence. */
function warnNewCauses(services: Services, known: Map<string, Set<string>>, events: Array<{ kind: string; cause: string }>): void {
  for (const event of events) {
    const earlier = [...(known.get(event.kind) ?? [])].sort();
    if (earlier.length > 0 && !earlier.includes(event.cause)) {
      services.warn(
        `Note: '${event.cause}' is a new ${event.kind} cause; earlier ledgers use ${earlier.join(", ")}. Reuse one when it names the same cause, so retro can group them.\n`,
      );
    }
  }
}

const SWEEP_ACTIONS = new Map<string, Handler>([
  [
    "start",
    (rest, { root, manifest, output }) => {
      const { positional, values } = parseOptions(rest, { topic: "value", issue: "value" }, "sweep start");
      const [branch, ...names] = positional;
      usage(branch !== undefined, "Usage: matrix sweep start <branch> [--topic text] [--issue owner/repo#n] [repo...]");
      const repos = selectRepos(manifest, names);
      output(startSweep(root, branch!, repos, statusReader(root, manifest), { topic: values.topic, issue: values.issue }));
      return 0;
    },
  ],
  [
    "record",
    (rest, { root, services, output }) => {
      const { positional, values, lists } = parseOptions(rest, RECORD_FLAGS, "sweep record");
      usage(positional.length === 2, "Usage: matrix sweep record <branch> <repo> [options]; see matrix --help.");
      const update = parseUpdate(values, lists);
      usage(Object.keys(update).length > 0, "sweep record needs at least one field to record.");
      const known = update.events ? knownCauses(root) : new Map();
      output(recordEntry(root, positional[0]!, positional[1]!, update));
      warnNewCauses(services, known, update.events ?? []);
      return 0;
    },
  ],
  [
    "report",
    (rest, { root, services, output }) => {
      const { positional, booleans } = parseOptions(rest, { markdown: "boolean" }, "sweep report");
      usage(positional.length === 1, "Usage: matrix sweep report <branch> [--markdown]");
      const result = sweepReport(root, positional[0]!);
      if (booleans.has("markdown")) services.write(markdownReport(result));
      else output(result);
      return 0;
    },
  ],
  [
    "list",
    (rest, { root, output }) => {
      usage(rest.length === 0, "Usage: matrix sweep list");
      output(
        listSweeps(root).map(({ sweep, updatedAt, counts, remaining, events }) => ({
          branch: sweep.branch,
          topic: sweep.topic,
          startedAt: sweep.startedAt,
          updatedAt,
          counts,
          remaining,
          events,
        })),
      );
      return 0;
    },
  ],
  [
    "retro",
    (rest, { root, output }) => {
      const { positional, values } = parseOptions(rest, { last: "value", "min-repos": "value", "min-sweeps": "value" }, "sweep retro");
      usage(positional.length === 0 || values.last === undefined, "sweep retro takes branches or --last, not both.");
      output(
        retro(root, {
          branches: positional,
          last: count(values.last, "last"),
          minRepos: count(values["min-repos"], "min-repos"),
          minSweeps: count(values["min-sweeps"], "min-sweeps"),
        }),
      );
      return 0;
    },
  ],
  [
    "resolve",
    (rest, { root, output }) => {
      const { positional, values } = parseOptions(rest, { resolution: "value", pr: "value" }, "sweep resolve");
      usage(positional.length === 2 && values.resolution !== undefined, "Usage: matrix sweep resolve <kind> <cause> --resolution text [--pr url]");
      output(recordResolution(root, positional[0]!, positional[1]!, values.resolution!, values.pr));
      return 0;
    },
  ],
]);

const COMMANDS = new Map<string, Handler>([
  [
    "sync",
    (args, { root, manifest, services, output }) => {
      const repos = selectRepos(manifest, parseOptions(args, {}, "sync").positional);
      const results = repos.map(repo => {
        const result = syncRepo(root, repo, cloneUrl(repo, manifest.protocol));
        services.warn(`${repo}: ${result.action}${result.reason ? ` (${result.reason})` : ""}\n`);
        return result;
      });
      const ok = results.every(result => result.action !== "error");
      output({ ok, results, unmanaged: unmanagedCheckouts(root, manifest.repos) });
      return ok ? 0 : 1;
    },
  ],
  [
    "status",
    (args, { root, manifest, output }) => {
      const checkouts = selectRepos(manifest, parseOptions(args, {}, "status").positional).map(statusReader(root, manifest));
      output({
        ready: checkouts.every(checkout => checkout.ready),
        checkouts,
        staleInstalls: staleInstalls(checkouts),
        unmanaged: unmanagedCheckouts(root, manifest.repos),
      });
      return 0;
    },
  ],
  [
    "discover",
    (args, { root, manifest, services, output }) => {
      const { positional, booleans } = parseOptions(args, { apply: "boolean" }, "discover");
      usage(positional.length === 0, "Usage: matrix discover [--apply]");
      const apply = booleans.has("apply");
      const plan = planDiscovery(manifest, services.listOwnerRepos(manifest.discover));
      if (apply && plan.added.length > 0) {
        // Round-trip through validation so a discovered name collision fails before writing.
        saveManifest(root, parseManifest(JSON.stringify({ ...manifest, repos: [...manifest.repos, ...plan.added].sort(byName) })));
      }
      output({ applied: apply, ...plan });
      return 0;
    },
  ],
  [
    "deploy-secrets",
    (args, { root, manifest, gh, output }) => {
      const { positional: names, booleans } = parseOptions(args, { apply: "boolean" }, "deploy-secrets");
      const apply = booleans.has("apply");
      const secrets = secretsRoot(root);
      usage(existsSync(secrets), `Secrets folder ${secrets} does not exist; set MATRIX_SECRETS_DIR.`);
      const { ok, results } = deployAll(secrets, selectRepos(manifest, names), apply, gh);
      output({ ok, apply, secrets, results });
      return ok ? 0 : 1;
    },
  ],
  [
    "audit",
    (args, { root, manifest, services, output }) => {
      const { positional, lists, booleans } = parseOptions(args, { rule: "list", remote: "boolean" }, "audit");
      const rules = selectRules(lists.rule ?? [], booleans.has("remote"));
      const result = audit(root, selectRepos(manifest, positional), rules, statusReader(root, manifest), registry(services));
      output(result);
      return result.ok ? 0 : 1;
    },
  ],
  [
    "health",
    (args, { root, manifest, services, output }) => {
      const { positional, booleans } = parseOptions(args, { remote: "boolean", markdown: "boolean" }, "health");
      usage(positional.length === 0, "Usage: matrix health [--remote] [--markdown]");
      const remote = booleans.has("remote");
      const statusOf = statusReader(root, manifest);
      const health = assessHealth({
        statuses: manifest.repos.map(statusOf),
        unmanaged: unmanagedCheckouts(root, manifest.repos),
        audit: audit(root, manifest.repos, selectRules([], remote), statusOf, registry(services)),
        retro: retro(root),
        disk: services.diskSpace(root),
        git: services.gitTransport(root),
        running: teardownAll(workspaceTargets(root, manifest, []), directory => services.teardown(root, directory, false), false),
        ...(remote && { discovery: planDiscovery(manifest, services.listOwnerRepos(manifest.discover)) }),
      });
      if (booleans.has("markdown")) services.write(markdownHealth(health));
      else output(health);
      return 0;
    },
  ],
  [
    "sweep",
    ([action, ...rest], context) => {
      const handler = action === undefined ? undefined : SWEEP_ACTIONS.get(action);
      if (!handler) throw new Error("Usage: matrix sweep <start|record|report|list|retro|resolve>; see matrix --help.");
      return handler(rest, context);
    },
  ],
  [
    "state-machines",
    (args, { root, manifest, services }) => {
      const { positional, values, booleans } = parseOptions(args, { limit: "value", "min-score": "value", json: "boolean" }, "state-machines");
      const flags = [
        ...(values.limit === undefined ? [] : ["--limit", values.limit]),
        ...(values["min-score"] === undefined ? [] : ["--min-score", values["min-score"]]),
        ...(booleans.has("json") ? ["--json"] : []),
      ];
      const targets = workspaceTargets(root, manifest, positional);
      usage(targets.length > 0, "None of the named checkouts is present; run matrix sync first.");
      return services.stateMachines(
        root,
        targets.map(target => target.path),
        flags,
      );
    },
  ],
  [
    "teardown",
    (args, { root, manifest, services, output }) => {
      const { positional, booleans } = parseOptions(args, { apply: "boolean" }, "teardown");
      const result = teardownAll(
        workspaceTargets(root, manifest, positional),
        (directory, apply) => services.teardown(root, directory, apply),
        booleans.has("apply"),
      );
      output(result);
      return result.ok ? 0 : 1;
    },
  ],
]);

export function main(argv = process.argv.slice(2), root = ROOT, gh: Gh = runGh, services: Services = SERVICES): number {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    services.write(HELP);
    return 0;
  }
  const manifest = loadManifest(root);
  const handler = COMMANDS.get(command);
  if (!handler) throw new Error(`Unknown command '${command}'. Run matrix --help.`);
  return handler(args, { root, manifest, gh, services, output: value => json(services, value) });
}
