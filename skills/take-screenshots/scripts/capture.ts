/** Running a repository's capture under the lock and recording it. Node built-ins only, like artifacts.ts. */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { git, gitValue } from "./git";
import { linkState } from "./link";
import { acquireLock, alive, type LockInfo, replaceLock } from "./lock";
import { claimNamespace } from "./namespace";
import { type CaptureRecord, type FinishedStatus, type RecordFields, type RunningRecord, readRecord, transition, writeRecord } from "./record";
import { LINK, LOCK, storeDir, type Target } from "./store";
import { packageScripts } from "./targets";

export interface Runner {
  /**
   * Starts the repository's capture with inherited output and the given
   * environment, in a process group of its own when it can. Resolves with its
   * exit code and that group, which must be empty before the lock is released.
   */
  capture(root: string, args: string[], env: NodeJS.ProcessEnv, started: (pgid: number) => void): Promise<{ code: number | null; pgid?: number }>;
}

export const RUNNER: Runner = {
  capture(root, args, env, started) {
    return new Promise((resolve, reject) => {
      // detached gives the capture its own process group, so its descendants can be found, signalled, and waited for.
      const child = spawn("bun", ["run", "screenshots", ...args], { cwd: root, env, stdio: "inherit", detached: true });
      child.once("error", error => reject(new Error(`Could not run bun: ${error.message}`)));
      child.once("spawn", () => {
        if (child.pid) started(child.pid);
      });
      child.once("exit", code => resolve({ code, ...(child.pid ? { pgid: child.pid } : {}) }));
    });
  },
};

/**
 * Waits for every process in a group to exit, stopping them after `graceMs`.
 * `exited` means they finished on their own; `stopped` that they had to be
 * killed, so their output is incomplete; `stuck` that some still run.
 */
export async function drainGroup(pgid: number, graceMs = 30_000, killMs = 10_000): Promise<"exited" | "stopped" | "stuck"> {
  const empty = () => !alive(-pgid);
  const wait = async (ms: number) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise(done => setTimeout(done, 100))) if (empty()) return true;
    return empty();
  };
  if (await wait(graceMs)) return "exited";
  process.stderr.write(`Capture processes in group ${pgid} outlived the capture; stopping them, so this capture fails.\n`);
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    /* exited meanwhile */
  }
  if (await wait(killMs)) return "stopped";
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* exited meanwhile */
  }
  return (await wait(killMs)) ? "stopped" : "stuck";
}

/** A capture as planned: what it would run and record. */
export interface PlannedCapture {
  readonly name: string;
  readonly project: string;
  readonly store: string;
  readonly command: string;
  readonly commit: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly merged: boolean | null;
  readonly previous?: CaptureRecord;
  readonly applied?: never;
  readonly record?: never;
}

/** A planned capture that ran, with the record it left; `--json` prints `applied` before `record`. */
export interface AppliedCapture extends Omit<PlannedCapture, "applied" | "record"> {
  readonly applied: true;
  readonly record: CaptureRecord;
}

export type CapturePlan = PlannedCapture | AppliedCapture;

/** Local changes, including edits behind assume-unchanged or skip-worktree flags that git status cannot see. */
function isDirty(root: string): boolean {
  const checked = (...args: string[]) => {
    const result = git(root, ...args);
    // A check that fails proves nothing about the tree, so it never passes for clean.
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}; cannot tell whether it has local changes`);
    return result.stdout;
  };
  // `ls-files -v` tags assume-unchanged entries in lowercase and skip-worktree entries with S.
  if (
    checked("ls-files", "-v")
      .split("\n")
      .some(line => /^[a-zS] /.test(line))
  )
    return true;
  // Configured submodule ignore settings could hide a submodule's changes; count them all.
  return checked("status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none") !== "";
}

/** How long leftover capture processes get before they are stopped; tests shorten it. */
export interface Timing {
  readonly graceMs?: number;
  readonly killMs?: number;
}

export async function capture(
  target: Target,
  artifacts: string,
  options: { apply: boolean; allowDirty: boolean; args: string[] },
  runner: Runner = RUNNER,
  timing: Timing = {},
): Promise<CapturePlan> {
  const plan = planCapture(target, artifacts, options);
  if (!options.apply) return plan;
  return runCapture(target, artifacts, plan, options.args, runner, timing);
}

/** Checks the repository can be captured and describes the capture, changing nothing. */
function planCapture(target: Target, artifacts: string, options: { allowDirty: boolean; args: string[] }): PlannedCapture {
  if (typeof packageScripts(target.root).screenshots !== "string") {
    throw new Error(`${target.name} has no \`screenshots\` package script; see the take-screenshots skill's repository contract`);
  }
  const state = linkState(target, artifacts);
  if (state.state !== "linked") throw new Error(`${target.name}/${LINK} is ${state.state}, not linked to the store; run \`link --apply\` first`);
  const commit = gitValue(target.root, "rev-parse", "HEAD");
  if (!commit) throw new Error(`${target.name} has no commit to capture`);
  const dirty = isDirty(target.root);
  if (dirty && !options.allowDirty) {
    throw new Error(`${target.name} has local changes; a shared capture would publish them. Commit first, or pass --allow-dirty for a local-only look`);
  }
  const branch = gitValue(target.root, "symbolic-ref", "--quiet", "--short", "HEAD") ?? null;
  const upstream = gitValue(target.root, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD");
  const merged = upstream ? git(target.root, "merge-base", "--is-ancestor", commit, upstream).status === 0 : null;
  const store = storeDir(target, artifacts);
  const planned = readRecord(store);
  return {
    name: target.name,
    project: target.project,
    store,
    command: ["bun", "run", "screenshots", ...options.args].join(" "),
    commit,
    branch,
    dirty,
    merged,
    ...(planned ? { previous: planned } : {}),
  };
}

/** Runs a planned capture under the project's lock and records how it finished. */
async function runCapture(target: Target, artifacts: string, plan: PlannedCapture, args: string[], runner: Runner, timing: Timing): Promise<AppliedCapture> {
  const { store } = plan;
  const startedAt = new Date().toISOString();
  const lockFile = path.join(artifacts, target.project, LOCK);
  const holder: LockInfo = { pid: process.pid, host: os.hostname(), checkout: target.root, startedAt };
  const release = acquireLock(lockFile, holder);
  // Forward SIGINT and SIGTERM to the capture's group and finish here, so the record and lock are settled.
  let signal: NodeJS.Signals | undefined;
  let group: number | undefined;
  const hold = (received: NodeJS.Signals) => {
    signal = received;
    if (group !== undefined)
      try {
        process.kill(-group, received);
      } catch {
        /* already gone */
      }
  };
  process.on("SIGINT", hold);
  process.on("SIGTERM", hold);
  try {
    // Re-read under the lock: the previous capture is now settled.
    const previous = readRecord(store);
    const foreign = claimNamespace(target, artifacts, true);
    if (foreign) throw new Error(foreign);
    const { base, inheritsIncomplete } = runningRecord(target, plan, args, previous, startedAt);
    const running = transition(previous, { type: "start", fields: base });
    writeRecord(store, running);
    let exitCode: number | null = null;
    // Runners that honor SCREENSHOT_OUTPUT_DIR must write through the link, whatever the caller's shell exports.
    const env = { ...process.env, SCREENSHOT_OUTPUT_DIR: path.join(target.root, LINK) };
    let drained: Awaited<ReturnType<typeof drainGroup>> = "exited";
    let finished: CaptureRecord;
    try {
      const result = await runner.capture(target.root, args, env, pgid => {
        group = pgid;
        // Record the capture's own group in the lock, so a person can find leftovers if this process is killed.
        replaceLock(lockFile, { ...holder, pgid });
      });
      exitCode = result.code;
      if (result.pgid !== undefined) drained = await drainGroup(result.pgid, timing.graceMs, timing.killMs);
    } finally {
      finished = finishedRecord(target, artifacts, plan, running, { exitCode, signal, drained, inheritsIncomplete });
      // The capture may have replaced the shared directory's contents; the record goes back in either way.
      writeRecord(store, finished);
    }
    if (drained === "stuck") throw new Error(`capture processes in group ${group} would not stop; the lock ${lockFile} stays until they are gone`);
    release();
    return { ...plan, applied: true, record: finished };
  } catch (error) {
    // Release only when no capture process can still be writing.
    if (group === undefined || !alive(-group)) release();
    throw error;
  } finally {
    process.off("SIGINT", hold);
    process.off("SIGTERM", hold);
  }
}

/** The record's fields while the capture runs, and whether a complete one still counts as incomplete. */
function runningRecord(
  target: Target,
  plan: PlannedCapture,
  args: string[],
  previous: CaptureRecord | undefined,
  startedAt: string,
): { base: RecordFields; inheritsIncomplete: boolean } {
  const { commit, branch, dirty, merged } = plan;
  // A partial capture keeps whatever else the store holds; with no record, that is of unknown provenance.
  const partial = args.length > 0;
  const inheritsDirty = partial && previous?.dirty === true;
  const inheritsIncomplete = partial && (previous === undefined || previous.status !== "complete");
  const base = {
    schemaVersion: 1 as const,
    project: target.project,
    ...(target.repo ? { repo: target.repo } : {}),
    commit,
    branch,
    dirty: dirty || inheritsDirty,
    args,
    // Kept images are only as merged as the capture that made them.
    merged: partial && previous && previous.merged !== true && merged !== false ? previous.merged : merged,
    ...(partial && previous ? { over: { commit: previous.commit, status: previous.status, dirty: previous.dirty } } : {}),
    checkout: target.root,
    host: os.hostname(),
    startedAt,
  };
  return { base, inheritsIncomplete };
}

/** How a capture's run ended, as the finished record judges it. */
interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | undefined;
  readonly drained: Awaited<ReturnType<typeof drainGroup>>;
  readonly inheritsIncomplete: boolean;
}

/** The record of a finished capture, after checking that the clone still shows the planned commit through the link. */
function finishedRecord(target: Target, artifacts: string, plan: PlannedCapture, running: RunningRecord, outcome: RunOutcome): CaptureRecord {
  const { exitCode, signal, drained, inheritsIncomplete } = outcome;
  const shows = showsPlannedCommit(target, artifacts, plan);
  const finalStatus = (): FinishedStatus => {
    if (exitCode !== 0 || signal || !shows || drained !== "exited") return "failed";
    return inheritsIncomplete ? "incomplete" : "complete";
  };
  return transition(running, { type: "finish", status: finalStatus(), finishedAt: new Date().toISOString(), exitCode });
}

/**
 * Whether the clone still shows the planned commit through the link, saying why when it does not.
 * A check that fails proves nothing, so it counts as not showing it: the record must still be written.
 */
function showsPlannedCommit(target: Target, artifacts: string, plan: PlannedCapture): boolean {
  const { commit, dirty } = plan;
  let kept: boolean;
  let moved: boolean;
  try {
    // A capture that deleted and recreated .screenshots wrote into the clone, not the store.
    kept = linkState(target, artifacts).state === "linked";
    // The record names one commit: a branch switch or new edit mid-capture makes that untrue.
    moved = gitValue(target.root, "rev-parse", "HEAD") !== commit || (!dirty && isDirty(target.root));
  } catch (error) {
    process.stderr.write(
      `Could not check ${target.name} after the capture (${error instanceof Error ? error.message : String(error)}), so it fails; capture again.\n`,
    );
    return false;
  }
  if (moved)
    process.stderr.write(
      `${target.name} changed commit or gained local changes during the capture, so it does not show ${commit.slice(0, 10)}; capture again.\n`,
    );
  if (!kept)
    process.stderr.write(
      `${target.name}/${LINK} is no longer linked: the capture replaced it, so the store did not receive it. Never remove ${LINK} itself; clear its contents.\n`,
    );
  return kept && !moved;
}
