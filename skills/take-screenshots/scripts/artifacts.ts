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
 * read before they publish. It first links every clone of the store's projects
 * that has no `.screenshots`, itself included, so clones never drift apart.
 * `link` and `capture` are dry runs until `--apply`.
 *
 * Uses only Node built-ins so it runs by path from any repository.
 */
import path from "node:path";
import { type CapturePlan, capture, RUNNER, type Runner, type Timing } from "./capture";
import { clonesSharing, linkAutomatically, sharedStore } from "./clones";
import { type LinkResult, type LinkState, link, linkState } from "./link";
import { type LockInfo, readLock } from "./lock";
import { claimNamespace, existingCase, knownNamespace } from "./namespace";
import { RECORD, readRecord, relation, type StoredRecord } from "./record";
import { LOCK, storeDir, type Target } from "./store";
import { artifactsRoot, resolveTargets } from "./targets";

const USAGE = `Usage: artifacts.ts <command> [repo...] [options]

  status [repo...] [--all]  Link state and newest capture of each repository
  link [repo...] [--all] [--apply] [--supersede]
                            Point each repository's .screenshots at the shared store,
                            moving an existing capture there when the store is empty;
                            --supersede moves it to <project>/superseded/ instead
  capture [repo] [--apply] [--allow-dirty] [-- capture args...]
                            Run the repository's \`bun run screenshots\` under a lock
                            and record the capture's commit in .screenshots/capture.json,
                            first linking every clone of the store's projects that has
                            no .screenshots

Repos are checkout names or paths; none selects the current repository, or in a
matrix workspace every checkout that captures screenshots. --all selects every
clone on this machine that captures into a project the store holds: clones
beside the store and the checkouts of matrix workspaces beside it.
MATRIX_ARTIFACTS_DIR overrides the store, which defaults to matrix-artifacts
beside the workspace (or beside the repository outside one). --json prints the
report as JSON.
`;

interface StatusEntry {
  readonly name: string;
  /** Set when the namespace belongs to another repository than this clone's origin. */
  readonly foreign?: string;
  readonly project: string;
  readonly store: string;
  readonly link: LinkState;
  readonly capture?: StoredRecord;
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
  /** Every clone of the store's projects on this machine, instead of named or current repositories. */
  readonly all: boolean;
  readonly apply: boolean;
  readonly json: boolean;
  readonly allowDirty: boolean;
  readonly supersede: boolean;
  readonly project?: string;
  readonly captureArgs: string[];
}

type Switches = Record<"all" | "apply" | "json" | "allowDirty" | "supersede", boolean>;

/** The boolean options, by the field each sets. */
const SWITCHES = new Map<string, keyof Switches>([
  ["--all", "all"],
  ["--apply", "apply"],
  ["--json", "json"],
  ["--allow-dirty", "allowDirty"],
  ["--supersede", "supersede"],
]);

export function parseOptions(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "link" && command !== "capture") throw new Error(`unknown command '${command ?? ""}'\n\n${USAGE}`);
  const split = rest.indexOf("--");
  const own = split === -1 ? rest : rest.slice(0, split);
  const captureArgs = split === -1 ? [] : rest.slice(split + 1);
  if (captureArgs.length > 0 && command !== "capture") throw new Error("only capture forwards arguments after --");
  const { names, switches, project } = parseOwn(own);
  checkApplies(command, switches);
  checkSelection(switches, names, project);
  const { all, apply, json, allowDirty, supersede } = switches;
  return { command, names, all, apply, json, allowDirty, supersede, captureArgs, ...(project ? { project } : {}) };
}

/** --all selects every clone, so it takes no repository names or namespace. */
function checkSelection({ all }: Switches, names: string[], project: string | undefined): void {
  if (all && (names.length > 0 || project)) throw new Error("--all selects every clone; name no repository or --project with it");
}

/** The repositories, switches and project named before `--`. */
function parseOwn(own: string[]): { names: string[]; switches: Switches; project: string | undefined } {
  const names: string[] = [];
  const switches: Switches = { all: false, apply: false, json: false, allowDirty: false, supersede: false };
  let project: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    const field = SWITCHES.get(arg);
    if (field) switches[field] = true;
    else if (arg === "--project")
      project =
        own[++index] ??
        (() => {
          throw new Error("--project needs a name");
        })();
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }
  return { names, switches, project };
}

/** Rejects options the command does not use. */
function checkApplies(command: Options["command"], { all, apply, allowDirty, supersede }: Switches): void {
  if (apply && command === "status") throw new Error("status changes nothing; --apply does not apply");
  if (allowDirty && command !== "capture") throw new Error("--allow-dirty applies only to capture");
  if (supersede && command !== "link") throw new Error("--supersede applies only to link");
  if (all && command === "capture") throw new Error("capture runs one repository; it links the other clones itself");
  // Superseding moves a clone's own capture aside, which a person decides clone by clone.
  if (all && supersede) throw new Error("--supersede needs the clone named; compare its capture first");
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
  return options.all ? allCommand(cwd, options, print) : selectedCommand(cwd, options, runner, print, timing);
}

/** A command over the named repositories, or the current one (every capturing checkout in a workspace). */
async function selectedCommand(cwd: string, options: Options, runner: Runner, print: (text: string) => void, timing: Timing): Promise<number> {
  const { targets: found } = resolveTargets(cwd, options.names, options.project);
  if (found.length === 0) {
    print(options.json ? "[]" : "No repository here captures screenshots.");
    return 0;
  }
  const { artifacts, targets } = inSharedStore(found);
  if (options.command === "status") return statusCommand(targets, artifacts, options, print);
  if (options.command === "link") return linkCommand(targets, artifacts, options, print);
  if (targets.length !== 1) throw new Error("capture runs one repository at a time; name it");
  return captureCommand(targets[0]!, artifacts, options, runner, print, timing);
}

/** status or link over every clone that shares the store this repository resolves. */
function allCommand(cwd: string, options: Options, print: (text: string) => void): number {
  const artifacts = sharedStore(cwd);
  const targets = clonesSharing(artifacts);
  if (targets.length === 0) {
    print(options.json ? "[]" : `No clone on this machine captures into ${artifacts}.`);
    return 0;
  }
  return options.command === "status" ? statusCommand(targets, artifacts, options, print) : linkCommand(targets, artifacts, options, print);
}

/** The store every selected repository resolves, and each one's namespace in it. */
function inSharedStore(found: Target[]): { artifacts: string; targets: Target[] } {
  const artifacts = artifactsRoot(found[0]!.root);
  if (found.some(target => artifactsRoot(target.root) !== artifacts))
    throw new Error("the selected repositories resolve different stores; set MATRIX_ARTIFACTS_DIR");
  return { artifacts, targets: found.map(target => existingCase(knownNamespace(target, artifacts), artifacts)) };
}

function statusCommand(targets: Target[], artifacts: string, options: Options, print: (text: string) => void): number {
  const entries = targets.map(target => status(target, artifacts));
  if (options.json) print(JSON.stringify({ artifacts, entries }, null, 2));
  else for (const entry of entries) print(statusLine(entry));
  return entries.every(entry => entry.link.state === "linked" && !entry.foreign) ? 0 : 1;
}

function statusLine(entry: StatusEntry): string {
  const lock = entry.lock ? `; capture running in ${entry.lock.checkout} (pid ${entry.lock.pid})` : "";
  return `${entry.name} [${entry.project}] ${entry.link.state}: ${entry.foreign ? `NOT THIS REPOSITORY'S: ${entry.foreign}` : describeCapture(entry)}${lock}`;
}

function linkCommand(targets: Target[], artifacts: string, options: Options, print: (text: string) => void): number {
  const results = targets.map(target => link(target, artifacts, options.apply, options.supersede));
  if (options.json) print(JSON.stringify({ artifacts, apply: options.apply, results }, null, 2));
  else for (const result of results) print(`${result.name} [${result.project}] ${linkOutcome(result)}`);
  if (!options.json && !options.apply && results.some(result => result.action && !result.blocked)) print("Dry run; rerun with --apply.");
  return results.some(result => result.blocked) ? 1 : 0;
}

function linkOutcome(result: LinkResult): string {
  if (result.blocked) return `blocked: ${result.blocked}`;
  if (!result.action) return "already linked";
  return `${result.applied ? "done" : "would"} ${result.action} -> ${result.store}${result.superseded ? `; its own capture to ${result.superseded}` : ""}`;
}

/**
 * Links the capturing clone first, so a clone with no .screenshots can capture,
 * then every other clone of the store's projects, so all of them see it.
 * `linking` says the capturing clone is not linked yet but would be.
 */
function linkBeforeCapture(target: Target, artifacts: string, options: Options, print: (text: string) => void): { links: LinkResult[]; linking: boolean } {
  const own = linkAutomatically([target], artifacts, options.apply);
  const others = clonesSharing(artifacts).filter(clone => clone.root !== target.root);
  const links = [...own, ...linkAutomatically(others, artifacts, options.apply)];
  if (!options.json) for (const result of links) print(`${result.name} [${result.project}] ${linkOutcome(result)}`);
  return { links, linking: own.some(result => !result.blocked) };
}

async function captureCommand(
  target: Target,
  artifacts: string,
  options: Options,
  runner: Runner,
  print: (text: string) => void,
  timing: Timing,
): Promise<number> {
  const { links, linking } = linkBeforeCapture(target, artifacts, options, print);
  const plan = await capture(target, artifacts, { apply: options.apply, allowDirty: options.allowDirty, args: options.captureArgs, linking }, runner, timing);
  if (options.json) print(JSON.stringify(links.length > 0 ? { ...plan, links } : plan, null, 2));
  else printCapture(target, plan, print);
  return plan.applied && plan.record.status !== "complete" ? 1 : 0;
}

function printCapture(target: Target, plan: CapturePlan, print: (text: string) => void): void {
  if (plan.applied) {
    print(`Capture ${plan.record.status} (exit ${plan.record.exitCode}); recorded in ${path.join(plan.store, RECORD)}.`);
    return;
  }
  print(
    `Would run \`${plan.command}\` in ${target.root} at ${plan.commit.slice(0, 10)}${plan.merged === false ? " (not on origin's default branch)" : ""}, writing ${plan.store}.`,
  );
  if (plan.previous) print(`Replaces the ${plan.previous.status} capture of ${plan.previous.commit.slice(0, 10)} from ${plan.previous.checkout}.`);
  print("Dry run; rerun with --apply.");
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
