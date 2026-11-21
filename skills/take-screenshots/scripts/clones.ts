/**
 * Every clone on this machine that shares a store, and linking the ones that
 * need no decision. Node built-ins only, like artifacts.ts.
 */
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { toplevel } from "./git";
import { type LinkResult, link, linkState } from "./link";
import { claimNamespace, existingCase, knownNamespace, linkedNamespace, OWNER, targetFor } from "./namespace";
import { LINK, lexists, storeDir, type Target } from "./store";
import { artifactsRoot, captures, isMatrixWorkspace } from "./targets";

/** The store --all works on: the one the repository holding cwd resolves, else MATRIX_ARTIFACTS_DIR. */
export function sharedStore(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const here = toplevel(cwd);
  if (here) return artifactsRoot(realpathSync(here), env);
  if (env.MATRIX_ARTIFACTS_DIR) return path.resolve(env.MATRIX_ARTIFACTS_DIR);
  throw new Error(`${cwd} is not inside a git repository; run --all from a clone or set MATRIX_ARTIFACTS_DIR`);
}

/**
 * Where a clone that resolves this store lives: directly beside it (a clone
 * outside a workspace keeps matrix-artifacts beside itself), or in the
 * checkouts of a matrix workspace beside it. Linked worktrees count as clones.
 */
function candidateRoots(artifacts: string): string[] {
  const parent = path.dirname(artifacts);
  const roots = directories(parent).flatMap(name => {
    const directory = path.join(parent, name);
    if (directory === artifacts) return [];
    if (isMatrixWorkspace(directory)) return [directory, ...checkoutsOf(directory)];
    return lexists(path.join(directory, ".git")) ? [directory] : [];
  });
  return [...new Set(roots.flatMap(realPath))].sort();
}

/** A directory's real path, or nothing when it vanished meanwhile. */
function realPath(directory: string): string[] {
  try {
    return [realpathSync(directory)];
  } catch {
    return [];
  }
}

/** Real directories only: a symlinked folder is another name for a clone found directly. */
function directories(parent: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function checkoutsOf(workspace: string): string[] {
  const checkouts = path.join(workspace, "checkouts");
  return directories(checkouts)
    .map(name => path.join(checkouts, name))
    .filter(root => lexists(path.join(root, ".git")));
}

/** Identity from origin's URL alone, so a sweep of every clone makes no network calls. */
const OFFLINE = () => undefined;

/**
 * Every clone beside the store that captures screenshots into a namespace the
 * store already holds, named by its path from the store's parent directory. A
 * repository joins the store when one of its clones runs `link` or `capture`;
 * after that, --all finds the rest. Identities come from origin's URL, so a
 * renamed repository's clones are found once one clone has recorded the rename
 * online. A clone of another repository is left out unless it is linked into
 * the store, where status reports it as foreign.
 */
export function clonesSharing(artifacts: string): Target[] {
  return candidateRoots(artifacts).flatMap(root => {
    try {
      return sharingClone(root, artifacts);
    } catch {
      // A clone that cannot be read, such as one without a GitHub origin, which names its namespace with
      // --project one clone at a time, is left out rather than stopping the others or a capture.
      return [];
    }
  });
}

function sharingClone(root: string, artifacts: string): Target[] {
  if (!captures(root)) return [];
  const target = existingCase(knownNamespace(targetFor(root, undefined, OFFLINE), artifacts), artifacts);
  if (!lexists(path.join(artifacts, target.project, OWNER))) return [];
  if (claimNamespace(target, artifacts, false) && linkedNamespace(target, artifacts) === undefined) return [];
  return [{ ...target, name: path.relative(path.dirname(artifacts), root) }];
}

/** Link actions that need no one's decision: creating a missing link, or replacing an empty directory with one. */
const AUTOMATIC = new Set<LinkResult["action"]>(["link", "replace-empty-directory"]);

/**
 * Plans, and with apply makes, the links that need no decision. Returns a
 * result for each target that is not linked: applied (or planned) for the
 * automatic actions, and `blocked` with the reason for the rest, such as a
 * clone that holds its own capture, which `link` in that clone decides.
 */
export function linkAutomatically(targets: Target[], artifacts: string, apply: boolean): LinkResult[] {
  return targets.flatMap(target => {
    let before: LinkResult["before"] = "other";
    try {
      before = linkState(target, artifacts).state;
      return linkOne(target, artifacts, apply);
    } catch (error) {
      // One clone that cannot be linked never stops the others, or the capture that asked.
      return [{ name: target.name, project: target.project, store: storeDir(target, artifacts), before, blocked: (error as Error).message }];
    }
  });
}

/** One target's result: none once linked, the link when it needs no decision, else why it waits. */
function linkOne(target: Target, artifacts: string, apply: boolean): LinkResult[] {
  const plan = link(target, artifacts, false);
  if (plan.blocked) return [plan];
  if (plan.before === "linked") return [];
  if (AUTOMATIC.has(plan.action)) return [apply ? link(target, artifacts, true) : plan];
  const { name, project, store, before } = plan;
  return [{ name, project, store, before, blocked: `${LINK} holds this clone's own capture; run \`link\` there to decide` }];
}
