/** Each clone's `.screenshots` link into the shared store. Node built-ins only, like artifacts.ts. */
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, type Stats, symlinkSync,
} from "node:fs";
import path from "node:path";
import { claimNamespace } from "./namespace";
import { lexists, LINK, storeDir, type Target } from "./store";

export type LinkState =
  | { readonly state: "linked" }
  | { readonly state: "missing" }
  | { readonly state: "directory"; readonly entries: number }
  | { readonly state: "elsewhere"; readonly target: string }
  | { readonly state: "other" };

function sameFile(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

export function linkState(target: Target, artifacts: string): LinkState {
  const link = path.join(target.root, LINK);
  let stats: Stats;
  try { stats = lstatSync(link); } catch { return { state: "missing" }; }
  if (stats.isSymbolicLink()) {
    const destination = path.resolve(target.root, readlinkSync(link));
    // A link to the store's path counts even before the first capture creates the directory.
    return destination === storeDir(target, artifacts) || sameFile(destination, storeDir(target, artifacts))
      ? { state: "linked" }
      : { state: "elsewhere", target: destination };
  }
  if (stats.isDirectory()) return { state: "directory", entries: readdirSync(link).length };
  return { state: "other" };
}

/**
 * Whether the root .gitignore ignores `.screenshots` whatever its type. A
 * trailing slash (`.screenshots/`) matches only a directory, so the link would
 * show up as untracked and hold back `matrix sync`.
 */
function ignorePatternMatchesFile(root: string): boolean {
  let text = "";
  try { text = readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { return false; }
  return text.split("\n").map(line => line.trim()).some(line => [LINK, `/${LINK}`, `**/${LINK}`].includes(line));
}

function emptyOrMissing(directory: string): boolean {
  try { return readdirSync(directory).length === 0; } catch { return !lexists(directory); }
}

export interface LinkResult {
  readonly name: string;
  readonly project: string;
  readonly store: string;
  readonly before: LinkState["state"];
  /** What --apply does or did; absent when nothing needs doing. */
  readonly action?: "link" | "move-and-link" | "replace-empty-directory" | "supersede-and-link";
  /** With --supersede, where the clone's own capture was moved. */
  readonly superseded?: string;
  readonly applied?: boolean;
  /** Why it cannot be linked automatically. */
  readonly blocked?: string;
}

/** Plan, and with apply perform, the link for one repository. */
export function link(target: Target, artifacts: string, apply: boolean, supersede = false, now = new Date()): LinkResult {
  const store = storeDir(target, artifacts);
  const base = { name: target.name, project: target.project, store };
  const state = linkState(target, artifacts);
  const blocked = (reason: string): LinkResult => ({ ...base, before: state.state, blocked: reason });
  // A linked clone whose origin now names another repository must not keep reading this namespace.
  if (state.state === "linked") {
    // With --apply this also records a GitHub-confirmed rename in the owner file.
    const foreign = claimNamespace(target, artifacts, apply);
    return foreign ? blocked(`${foreign}; remove ${LINK} from this clone`) : { ...base, before: "linked" };
  }
  if (isInside(artifacts, target.root)) return blocked(`the store ${artifacts} is inside the repository`);
  if (!ignorePatternMatchesFile(target.root)) return blocked(`the root .gitignore must list ${LINK} without a trailing slash, so the link is ignored`);
  const foreign = claimNamespace(target, artifacts, false);
  if (foreign) return blocked(foreign);
  if (state.state === "elsewhere") return blocked(`${LINK} already links to ${state.target}; remove it by hand if that is stale`);
  if (state.state === "other") return blocked(`${LINK} is neither a directory nor a link`);
  let action: LinkResult["action"] = "link";
  if (state.state === "directory") {
    if (state.entries === 0) action = "replace-empty-directory";
    else if (emptyOrMissing(store)) action = "move-and-link";
    else if (supersede) action = "supersede-and-link";
    else return blocked(`${LINK} holds a capture and the store already holds another; compare them, then rerun with --supersede to move this clone's aside`);
  }
  // Kept, never deleted: a person removes superseded captures once nothing needs them.
  const superseded = action === "supersede-and-link"
    ? path.join(artifacts, target.project, "superseded", `${target.name}-${now.toISOString().replace(/[:.]/g, "-")}`)
    : undefined;
  if (!apply) return { ...base, before: state.state, action, ...(superseded ? { superseded } : {}) };
  // Recheck at apply time: another process may have linked or written since the plan.
  const current = linkState(target, artifacts);
  if (current.state !== state.state || (current.state === "directory" && state.state === "directory" && current.entries !== state.entries)) {
    return blocked(`${LINK} changed while planning; run link again`);
  }
  const claimed = claimNamespace(target, artifacts, true);
  if (claimed) return blocked(claimed);
  mkdirSync(path.dirname(store), { recursive: true });
  const linkPath = path.join(target.root, LINK);
  const relative = path.relative(realpathSync(target.root), path.join(realpathSync(path.dirname(store)), path.basename(store)));
  if (action === "move-and-link") {
    if (lexists(store)) rmdirSync(store); // empty, checked above; rename cannot replace it across all platforms
    try { renameSync(linkPath, store); } catch (error) {
      return blocked(`could not move ${LINK} into the store (${(error as NodeJS.ErrnoException).code ?? String(error)}); move it by hand`);
    }
  } else if (action === "supersede-and-link") {
    mkdirSync(path.dirname(superseded!), { recursive: true });
    if (lexists(superseded!)) return blocked(`${superseded} already exists; run link again`);
    renameSync(linkPath, superseded!);
  } else if (action === "replace-empty-directory") {
    rmdirSync(linkPath); // fails, safely, if something was written meanwhile
    mkdirSync(store, { recursive: true });
  } else {
    mkdirSync(store, { recursive: true });
  }
  try { symlinkSync(relative, linkPath); } catch (error) {
    if (action === "move-and-link") renameSync(store, linkPath);
    if (action === "supersede-and-link") renameSync(superseded!, linkPath);
    throw error;
  }
  return { ...base, before: state.state, action, applied: true, ...(superseded ? { superseded } : {}) };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
