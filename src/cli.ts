import { spawnSync } from "node:child_process";
import { existsSync, statfsSync, writeSync } from "node:fs";
import path from "node:path";
import { audit, registryReleases, selectRules } from "./audit";
import { type CheckoutStatus, checkoutStatus, syncRepo, unmanagedCheckouts } from "./checkouts";
import { byName, listOwnerRepos, planDiscovery } from "./discover";
import { assessHealth, type DiskSpace, markdownHealth } from "./health";
import { checkoutPath, cloneUrl, loadManifest, type Manifest, parseManifest, saveManifest, selectRepos } from "./manifest";
import { count, parseOptions } from "./options";
import { deployAll, type Gh, runGh, secretsRoot } from "./secrets";
import { type AgentToolTeardown, teardownAll } from "./teardown";
import { knownCauses, listSweeps, markdownReport, parseUpdate, recordEntry, recordResolution, retro, startSweep, sweepReport } from "./sweeps";

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
}

function teardown(root: string, directory: string, apply: boolean): AgentToolTeardown {
  const result = spawnSync(path.join(root, "node_modules", ".bin", "agent-tool"), ["--repo", directory, "teardown", ...(apply ? ["--apply"] : [])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`agent-tool teardown could not run: ${result.error.message}`);
  // It exits 1 when something remains, with the same report.
  if (result.status !== 0 && result.status !== 1) throw new Error(`agent-tool teardown failed: ${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? `exit ${result.status}`}`);
  try { return JSON.parse(result.stdout) as AgentToolTeardown; }
  catch { throw new Error(`agent-tool teardown printed no report: ${(result.stderr || result.stdout).trim().slice(0, 200)}`); }
}

function diskSpace(directory: string): DiskSpace {
  const stats = statfsSync(directory);
  return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
}

const SERVICES: Services = {
  write: text => { writeSync(1, text); },
  warn: text => { writeSync(2, text); },
  listOwnerRepos,
  registryReleases,
  diskSpace,
  teardown,
};

/** The workspace, then every checkout present, or only the named checkouts. */
function teardownTargets(root: string, manifest: Manifest, names: string[]): Array<{ repo: string; path: string }> {
  const checkouts = selectRepos(manifest, names).map(repo => ({ repo, path: checkoutPath(root, repo) })).filter(target => existsSync(target.path));
  return names.length > 0 ? checkouts : [{ repo: "workspace", path: root }, ...checkouts];
}

function json(services: Services, value: unknown): void { services.write(`${JSON.stringify(value, null, 2)}\n`); }

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

function usage(condition: boolean, message: string): void { if (!condition) throw new Error(message); }

const RECORD_FLAGS = {
  status: "value", reason: "value", base: "value", head: "value", pr: "value", merge: "value",
  validation: "value", reviewer: "value", verdict: "value", deploy: "value", cleanup: "value",
  note: "list", retry: "list", fallback: "list", declined: "list", manual: "list",
} as const;

function sweepCommand(args: string[], root: string, manifest: Manifest, services: Services): number {
  const output = (value: unknown) => json(services, value);
  const [action, ...rest] = args;
  if (action === "start") {
    const { positional, values } = parseOptions(rest, { topic: "value", issue: "value" }, "sweep start");
    const [branch, ...names] = positional;
    usage(branch !== undefined, "Usage: matrix sweep start <branch> [--topic text] [--issue owner/repo#n] [repo...]");
    const repos = selectRepos(manifest, names);
    output(startSweep(root, branch!, repos, repo => checkoutStatus(root, repo, cloneUrl(repo, manifest.protocol)), { topic: values.topic, issue: values.issue }));
    return 0;
  }
  if (action === "record") {
    const { positional, values, lists } = parseOptions(rest, RECORD_FLAGS, "sweep record");
    usage(positional.length === 2, "Usage: matrix sweep record <branch> <repo> [options]; see matrix --help.");
    const update = parseUpdate(values, lists);
    usage(Object.keys(update).length > 0, "sweep record needs at least one field to record.");
    const known = update.events ? knownCauses(root) : new Map();
    output(recordEntry(root, positional[0]!, positional[1]!, update));
    // Retro groups friction by exact cause, so a new spelling of an old cause hides a recurrence.
    for (const event of update.events ?? []) {
      const earlier = [...(known.get(event.kind) ?? [])].sort();
      if (earlier.length > 0 && !earlier.includes(event.cause)) {
        services.warn(`Note: '${event.cause}' is a new ${event.kind} cause; earlier ledgers use ${earlier.join(", ")}. Reuse one when it names the same cause, so retro can group them.\n`);
      }
    }
    return 0;
  }
  if (action === "report") {
    const { positional, booleans } = parseOptions(rest, { markdown: "boolean" }, "sweep report");
    usage(positional.length === 1, "Usage: matrix sweep report <branch> [--markdown]");
    const result = sweepReport(root, positional[0]!);
    if (booleans.has("markdown")) services.write(markdownReport(result));
    else output(result);
    return 0;
  }
  if (action === "list") {
    usage(rest.length === 0, "Usage: matrix sweep list");
    output(listSweeps(root).map(({ sweep, updatedAt, counts, remaining, events }) => ({ branch: sweep.branch, topic: sweep.topic, startedAt: sweep.startedAt, updatedAt, counts, remaining, events })));
    return 0;
  }
  if (action === "retro") {
    const { positional, values } = parseOptions(rest, { last: "value", "min-repos": "value", "min-sweeps": "value" }, "sweep retro");
    usage(positional.length === 0 || values.last === undefined, "sweep retro takes branches or --last, not both.");
    output(retro(root, {
      branches: positional,
      last: count(values.last, "last", 5),
      minRepos: count(values["min-repos"], "min-repos", 2),
      minSweeps: count(values["min-sweeps"], "min-sweeps", 2),
    }));
    return 0;
  }
  if (action === "resolve") {
    const { positional, values } = parseOptions(rest, { resolution: "value", pr: "value" }, "sweep resolve");
    usage(positional.length === 2 && values.resolution !== undefined, "Usage: matrix sweep resolve <kind> <cause> --resolution text [--pr url]");
    output(recordResolution(root, positional[0]!, positional[1]!, values.resolution!, values.pr));
    return 0;
  }
  throw new Error("Usage: matrix sweep <start|record|report|list|retro|resolve>; see matrix --help.");
}

export function main(argv = process.argv.slice(2), root = ROOT, gh: Gh = runGh, services: Services = SERVICES): number {
  const output = (value: unknown) => json(services, value);
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") { services.write(HELP); return 0; }
  const manifest = loadManifest(root);
  if (command === "sync" || command === "status") {
    const option = args.find(arg => arg.startsWith("-"));
    usage(option === undefined, `Unknown ${command} option '${option}'.`);
    const repos = selectRepos(manifest, args);
    if (command === "status") {
      const checkouts = repos.map(repo => checkoutStatus(root, repo, cloneUrl(repo, manifest.protocol)));
      const staleInstalls = checkouts.filter(checkout => checkout.agentTool && !checkout.agentTool.current).map(checkout => checkout.repo);
      output({ ready: checkouts.every(checkout => checkout.ready), checkouts, staleInstalls, unmanaged: unmanagedCheckouts(root, manifest.repos) });
      return 0;
    }
    const results = repos.map(repo => {
      const result = syncRepo(root, repo, cloneUrl(repo, manifest.protocol));
      process.stderr.write(`${repo}: ${result.action}${result.reason ? ` (${result.reason})` : ""}\n`);
      return result;
    });
    const ok = results.every(result => result.action !== "error");
    output({ ok, results, unmanaged: unmanagedCheckouts(root, manifest.repos) });
    return ok ? 0 : 1;
  }
  if (command === "discover") {
    usage(args.length === 0 || (args.length === 1 && args[0] === "--apply"), "Usage: matrix discover [--apply]");
    const apply = args[0] === "--apply";
    const plan = planDiscovery(manifest, services.listOwnerRepos(manifest.discover));
    if (apply && plan.added.length > 0) {
      // Round-trip through validation so a discovered name collision fails before writing.
      saveManifest(root, parseManifest(JSON.stringify({ ...manifest, repos: [...manifest.repos, ...plan.added].sort(byName) })));
    }
    output({ applied: apply, ...plan });
    return 0;
  }
  if (command === "deploy-secrets") {
    const apply = args.includes("--apply");
    const names = args.filter(arg => arg !== "--apply");
    const option = names.find(arg => arg.startsWith("-"));
    usage(option === undefined, `Unknown deploy-secrets option '${option}'.`);
    const secrets = secretsRoot(root);
    usage(existsSync(secrets), `Secrets folder ${secrets} does not exist; set MATRIX_SECRETS_DIR.`);
    const { ok, results } = deployAll(secrets, selectRepos(manifest, names), apply, gh);
    output({ ok, apply, secrets, results });
    return ok ? 0 : 1;
  }
  if (command === "audit") {
    const { positional, lists, booleans } = parseOptions(args, { rule: "list", remote: "boolean" }, "audit");
    const rules = selectRules(lists.rule ?? [], booleans.has("remote"));
    const result = audit(root, selectRepos(manifest, positional), rules, statusReader(root, manifest), registry(services));
    output(result);
    return result.ok ? 0 : 1;
  }
  if (command === "health") {
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
      running: teardownAll(teardownTargets(root, manifest, []), directory => services.teardown(root, directory, false), false),
      ...(remote && { discovery: planDiscovery(manifest, services.listOwnerRepos(manifest.discover)) }),
    });
    if (booleans.has("markdown")) services.write(markdownHealth(health));
    else output(health);
    return 0;
  }
  if (command === "sweep") return sweepCommand(args, root, manifest, services);
  if (command === "teardown") {
    const { positional, booleans } = parseOptions(args, { apply: "boolean" }, "teardown");
    const result = teardownAll(teardownTargets(root, manifest, positional), (directory, apply) => services.teardown(root, directory, apply), booleans.has("apply"));
    output(result);
    return result.ok ? 0 : 1;
  }
  throw new Error(`Unknown command '${command}'. Run matrix --help.`);
}
