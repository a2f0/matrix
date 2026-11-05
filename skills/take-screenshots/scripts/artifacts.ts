#!/usr/bin/env bun
/**
 * Shared screenshot store for every clone of a repository.
 *
 * Captured screenshots live outside the clones, in
 * `<artifacts>/<project>/screenshots`, and each clone's gitignored
 * `.screenshots` is a symlink to it. A capture in any clone therefore updates
 * every clone, and a build or deploy in any clone publishes the newest capture
 * instead of whatever that clone last took.
 *
 * `capture` runs the repository's own `bun run screenshots` under a per-project
 * lock and records its provenance in `.screenshots/capture.json`, which builds
 * read before they publish. `link` and `capture` are dry runs until `--apply`.
 *
 * Uses only Node built-ins so it runs by path from any repository.
 */
import path from "node:path";
import { capture, RUNNER, type Runner, type Timing } from "./capture";
import { type LinkState, link, linkState } from "./link";
import { type LockInfo, readLock } from "./lock";
import { claimNamespace, existingCase, knownNamespace } from "./namespace";
import { type CaptureRecord, RECORD, readRecord, relation } from "./record";
import { LOCK, storeDir, type Target } from "./store";
import { artifactsRoot, resolveTargets } from "./targets";

const USAGE = `Usage: artifacts.ts <command> [repo...] [options]

  status [repo...]          Link state and newest capture of each repository
  link [repo...] [--apply] [--supersede]
                            Point each repository's .screenshots at the shared store,
                            moving an existing capture there when the store is empty;
                            --supersede moves it to <project>/superseded/ instead
  capture [repo] [--apply] [--allow-dirty] [-- capture args...]
                            Run the repository's \`bun run screenshots\` under a lock
                            and record the capture's commit in .screenshots/capture.json

Repos are checkout names or paths; none selects the current repository, or in a
matrix workspace every checkout that captures screenshots. MATRIX_ARTIFACTS_DIR
overrides the store, which defaults to matrix-artifacts beside the workspace
(or beside the repository outside one). --json prints the report as JSON.
`;

interface StatusEntry {
  readonly name: string;
  /** Set when the namespace belongs to another repository than this clone's origin. */
  readonly foreign?: string;
  readonly project: string;
  readonly store: string;
  readonly link: LinkState;
  readonly capture?: CaptureRecord;
  readonly sinceCapture?: ReturnType<typeof relation>;
  readonly lock?: LockInfo;
}

function status(target: Target, artifacts: string): StatusEntry {
  const store = storeDir(target, artifacts);
  const capture = readRecord(store);
  const lock = readLock(path.join(artifacts, target.project, LOCK));
  const foreign = claimNamespace(target, artifacts, false);
  return {
    name: target.name,
    ...(foreign ? { foreign } : {}),
    project: target.project,
    store,
    link: linkState(target, artifacts),
    ...(capture ? { capture, sinceCapture: relation(target.root, capture.commit) } : {}),
    ...(lock ? { lock } : {}),
  };
}

export interface Options {
  readonly command: "status" | "link" | "capture";
  readonly names: string[];
  readonly apply: boolean;
  readonly json: boolean;
  readonly allowDirty: boolean;
  readonly supersede: boolean;
  readonly project?: string;
  readonly captureArgs: string[];
}

export function parseOptions(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "link" && command !== "capture") throw new Error(`unknown command '${command ?? ""}'\n\n${USAGE}`);
  const split = rest.indexOf("--");
  const own = split === -1 ? rest : rest.slice(0, split);
  const captureArgs = split === -1 ? [] : rest.slice(split + 1);
  if (captureArgs.length > 0 && command !== "capture") throw new Error("only capture forwards arguments after --");
  const names: string[] = [];
  let apply = false,
    json = false,
    allowDirty = false,
    supersede = false,
    project: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else if (arg === "--allow-dirty") allowDirty = true;
    else if (arg === "--supersede") supersede = true;
    else if (arg === "--project")
      project =
        own[++index] ??
        (() => {
          throw new Error("--project needs a name");
        })();
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }
  if (apply && command === "status") throw new Error("status changes nothing; --apply does not apply");
  if (allowDirty && command !== "capture") throw new Error("--allow-dirty applies only to capture");
  if (supersede && command !== "link") throw new Error("--supersede applies only to link");
  return { command, names, apply, json, allowDirty, supersede, captureArgs, ...(project ? { project } : {}) };
}

function describeCapture(entry: StatusEntry): string {
  const record = entry.capture;
  if (!record) return "no capture recorded";
  const since = entry.sinceCapture!;
  const where = {
    current: "at HEAD",
    behind: `${since.commits} commit(s) behind HEAD`,
    ahead: `${since.commits} commit(s) ahead of HEAD`,
    diverged: "on a branch HEAD does not contain",
    unknown: "commit not in this clone; fetch",
  }[since.relation];
  const flags = [
    record.dirty ? "dirty" : "",
    record.merged === false ? "unmerged" : "",
    record.args.length > 0 ? `partial: ${record.args.join(" ")}` : "",
  ].filter(Boolean);
  return `${record.status} ${record.finishedAt ?? record.startedAt} at ${record.commit.slice(0, 10)}${record.branch ? ` (${record.branch})` : ""}, ${where}${flags.length ? `; ${flags.join(", ")}` : ""}`;
}

export async function main(
  argv: string[],
  cwd = process.cwd(),
  runner: Runner = RUNNER,
  print: (text: string) => void = text => console.log(text),
  timing: Timing = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    print(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const options = parseOptions(argv);
  const { targets: found } = resolveTargets(cwd, options.names, options.project);
  if (found.length === 0) {
    print(options.json ? "[]" : "No repository here captures screenshots.");
    return 0;
  }
  const artifacts = artifactsRoot(found[0]!.root);
  if (found.some(target => artifactsRoot(target.root) !== artifacts))
    throw new Error("the selected repositories resolve different stores; set MATRIX_ARTIFACTS_DIR");
  const targets = found.map(target => existingCase(knownNamespace(target, artifacts), artifacts));
  if (options.command === "status") {
    const entries = targets.map(target => status(target, artifacts));
    if (options.json) print(JSON.stringify({ artifacts, entries }, null, 2));
    else
      for (const entry of entries) {
        const lock = entry.lock ? `; capture running in ${entry.lock.checkout} (pid ${entry.lock.pid})` : "";
        print(
          `${entry.name} [${entry.project}] ${entry.link.state}: ${entry.foreign ? `NOT THIS REPOSITORY'S: ${entry.foreign}` : describeCapture(entry)}${lock}`,
        );
      }
    return entries.every(entry => entry.link.state === "linked" && !entry.foreign) ? 0 : 1;
  }
  if (options.command === "link") {
    const results = targets.map(target => link(target, artifacts, options.apply, options.supersede));
    if (options.json) print(JSON.stringify({ artifacts, apply: options.apply, results }, null, 2));
    else
      for (const result of results) {
        const outcome = result.blocked
          ? `blocked: ${result.blocked}`
          : !result.action
            ? "already linked"
            : `${result.applied ? "done" : "would"} ${result.action} -> ${result.store}${result.superseded ? `; its own capture to ${result.superseded}` : ""}`;
        print(`${result.name} [${result.project}] ${outcome}`);
      }
    if (!options.json && !options.apply && results.some(result => result.action && !result.blocked)) print("Dry run; rerun with --apply.");
    return results.some(result => result.blocked) ? 1 : 0;
  }
  if (targets.length !== 1) throw new Error("capture runs one repository at a time; name it");
  const plan = await capture(targets[0]!, artifacts, { apply: options.apply, allowDirty: options.allowDirty, args: options.captureArgs }, runner, timing);
  if (options.json) print(JSON.stringify(plan, null, 2));
  else if (!plan.applied) {
    print(
      `Would run \`${plan.command}\` in ${targets[0]!.root} at ${plan.commit.slice(0, 10)}${plan.merged === false ? " (not on origin's default branch)" : ""}, writing ${plan.store}.`,
    );
    if (plan.previous) print(`Replaces the ${plan.previous.status} capture of ${plan.previous.commit.slice(0, 10)} from ${plan.previous.checkout}.`);
    print("Dry run; rerun with --apply.");
  } else print(`Capture ${plan.record!.status} (exit ${plan.record!.exitCode}); recorded in ${path.join(plan.store, RECORD)}.`);
  return plan.applied && plan.record!.status !== "complete" ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
