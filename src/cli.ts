import { writeSync } from "node:fs";
import path from "node:path";
import { checkoutStatus, syncRepo, unmanagedCheckouts } from "./checkouts";
import { byName, listOwnerRepos, planDiscovery } from "./discover";
import { cloneUrl, loadManifest, parseManifest, saveManifest, selectRepos } from "./manifest";

export const ROOT = path.resolve(import.meta.dir, "..");

export const HELP = `Usage: matrix <command>

  sync [repo...]        Clone missing checkouts, fetch, and fast-forward clean default branches
  status [repo...]      Report branch, local changes, and distance from origin's default branch
  discover [--apply]    Compare matrix.json with the owner's repositories; --apply adds new ones
  --help

Repos are owner/name or checkout name; none selects all. Output is JSON.
Checkouts are never reset, stashed, or deleted.
`;

function output(value: unknown): void { writeSync(1, `${JSON.stringify(value, null, 2)}\n`); }
function usage(condition: boolean, message: string): void { if (!condition) throw new Error(message); }

export function main(argv = process.argv.slice(2), root = ROOT): number {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") { writeSync(1, HELP); return 0; }
  const manifest = loadManifest(root);
  if (command === "sync" || command === "status") {
    const option = args.find(arg => arg.startsWith("-"));
    usage(option === undefined, `Unknown ${command} option '${option}'.`);
    const repos = selectRepos(manifest, args);
    if (command === "status") {
      const checkouts = repos.map(repo => checkoutStatus(root, repo, cloneUrl(repo, manifest.protocol)));
      output({ ready: checkouts.every(checkout => checkout.ready), checkouts, unmanaged: unmanagedCheckouts(root, manifest.repos) });
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
  throw new Error(`Unknown command '${command}'. Run matrix --help.`);
}
