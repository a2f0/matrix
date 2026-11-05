/** The repositories a command selects, and the store they share. Node built-ins only, like artifacts.ts. */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { toplevel } from "./git";
import { targetFor } from "./namespace";
import { lexists, LINK, type Target } from "./store";

// Kept in sync with space-cleanup/scripts/targets.ts isMatrixWorkspace.
export function isMatrixWorkspace(root: string): boolean {
  return existsSync(path.join(root, "matrix.json")) && existsSync(path.join(root, "checkouts"));
}

/** The matrix workspace a repository is, or is a checkout of. */
export function workspaceOf(root: string): string | undefined {
  if (isMatrixWorkspace(root)) return root;
  const parent = path.dirname(root);
  return path.basename(parent) === "checkouts" && isMatrixWorkspace(path.dirname(parent)) ? path.dirname(parent) : undefined;
}

/** MATRIX_ARTIFACTS_DIR, or matrix-artifacts beside the workspace (beside the repository outside one), like matrix-secrets. */
export function artifactsRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MATRIX_ARTIFACTS_DIR || path.join(workspaceOf(root) ?? root, "..", "matrix-artifacts"));
}

export function packageScripts(root: string): Record<string, unknown> {
  try {
    const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: unknown }).scripts;
    return typeof scripts === "object" && scripts !== null ? scripts as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Whether a repository captures screenshots: a `screenshots` script, or a capture left in .screenshots. */
export function captures(root: string): boolean {
  return typeof packageScripts(root).screenshots === "string" || lexists(path.join(root, LINK));
}

/**
 * Repositories to act on: named checkouts or paths, else every checkout that
 * captures, else the current repository. Checkout listing and names are kept
 * in sync with space-cleanup/scripts/targets.ts resolveTargets;
 * src/takeScreenshots.test.ts compares the two.
 */
export function resolveTargets(cwd: string, names: string[], project?: string): { workspace?: string; targets: Target[] } {
  const here = toplevel(cwd);
  const workspace = here && isMatrixWorkspace(realpathSync(here)) ? realpathSync(here) : undefined;
  if (project && names.length > 1) throw new Error("--project names one repository's namespace; select one repository");
  if (names.length === 0) {
    if (workspace) {
      const roots = readdirSync(path.join(workspace, "checkouts"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(path.join(workspace, "checkouts", entry.name, ".git")))
        .map(entry => realpathSync(path.join(workspace, "checkouts", entry.name)))
        .filter(captures)
        .sort();
      if (project) throw new Error("--project needs one named repository");
      return { workspace, targets: roots.map(root => targetFor(root)) };
    }
    if (!here) throw new Error(`${cwd} is not inside a git repository; name one`);
    return { targets: [targetFor(realpathSync(here), project)] };
  }
  const roots = names.map(name => {
    const short = name.includes("/") && !existsSync(path.resolve(cwd, name)) ? name.split("/").pop()! : name;
    if (workspace && existsSync(path.join(workspace, "checkouts", short, ".git"))) return realpathSync(path.join(workspace, "checkouts", short));
    const top = existsSync(path.resolve(cwd, name)) ? toplevel(path.resolve(cwd, name)) : undefined;
    if (!top) throw new Error(`${name} is neither a checkout name nor a path inside a git repository`);
    return realpathSync(top);
  });
  return { workspace, targets: [...new Set(roots)].map(root => targetFor(root, project)) };
}
