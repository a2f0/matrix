/** Developer caches outside any repository, for `--machine`. Node built-ins only, like space-cleanup.ts. */
import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { holdsProtected, isRepository, measure, protectedName } from "./candidates";
import type { Proc } from "./processes";

export interface MachineItem {
  readonly id: string;
  readonly description: string;
  bytes?: number;
  /** Only reported: removing it is a judgment call or needs a person. */
  readonly reportOnly: boolean;
  skipped?: string;
  result?: string;
  apply?: () => string;
  /** Why it must wait, given the running processes; rechecked just before it runs. */
  guard?: (procs: Proc[]) => string | undefined;
}

/** What `--machine` needs from the host; tests substitute a fake one. */
export interface Host {
  readonly home: string;
  has(command: string): boolean;
  /** Combined output of a read-only command, empty when it fails. */
  output(command: string, args: string[]): string;
  /** Runs a cleaning command; throws when it fails. */
  run(command: string, args: string[]): string;
}

const HOST: Host = {
  home: os.homedir(),
  has: command => spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" }).status === 0,
  output: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  },
  run: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim().split("\n").pop()}`);
    return (result.stdout ?? "").trim();
  },
};

/** Running installs read the package caches, so those caches wait for them. */
// Matches the launcher forms too: `brew.rb`, `pnpm.cjs`, `npm-cli.js`, `yarn.js`.
// Options may come first (`bun --cwd /repo install`, `pnpm -C dir install`).
const OPTIONS = String.raw`(?:\s+-\S+(?:\s+[^\s-]\S*)?)*`;
// Anything that writes to a package cache: installs, updates, removals, and one-off runners.
const CACHE_WRITERS = "install|i|ci|add|update|up|upgrade|remove|rm|uninstall|reinstall|link|dedupe|fetch|x|dlx|exec";
export const INSTALLING = new RegExp(
  String.raw`(^|[\s/])((bun|npm|npm-cli|pnpm|yarn|brew)(\.(?:c|m)?js|\.rb)?${OPTIONS}(\s+run\s+agent-tool\s+bun${OPTIONS})?\s+(${CACHE_WRITERS})|(bunx|npx|pnpx)(\.(?:c|m)?js)?)(\s|$)`,
);

/**
 * DerivedData entries safe to delete: each project's build products and
 * indexes. Keeps SourcePackages (Swift package clones someone may have
 * edited), anything holding a repository, credentials, or a database, and
 * everything when DerivedData itself is a symlink or a repository.
 */
export function derivedDataRemovals(derived: string): string[] {
  if (lstatSync(derived).isSymbolicLink() || isRepository(derived)) throw new Error(`${derived} is a symlink or a repository; clean it by hand`);
  const keep = (entry: string, name: string) => name === "SourcePackages" || protectedName(name) || holdsProtected(entry, derived) !== undefined;
  return readdirSync(derived, { withFileTypes: true }).flatMap(entry => projectRemovals(path.join(derived, entry.name), entry, keep));
}

/** What one DerivedData entry contributes: itself when it is a file, else its removable children. */
function projectRemovals(project: string, entry: Dirent, keep: (entry: string, name: string) => boolean): string[] {
  if (!entry.isDirectory()) return keep(project, entry.name) ? [] : [project];
  // A shared SourcePackages, a clone made straight into DerivedData, or a protected directory stays whole.
  if (entry.name === "SourcePackages" || protectedName(entry.name) || isRepository(project)) return [];
  const removals: string[] = [];
  for (const child of readdirSync(project)) {
    const entryPath = path.join(project, child);
    // A package directory moved with -clonedSourcePackagesDirPath still holds clones.
    if (!keep(entryPath, child)) removals.push(entryPath);
  }
  return removals;
}

type Guard = NonNullable<MachineItem["guard"]>;

/** Package caches wait for any running install. */
const installing: Guard = list => {
  const proc = list.find(candidate => INSTALLING.test(candidate.args));
  return proc ? `an install is running (pid ${proc.pid})` : undefined;
};

/** DerivedData waits for Xcode builds. */
const building: Guard = list => {
  const proc = list.find(candidate => candidate.name === "xcodebuild" || candidate.name === "Xcode");
  return proc ? `${proc.name} is running (pid ${proc.pid})` : undefined;
};

/** A directory sized as a whole, when it exists. */
function dirItem(home: string, id: string, description: string, location: string, reportOnly: boolean, apply?: () => string, guard?: Guard): MachineItem[] {
  if (!existsSync(location)) return [];
  return [{ id, description: `${description} (${location.replace(home, "~")})`, reportOnly, bytes: measure([location]).get(location), apply, guard }];
}

/** Developer caches outside any repository, for `--machine`. */
export function machineItems(procs: Proc[], host: Host = HOST): MachineItem[] {
  const { home } = host;
  const items: MachineItem[] = [
    ...derivedDataItem(home),
    ...simulatorsItem(host),
    ...homebrewItem(host),
    ...packageCacheItems(host),
    ...dirItem(
      home,
      "gradle-caches",
      "Gradle caches; delete with Gradle stopped if Android builds can wait for a re-download",
      path.join(home, ".gradle/caches"),
      true,
    ),
    ...dirItem(home, "playwright-browsers", "Playwright browsers; old versions no project pins can go", path.join(home, "Library/Caches/ms-playwright"), true),
    ...dirItem(
      home,
      "ios-device-support",
      "iOS DeviceSupport; versions for devices no longer used can go",
      path.join(home, "Library/Developer/Xcode/iOS DeviceSupport"),
      true,
    ),
    ...dirItem(
      home,
      "simulator-devices",
      "Simulator devices; `xcrun simctl erase` or delete ones no project uses",
      path.join(home, "Library/Developer/CoreSimulator/Devices"),
      true,
    ),
    ...snapshotsItem(host),
    ...dockerItem(host),
  ];
  for (const item of items) item.skipped = item.guard?.(procs);
  return items;
}

function derivedDataItem(home: string): MachineItem[] {
  const derived = path.join(home, "Library/Developer/Xcode/DerivedData");
  if (!existsSync(derived)) return [];
  // A DerivedData that must not be touched sizes as nothing; applying it reports why.
  let removable: string[] = [];
  try {
    removable = derivedDataRemovals(derived);
  } catch {
    /* reported by apply */
  }
  const sizes = measure(removable);
  return [
    {
      id: "xcode-derived-data",
      description: `Xcode DerivedData builds and indexes, keeping SourcePackages, repositories, and data files (${derived.replace(home, "~")})`,
      reportOnly: false,
      bytes: removable.reduce((sum, entry) => sum + (sizes.get(entry) ?? 0), 0),
      // Recomputed at apply time: the tree may have changed since the report.
      apply: () => {
        for (const entry of derivedDataRemovals(derived)) rmSync(entry, { recursive: true, force: true });
        return "cleaned";
      },
      guard: building,
    },
  ];
}

function simulatorsItem(host: Host): MachineItem[] {
  if (!host.has("xcrun")) return [];
  const listing = host.output("xcrun", ["simctl", "list", "devices", "unavailable"]);
  const count = listing.split("\n").filter(line => /\(unavailable/.test(line)).length;
  // Their app data returns if the runtime is reinstalled, so deleting them is the owner's call.
  if (count === 0) return [];
  return [
    {
      id: "unavailable-simulators",
      description: `${count} simulators whose runtime is no longer installed; \`xcrun simctl delete unavailable\` removes them and their app data`,
      reportOnly: true,
    },
  ];
}

function homebrewItem(host: Host): MachineItem[] {
  const { has, run } = host;
  if (!has("brew")) return [];
  const match = /free approximately ([\d.]+)([KMGT]?B)/.exec(host.output("brew", ["cleanup", "-n"]));
  const unit: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  // brew cleanup removes downloads an install in progress is using.
  if (!match) return [];
  return [
    {
      id: "homebrew-cleanup",
      description: "Old Homebrew versions and downloads (`brew cleanup`)",
      reportOnly: false,
      bytes: Number(match[1]) * unit[match[2]!]!,
      apply: () => {
        run("brew", ["cleanup"]);
        return "cleaned";
      },
      guard: installing,
    },
  ];
}

/** The Bun, npm and pnpm caches, in that order. */
function packageCacheItems(host: Host): MachineItem[] {
  const { home, has, run } = host;
  const items: MachineItem[] = [];
  if (has("bun")) {
    const cache = host.output("bun", ["pm", "cache"]).trim().split("\n")[0];
    if (cache) items.push(...dirItem(home, "bun-cache", "Bun install cache", cache, false, () => run("bun", ["pm", "cache", "rm"]) || "removed", installing));
  }
  if (has("npm")) {
    items.push(
      ...dirItem(
        home,
        "npm-cache",
        "npm cache",
        path.join(home, ".npm/_cacache"),
        false,
        () => {
          run("npm", ["cache", "clean", "--force"]);
          return "cleaned";
        },
        installing,
      ),
    );
  }
  if (has("pnpm")) {
    items.push({
      id: "pnpm-store",
      description: "Packages no project references in the pnpm store (`pnpm store prune`)",
      reportOnly: false,
      apply: () => {
        run("pnpm", ["store", "prune"]);
        return "pruned";
      },
      guard: installing,
    });
  }
  return items;
}

function snapshotsItem(host: Host): MachineItem[] {
  if (!host.has("tmutil")) return [];
  const snapshots = host
    .output("tmutil", ["listlocalsnapshots", "/"])
    .split("\n")
    .filter(line => line.includes("com.apple")).length;
  if (snapshots === 0) return [];
  return [
    {
      id: "local-snapshots",
      description: `${snapshots} Time Machine local snapshots hold deleted files' space until macOS thins them`,
      reportOnly: true,
    },
  ];
}

function dockerItem(host: Host): MachineItem[] {
  if (!host.has("docker")) return [];
  return [
    {
      id: "docker",
      description: "Docker images, containers, and volumes; `docker system df` sizes them, and pruning is the owner's call",
      reportOnly: true,
    },
  ];
}

/**
 * Runs every machine item that is neither report-only nor waiting on a running
 * process, listing processes afresh just before each guarded item.
 * Returns the number that failed.
 */
export function applyMachine(items: MachineItem[], discover: () => Proc[]): number {
  let failures = 0;
  for (const item of items) {
    if (item.reportOnly || !item.apply) continue;
    if (item.guard) {
      try {
        item.skipped = item.guard(discover());
      } catch (error) {
        item.skipped = (error as Error).message;
      }
    }
    if (item.skipped) continue;
    try {
      item.result = item.apply();
    } catch (error) {
      item.result = `failed: ${(error as Error).message}`;
      failures++;
    }
  }
  return failures;
}
