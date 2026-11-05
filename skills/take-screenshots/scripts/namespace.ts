/** Which store namespace a repository uses, and the owner file that reserves it. Node built-ins only, like artifacts.ts. */
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitValue } from "./git";
import { readRecord } from "./record";
import { LINK, lexists, type Target, writeAtomic } from "./store";

/** owner/name from a GitHub remote URL in the forms Git accepts; any other host is not GitHub. */
export function githubRepo(url: string): string | undefined {
  const match =
    /^(?:git@github\.com:|(?:ssh:\/\/)?git@github\.com\/|(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * owner/name as GitHub reports it now, following renames and fixing case. Asks
 * about origin's repository by name, since bare `gh repo view` prefers an
 * `upstream` remote and would name a fork's parent. MATRIX_ARTIFACTS_NO_GH
 * skips the network (offline use and tests).
 */
function canonicalRepo(root: string, parsed?: string): Resolved | undefined {
  if (process.env.MATRIX_ARTIFACTS_NO_GH) return undefined;
  if (!parsed && gitValue(root, "remote", "get-url", "origin") === undefined) return undefined;
  const result = spawnSync("gh", ["repo", "view", ...(parsed ? [parsed] : []), "--json", "nameWithOwner,id", "--jq", '.nameWithOwner + " " + .id'], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [repo, id] = result.status === 0 ? result.stdout.trim().split(/\s+/) : [];
  return repo && /^[^/\s]+\/[^/\s]+$/.test(repo) ? { repo, ...(id ? { id } : {}) } : undefined;
}

/** GitHub's current name for a repository and its node id, which survives renames and transfers. */
export interface Resolved {
  readonly repo: string;
  readonly id?: string;
}

/**
 * A repository's store namespace: its GitHub name, like matrix-secrets'. GitHub
 * names it when reachable (a clone's remote can carry a pre-rename name or other
 * casing); otherwise origin's URL does. A repository with neither needs --project.
 */
export function targetFor(root: string, project?: string, resolve: (root: string, parsed?: string) => Resolved | string | undefined = canonicalRepo): Target {
  const remote = gitValue(root, "remote", "get-url", "origin");
  const parsed = remote ? githubRepo(remote) : undefined;
  const resolved = resolve(root, parsed);
  const canonical = typeof resolved === "string" ? resolved : resolved?.repo;
  const id = typeof resolved === "string" ? undefined : resolved?.id;
  const repo = canonical ?? parsed;
  if (!repo && !project) throw new Error(`${root} has no GitHub origin; pass --project to name its namespace`);
  const name = project ?? repo!.split("/")[1]!;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`'${name}' is not a usable project name`);
  return {
    name: path.basename(root),
    root,
    project: name,
    ...(repo ? { repo } : {}),
    verified: canonical !== undefined,
    ...(canonical && parsed && parsed !== canonical ? { alias: parsed } : {}),
    ...(project ? { explicit: true } : {}),
    ...(id ? { id } : {}),
  };
}

/** The repository a namespace belongs to, reserved by the first clone that links or captures into it. */
const OWNER = "repository.json";

/** A namespace's owner file: its repository and the remote names GitHub confirmed for it. */
interface Owner {
  repo: string;
  aliases: string[];
  id?: string | undefined;
  explicit?: boolean | undefined;
}

function readOwner(file: string): Owner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { repo?: unknown; aliases?: unknown; id?: unknown; explicit?: unknown };
    if (typeof value.repo !== "string" || value.repo === "") return undefined;
    const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    return { repo: value.repo, aliases, ...(typeof value.id === "string" ? { id: value.id } : {}), ...(value.explicit === true ? { explicit: true } : {}) };
  } catch {
    return undefined;
  }
}

/** Adds a GitHub-confirmed remote name to the owner file, atomically, so offline clones still find the namespace. */
function writeOwner(file: string, owner: Owner): void {
  const body = {
    repo: owner.repo,
    ...(owner.aliases.length ? { aliases: owner.aliases } : {}),
    ...(owner.id ? { id: owner.id } : {}),
    ...(owner.explicit ? { explicit: true } : {}),
  };
  writeAtomic(file, `${JSON.stringify(body)}\n`);
}

/**
 * Read, change, and write the owner file under its own short lock, so two
 * clones recording different aliases at once both keep theirs. `change`
 * returns the new owner, or undefined to leave the file alone.
 */
export function updateOwner(file: string, change: (owner: Owner | undefined) => Owner | undefined, waitMs = 10_000): void {
  const lock = `${file}.lock`;
  const mine = `${lock}.${process.pid}.${process.hrtime.bigint()}`;
  writeFileSync(mine, `${process.pid}\n`, { flag: "wx" });
  try {
    for (const deadline = Date.now() + waitMs; ; ) {
      try {
        linkSync(mine, lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Never broken automatically: two recovering processes could each remove the other's fresh lock.
        if (Date.now() > deadline)
          throw new Error(`${lock} is held; an update takes milliseconds, so if no link or capture is running it was left by a killed process: remove it`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      const next = change(readOwner(file));
      if (next) writeOwner(file, next);
    } finally {
      unlinkSync(lock);
    }
  } finally {
    unlinkSync(mine);
  }
}

/** Reserve the namespace for this repository, or explain whose it is. */
export function claimNamespace(target: Target, artifacts: string, apply: boolean): string | undefined {
  const file = path.join(artifacts, target.project, OWNER);
  const identity = target.repo ?? `local:${target.project}`;
  const lower = (name: string) => name.toLowerCase();
  const foreign = (holder: string) => `the store holds captures of ${holder}, not ${identity}; pass --project to use another namespace`;
  const decide = (owner: Owner | undefined, damaged: boolean): { error?: string; next?: Owner } => {
    if (damaged) return { error: foreign("(unreadable repository.json)") };
    if (!owner) {
      const recorded = readRecord(path.join(artifacts, target.project, "screenshots"))?.repo;
      const renamed = target.alias !== undefined && recorded !== undefined && lower(recorded) === lower(target.alias);
      if (recorded !== undefined && lower(recorded) !== lower(identity) && !renamed) return { error: foreign(recorded) };
      return {
        next: {
          repo: identity,
          aliases: target.verified && target.alias ? [target.alias] : [],
          id: target.verified ? target.id : undefined,
          explicit: target.explicit,
        },
      };
    }
    // GitHub's node id survives renames and transfers; a different id is a different repository, whatever its name.
    if (target.verified && target.id !== undefined && owner.id !== undefined && owner.id !== target.id) {
      return { error: foreign(`${owner.repo} (another GitHub repository, ${owner.id})`) };
    }
    const names = [owner.repo, ...owner.aliases].map(lower);
    const sameName = lower(owner.repo) === lower(identity);
    // The same repository after renames or transfers: GitHub confirmed origin's old name, which the namespace
    // knows, or GitHub's id matches the recorded one.
    const priorName = target.alias !== undefined && names.includes(lower(target.alias));
    const sameId = target.verified === true && target.id !== undefined && owner.id === target.id;
    if (!sameName && !(target.verified && (priorName || sameId))) return { error: foreign(owner.repo) };
    if (!target.verified) return {};
    const aliases = [...owner.aliases, owner.repo, ...(target.alias ? [target.alias] : [])].filter(
      (name, index, all) => lower(name) !== lower(identity) && all.findIndex(other => lower(other) === lower(name)) === index,
    );
    const next = { ...owner, repo: identity, aliases, id: owner.id ?? target.id };
    const changed = JSON.stringify(next) !== JSON.stringify({ ...owner, id: owner.id });
    return changed ? { next } : {};
  };
  const damaged = () => lexists(file) && readOwner(file) === undefined;
  if (!apply) return decide(readOwner(file), damaged()).error;
  // Decide and write under the owner lock, so a concurrent claim sees this one's result.
  mkdirSync(path.dirname(file), { recursive: true });
  let error: string | undefined;
  updateOwner(file, owner => {
    const result = decide(owner, damaged());
    error = result.error;
    return result.error ? undefined : result.next;
  });
  return error;
}

/**
 * The target with its project spelled like an existing namespace that differs
 * only in case, so a repository whose GitHub name gains capitals keeps its store
 * on case-sensitive filesystems too.
 */
export function existingCase(target: Target, artifacts: string): Target {
  if (target.explicit) return target;
  let entries: string[];
  try {
    entries = readdirSync(artifacts);
  } catch {
    return target;
  }
  if (entries.includes(target.project)) return target;
  const variant = entries.find(entry => entry.toLowerCase() === target.project.toLowerCase());
  return variant ? { ...target, project: variant } : target;
}

/**
 * The namespace that already serves this repository: one whose owner file names
 * its GitHub repository, or lists origin's name as an alias GitHub confirmed
 * earlier. Renames and transfers therefore keep one store whether a clone's
 * remote uses the old or the new name, online or offline. --project is never
 * overridden.
 */
export function knownNamespace(target: Target, artifacts: string): Target {
  if (!target.repo) return target;
  if (target.explicit) {
    // The chosen namespace stays; offline, a confirmed old name of its owner still counts as that owner.
    const owner = readOwner(path.join(artifacts, target.project, OWNER));
    const confirmed = !target.verified && owner?.aliases.some(alias => alias.toLowerCase() === target.repo!.toLowerCase());
    return confirmed ? { ...target, repo: owner!.repo } : target;
  }
  let entries: string[];
  try {
    entries = readdirSync(artifacts);
  } catch {
    return target;
  }
  const names = [target.repo, target.alias].filter((name): name is string => name !== undefined).map(name => name.toLowerCase());
  const matches = entries
    .filter(entry => !entry.startsWith("."))
    .flatMap(entry => {
      const owner = readOwner(path.join(artifacts, entry, OWNER));
      if (!owner) return [];
      const canonical = owner.repo.toLowerCase() === target.repo!.toLowerCase();
      // Offline, origin's name counts only as an alias GitHub confirmed for that namespace.
      const confirmed = owner.aliases.some(alias => names.includes(alias.toLowerCase()));
      const verifiedAlias = target.verified && target.alias !== undefined && owner.repo.toLowerCase() === target.alias.toLowerCase();
      return canonical || confirmed || verifiedAlias ? [{ entry, owner, canonical }] : [];
    });
  // Prefer the namespace this clone already links to, then the one its current name owns (its own
  // directory first), then this project's directory, so an extra --project namespace never takes over.
  let linked: string | undefined;
  try {
    const relative = path.relative(artifacts, path.resolve(target.root, readlinkSync(path.join(target.root, LINK)))).split(path.sep);
    if (relative.length === 2 && relative[1] === "screenshots") linked = relative[0];
  } catch {
    /* not linked */
  }
  // Namespaces made with --project are extras: used implicitly only by a clone already linked to one.
  const primary = matches.filter(match => !match.owner.explicit);
  const chosen =
    matches.find(match => match.entry === linked) ??
    primary.find(match => match.canonical && match.entry === target.project) ??
    primary.find(match => match.entry === target.project) ??
    primary.find(match => match.canonical) ??
    primary[0];
  if (!chosen) return target;
  return { ...target, project: chosen.entry, repo: target.verified ? target.repo : chosen.owner.repo };
}
