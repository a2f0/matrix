import { existsSync, writeSync } from "node:fs";
import path from "node:path";
import { audit, registryLatest, selectRules } from "./audit";
import { type CheckoutStatus, checkoutStatus, syncRepo, unmanagedCheckouts } from "./checkouts";
import { byName, listOwnerRepos, planDiscovery } from "./discover";
import { assessHealth, markdownHealth } from "./health";
import { cloneUrl, loadManifest, type Manifest, parseManifest, saveManifest, selectRepos } from "./manifest";
import { count, parseOptions } from "./options";
import { deployAll, type Gh, runGh, secretsRoot } from "./secrets";
import { listSweeps, markdownReport, parseUpdate, recordEntry, retro, startSweep, sweepReport } from "./sweeps";

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
  --help

Repos are owner/name or checkout name; none selects all. Output is JSON.
Checkouts are never reset, stashed, or deleted. Sweep ledgers live in Git's
common directory and are never committed.
`;

function output(value: unknown): void { writeSync(1, `${JSON.stringify(value, null, 2)}\n`); }

/** Read each checkout's status once, however many reports ask for it. */
function statusReader(root: string, manifest: Manifest): (repo: string) => CheckoutStatus {
  const cache = new Map<string, CheckoutStatus>();
  return repo => cache.get(repo) ?? cache.set(repo, checkoutStatus(root, repo, cloneUrl(repo, manifest.protocol))).get(repo)!;
}

/** Ask the registry once per package, and only when a remote rule needs it. */
function registry(): { latest(name: string): string } {
  const latest = new Map<string, string>();
  return { latest: name => latest.get(name) ?? latest.set(name, registryLatest(name)).get(name)! };
}
function usage(condition: boolean, message: string): void { if (!condition) throw new Error(message); }

const RECORD_FLAGS = {
  status: "value", reason: "value", base: "value", head: "value", pr: "value", merge: "value",
  validation: "value", reviewer: "value", verdict: "value", deploy: "value", cleanup: "value",
  note: "list", retry: "list", fallback: "list", declined: "list", manual: "list",
} as const;

function sweepCommand(args: string[], root: string, manifest: Manifest): number {
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
    output(recordEntry(root, positional[0]!, positional[1]!, update));
    return 0;
  }
  if (action === "report") {
    const { positional, booleans } = parseOptions(rest, { markdown: "boolean" }, "sweep report");
    usage(positional.length === 1, "Usage: matrix sweep report <branch> [--markdown]");
    const result = sweepReport(root, positional[0]!);
    if (booleans.has("markdown")) writeSync(1, markdownReport(result));
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
  throw new Error("Usage: matrix sweep <start|record|report|list|retro>; see matrix --help.");
}

export function main(argv = process.argv.slice(2), root = ROOT, gh: Gh = runGh): number {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") { writeSync(1, HELP); return 0; }
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
    const plan = planDiscovery(manifest, listOwnerRepos(manifest.discover));
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
    const result = audit(root, selectRepos(manifest, positional), rules, statusReader(root, manifest), registry());
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
      audit: audit(root, manifest.repos, selectRules([], remote), statusOf, registry()),
      retro: retro(root),
      ...(remote && { discovery: planDiscovery(manifest, listOwnerRepos(manifest.discover)) }),
    });
    if (booleans.has("markdown")) writeSync(1, markdownHealth(health));
    else output(health);
    return 0;
  }
  if (command === "sweep") return sweepCommand(args, root, manifest);
  throw new Error(`Unknown command '${command}'. Run matrix --help.`);
}
