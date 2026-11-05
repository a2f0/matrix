/** The repositories a run covers. Node built-ins only, like state-machines.ts. */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { git } from "./git";

export interface Target {
  readonly name: string;
  readonly root: string;
}

// Kept in sync with space-cleanup/scripts/targets.ts toplevel.
function toplevel(directory: string): string | undefined {
  const result = git(directory, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : undefined;
}

// Kept in sync with space-cleanup/scripts/targets.ts isMatrixWorkspace.
function isMatrixWorkspace(root: string): boolean {
  return existsSync(path.join(root, "matrix.json")) && existsSync(path.join(root, "checkouts"));
}

/**
 * Repositories to scan. From a matrix workspace: the workspace and every
 * checkout, or the named checkouts. From anywhere else: the repository
 * containing the working directory, or the named paths. Checkout listing and
 * names are kept in sync with space-cleanup/scripts/targets.ts
 * resolveTargets; src/explicitStateMachines.test.ts compares the two.
 */
export function resolveTargets(cwd: string, names: string[]): { workspace?: string; targets: Target[] } {
  // Real paths, so they compare equal to the cwd paths lsof reports.
  const here = toplevel(cwd) && realpathSync(toplevel(cwd)!);
  const workspace = here && isMatrixWorkspace(here) ? here : undefined;
  const checkouts = (root: string) =>
    readdirSync(path.join(root, "checkouts"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(root, "checkouts", entry.name, ".git")))
      .map(entry => ({ name: entry.name, root: realpathSync(path.join(root, "checkouts", entry.name)) }));
  if (names.length === 0) {
    if (workspace) return { workspace, targets: [{ name: path.basename(workspace), root: workspace }, ...checkouts(workspace)] };
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return { targets: [{ name: path.basename(here), root: here }] };
  }
  const targets = names.map(name => {
    const short = name.includes("/") && !existsSync(path.resolve(cwd, name)) ? name.split("/").pop()! : name;
    if (workspace && existsSync(path.join(workspace, "checkouts", short, ".git"))) {
      const root = realpathSync(path.join(workspace, "checkouts", short));
      return { name: path.basename(root), root };
    }
    const top = existsSync(path.resolve(cwd, name)) ? toplevel(path.resolve(cwd, name)) : undefined;
    if (!top) throw new Error(`${name} is neither a checkout name nor a path inside a git repository`);
    const root = realpathSync(top);
    return { name: path.basename(root), root };
  });
  return { workspace, targets: targets.filter((target, index) => targets.findIndex(other => other.root === target.root) === index) };
}
