/** Which repositories other processes are working in. Node built-ins only, like space-cleanup.ts. */
import { spawnSync } from "node:child_process";
import path from "node:path";

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  /** Process group: members of the caller's shell pipeline share it. */
  readonly pgid?: number;
  readonly name: string;
  readonly args: string;
  cwd?: string;
}

const PIPELINE_FILTERS = new Set(["head", "tail", "less", "more", "cat", "tee", "grep", "rg", "sed", "awk", "jq", "sort", "uniq", "wc", "cut", "tr", "column"]);
/** An interactive shell waiting at a prompt; `bash build.sh` and `sh -c ...` are working. */
const IDLE_SHELL = /^-?(?:\S*\/)?(?:zsh|bash|sh|fish|dash|tmux)(?:\s+-[il]+)*$/;
export function idleShell(proc: Proc): boolean { return IDLE_SHELL.test(proc.args.trim()); }

/** Every process's cwd; throws when it cannot list them, so busy repositories are never mistaken for idle ones. */
export function processes(): Proc[] {
  const list = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // lsof exits 1 when some processes are unreadable but still lists the rest; completeness is checked below.
    if (result.error || !result.stdout || (result.status !== 0 && !(command === "lsof" && result.status === 1))) {
      throw new Error(`cannot list processes with ${command} (${result.error?.message ?? `exit ${result.status}`}); ${UNLISTED}`);
    }
    return result.stdout;
  };
  const table = list("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,comm="]);
  const args = list("ps", ["-axo", "pid=,args="]);
  const cwds = list("lsof", ["-nP", "-d", "cwd", "-Fpn"]);
  return parseProcesses(table, args, cwds, process.getuid?.() ?? -1, pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

const UNLISTED = "without every process's working directory busy repositories cannot be detected, so pass --include-busy only if none is in use";

/**
 * Joins `ps` and `lsof` output. Throws when a live process of this user has no
 * known working directory, so partial visibility never passes for idle.
 * Other users' processes (root daemons) are listed when lsof can read them.
 */
export function parseProcesses(table: string, argsOutput: string, lsofOutput: string, uid: number, alive: (pid: number) => boolean): Proc[] {
  const rows: Array<{ pid: number; ppid: number; pgid: number; uid: number; zombie: boolean; name: string }> = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), zombie: match[5]!.startsWith("Z"), name: path.basename(match[6]!.trim()) });
  }
  const args = new Map<number, string>();
  for (const line of argsOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]!);
  }
  const cwds = new Map<number, string>();
  let current = 0;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current) cwds.set(current, line.slice(1));
  }
  // A process that exited between ps and lsof has nothing left to protect.
  const unseen = rows.filter(row => row.uid === uid && !row.zombie && !cwds.has(row.pid) && alive(row.pid));
  if (unseen.length > 0) {
    throw new Error(`cannot read the working directory of ${unseen.slice(0, 3).map(row => `${row.name} ${row.pid}`).join(", ")}${unseen.length > 3 ? ", ..." : ""}; ${UNLISTED}`);
  }
  return rows.filter(row => !row.zombie).map(({ pid, ppid, pgid, name }) => ({ pid, ppid, pgid, name, args: args.get(pid) ?? "", cwd: cwds.get(pid) }));
}

/** Absolute paths that a command line's path-like arguments (`a/b`, `--flag=./x`, `-C dir`) resolve to. */
export function argumentPaths(args: string, cwd: string): string[] {
  const paths: string[] = [];
  for (const token of args.split(/\s+/).slice(1)) {
    const value = token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (value === "" || value.startsWith("-")) continue;
    if (value.includes("/") || value === "." || value === "..") paths.push(path.resolve(cwd, value));
  }
  return paths;
}

/**
 * Processes working in each root, other than this script, its ancestors (the
 * agent or shell that ran it), its children, idle shells, and text filters
 * in its process group (`| head`, `| jq`: the rest of the caller's pipeline).
 * A process counts for the root holding its cwd and for every root a path in
 * its arguments points into.
 * A build or server in the same group still counts: non-interactive shells
 * put background jobs there too. A process in a
 * nested root counts only for the deepest root containing it.
 */
export function busyRoots(procs: Proc[], roots: string[], self = process.pid): Map<string, Proc[]> {
  const parent = new Map(procs.map(proc => [proc.pid, proc.ppid]));
  const ancestors = new Set<number>();
  for (let pid: number | undefined = self; pid && !ancestors.has(pid); pid = parent.get(pid)) ancestors.add(pid);
  const group = procs.find(proc => proc.pid === self)?.pgid;
  const busy = new Map<string, Proc[]>();
  const byDepth = roots.toSorted((a, b) => b.length - a.length);
  for (const proc of procs) {
    const pipeline = group !== undefined && proc.pgid === group && PIPELINE_FILTERS.has(proc.name);
    if (!proc.cwd || ancestors.has(proc.pid) || proc.ppid === self || pipeline || idleShell(proc)) continue;
    const deepest = (location: string) => byDepth.find(candidate => location === candidate || location.startsWith(`${candidate}/`));
    const touched = new Set<string>();
    const home = deepest(proc.cwd);
    if (home) touched.add(home);
    // A process can work in a root it is not in: `cargo build --manifest-path checkouts/app/Cargo.toml`.
    for (const location of argumentPaths(proc.args, proc.cwd)) {
      const root = deepest(location);
      if (root) touched.add(root);
    }
    for (const root of touched) busy.set(root, [...(busy.get(root) ?? []), proc]);
  }
  return busy;
}
