import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findCandidates, parseIgnored, protectedName, selected, unsafeReason } from "../skills/space-cleanup/scripts/candidates";
import { gitEnvironment } from "../skills/space-cleanup/scripts/git";
import { applyMachine, derivedDataRemovals, type Host, INSTALLING, machineItems } from "../skills/space-cleanup/scripts/machine";
import { busyRoots, type Proc, parseProcesses } from "../skills/space-cleanup/scripts/processes";
import { main, parseOptions } from "../skills/space-cleanup/scripts/space-cleanup";
import { resolveTargets } from "../skills/space-cleanup/scripts/targets";
import { gitIn, gitInit, tempDir, write } from "./testFixtures";

/** A repository with every kind of ignored path the cleanup must tell apart. */
function fixture(root = tempDir("space-cleanup")): string {
  mkdirSync(root, { recursive: true });
  gitInit(root);
  write(root, {
    ".gitignore": ["node_modules/", ".turbo/", "dist/", "build/", "out/", ".wrangler/", ".secrets", ".env", "packages/*/node_modules/", "scratch/"].join("\n"),
    "src/index.ts": "x",
    ".turbo/cache/a": "x",
    "dist/index.js": "x",
    // Build-named trees holding credentials or a local database.
    "packages/app/dist/.env": "SECRET=1",
    "packages/app/out/data.sqlite": "x",
    "packages/app/.turbo/.env.example": "x",
  });
  // A clone nested deep inside a cache directory.
  mkdirSync(path.join(root, "test-results/vendor/clone/.git"), { recursive: true });
  write(root, {
    "test-results/vendor/clone/notes.md": "x",
    "node_modules/pkg/index.js": "x",
    "node_modules/.cache/babel/a": "x",
    "packages/app/package.json": "{}",
    "packages/app/node_modules/pkg/index.js": "x",
    ".wrangler/state/d1/db.sqlite": "x",
    ".wrangler/tmp/bundle.js": "x",
    ".env": "SECRET=1",
    "scratch/notes.md": "x",
    // Untracked but not ignored: only a person decides about these.
    "coverage/lcov.info": "x",
    // Ignored but tracked: never removed.
    "build/keep.txt": "x",
  });
  gitIn(root, "add", "-f", "build/keep.txt");
  // An ignored nested repository named like build output.
  mkdirSync(path.join(root, "out", ".git"), { recursive: true });
  write(root, { "out/file": "x" });
  // A symlink to credentials outside the repository.
  const secrets = tempDir("space-cleanup-secrets");
  write(secrets, { "prod/key": "secret" });
  symlinkSync(secrets, path.join(root, ".secrets"));
  gitIn(root, "add", ".gitignore", "src/index.ts", "packages/app/package.json");
  gitIn(root, "commit", "-qm", "init");
  return root;
}

describe("space cleanup", () => {
  test("parses ignored entries from porcelain status", () => {
    expect(parseIgnored("?? new.txt\0!! dist/\0!! .env\0 M src/a.ts\0")).toEqual(["dist", ".env"]);
  });

  test("finds only ignored, untracked, regenerable paths", () => {
    const root = fixture();
    const found = Object.fromEntries(findCandidates(root).map(candidate => [candidate.path, candidate.tier]));
    expect(found).toEqual({
      ".turbo": "caches",
      dist: "builds",
      node_modules: "deps",
      "node_modules/.cache": "caches",
      "packages/app/node_modules": "deps",
      ".wrangler/tmp": "caches",
      "packages/app/.turbo": "caches",
    });
  });

  test("selects tiers without double-counting nested paths", () => {
    const candidates = [
      { path: "node_modules", tier: "deps" as const, bytes: 10 },
      { path: "node_modules/.cache", tier: "caches" as const, bytes: 4 },
      { path: ".turbo", tier: "caches" as const, bytes: 1 },
    ];
    expect(selected(candidates, new Set(["caches"])).map(candidate => candidate.path)).toEqual([".turbo", "node_modules/.cache"]);
    expect(selected(candidates, new Set(["caches", "deps"])).map(candidate => candidate.path)).toEqual([".turbo", "node_modules"]);
  });

  test("a dry run changes nothing and --apply removes only the chosen tiers", () => {
    const root = fixture();
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(main([root])).toBe(0);
      expect(existsSync(path.join(root, ".turbo"))).toBe(true);
      expect(main([root, "--apply", "--include-busy"])).toBe(0);
    } finally {
      console.log = quiet;
    }
    for (const gone of ["packages/app/.turbo", ".turbo", "node_modules/.cache", ".wrangler/tmp"]) expect(existsSync(path.join(root, gone))).toBe(false);
    for (const kept of [
      "packages/app/dist/.env",
      "packages/app/out/data.sqlite",
      "test-results/vendor/clone/notes.md",
      "dist",
      "node_modules/pkg",
      ".wrangler/state/d1/db.sqlite",
      ".env",
      "scratch/notes.md",
      "coverage/lcov.info",
      "build/keep.txt",
      "out/file",
      ".secrets/prod/key",
      "src/index.ts",
    ]) {
      expect(existsSync(path.join(root, kept))).toBe(true);
    }
  });

  test("resolves a matrix workspace to itself and its checkouts, and a checkout to itself", () => {
    const workspace = fixture();
    write(workspace, { "matrix.json": "{}" });
    const checkout = realpathSync(fixture(path.join(workspace, "checkouts", "app")));
    write(workspace, { ".gitignore": "checkouts/\n" });
    expect(resolveTargets(workspace, []).targets.map(target => target.name)).toEqual([path.basename(workspace), "app"]);
    expect(resolveTargets(workspace, ["a2f0/app"]).targets.map(target => target.root)).toEqual([checkout]);
    const inside = resolveTargets(path.join(checkout, "src"), []);
    expect(inside.workspace).toBeUndefined();
    expect(inside.targets.map(target => target.root)).toEqual([checkout]);
  });

  test("counts other processes as busy, but not this one, its ancestors, pipeline filters, or idle shells", () => {
    const procs: Proc[] = [
      { pid: 1, ppid: 0, name: "launchd", args: "", cwd: "/" },
      { pid: 10, ppid: 1, name: "claude", args: "claude", cwd: "/w" },
      { pid: 11, ppid: 10, pgid: 11, name: "bun", args: "bun space", cwd: "/w/checkouts/a" },
      { pid: 12, ppid: 10, pgid: 11, name: "head", args: "head", cwd: "/w/checkouts/a" },
      { pid: 13, ppid: 10, pgid: 11, name: "node", args: "vite build --watch", cwd: "/w/checkouts/a" },
      { pid: 20, ppid: 1, name: "zsh", args: "-zsh", cwd: "/w/checkouts/b" },
      { pid: 21, ppid: 1, name: "node", args: "vite", cwd: "/w/checkouts/b/web" },
      { pid: 22, ppid: 1, name: "bun", args: "bun test", cwd: "/w/checkouts/a" },
      { pid: 23, ppid: 1, name: "codex", args: "codex", cwd: "/w" },
      { pid: 24, ppid: 1, name: "bash", args: "bash build.sh", cwd: "/w/checkouts/b" },
      { pid: 25, ppid: 1, name: "zsh", args: "/bin/zsh -il", cwd: "/w/checkouts/b" },
      { pid: 26, ppid: 1, name: "cargo", args: "cargo build --manifest-path checkouts/c/Cargo.toml", cwd: "/w" },
      { pid: 27, ppid: 1, name: "bun", args: "bun --cwd=checkouts/d run build", cwd: "/w" },
    ];
    const busy = busyRoots(procs, ["/w", "/w/checkouts/a", "/w/checkouts/b", "/w/checkouts/c", "/w/checkouts/d"], 11);
    expect(Object.fromEntries([...busy].map(([root, list]) => [root, list.map(proc => proc.pid)]))).toEqual({
      "/w/checkouts/a": [13, 22],
      "/w/checkouts/b": [21, 24],
      "/w": [23, 26, 27],
      "/w/checkouts/c": [26],
      "/w/checkouts/d": [27],
    });
  });

  test("rechecks tracked files at removal time", () => {
    const root = fixture();
    expect(unsafeReason(root, ".turbo")).toBeUndefined();
    gitIn(root, "add", "-f", ".turbo/cache/a");
    expect(unsafeReason(root, ".turbo")).toBe("tracked");
  });

  test("--deps alone adds only dependencies", () => {
    expect(parseOptions(["--deps"]).tiers).toEqual(new Set(["caches", "deps"]));
  });

  test("fails closed when processes cannot be listed", () => {
    const root = fixture();
    expect(() =>
      main([root, "--apply"], root, () => {
        throw new Error("cannot list processes with lsof");
      }),
    ).toThrow("cannot list processes");
    expect(existsSync(path.join(root, ".turbo"))).toBe(true);
  });

  test("ignores inherited variables that bind git to another repository", () => {
    const root = fixture();
    const other = fixture();
    write(other, { ".turbo/tracked": "x" });
    gitIn(other, "add", "-f", ".turbo/tracked");
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      expect(gitEnvironment().GIT_DIR).toBeUndefined();
      expect(unsafeReason(root, ".turbo")).toBeUndefined();
      expect(findCandidates(root).map(candidate => candidate.path)).toContain(".turbo");
      expect(unsafeReason(other, ".turbo")).toBe("tracked");
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  describe("--machine", () => {
    function host(commands: string[]) {
      const home = tempDir("space-cleanup-home");
      write(home, {
        "Library/Developer/Xcode/DerivedData/App-abc/Build/x": "x",
        "Library/Developer/Xcode/DerivedData/App-abc/SourcePackages/checkouts/Lib/.git/HEAD": "x",
        "Library/Developer/Xcode/DerivedData/SourcePackages/checkouts/Shared/.git/HEAD": "x",
        "Library/Developer/Xcode/DerivedData/App-abc/Packages/checkouts/Custom/.git/HEAD": "x",
        "Library/Developer/Xcode/DerivedData/clone/.git/HEAD": "x",
        "Library/Developer/Xcode/DerivedData/clone/src/main.swift": "x",
        "Library/Developer/Xcode/DerivedData/App-abc/Tools/.env": "TOKEN=1",
        "Library/Developer/Xcode/DerivedData/.env": "TOKEN=1",
        "Library/Developer/Xcode/DerivedData/notes.sqlite": "x",
        "Library/Developer/Xcode/DerivedData/.secrets/Build/key": "x",
        "Library/Developer/Xcode/DerivedData/info.plist": "x",
        ".bun/install/cache/pkg/x": "x",
        ".gradle/caches/x": "x",
      });
      const ran: string[] = [];
      const outputs = new Map([
        ["bun", path.join(home, ".bun/install/cache")],
        ["xcrun", "    iPhone 8 (ABC) (Shutdown) (unavailable, runtime profile not found)\n"],
        ["brew", "==> This operation would free approximately 1.5GB of disk space."],
      ]);
      const fake: Host = {
        home,
        has: command => commands.includes(command),
        output: command => outputs.get(command) ?? "",
        run: (command, args) => {
          ran.push(`${command} ${args.join(" ")}`);
          return "";
        },
      };
      return { home, ran, fake };
    }

    test("empties DerivedData, runs cache commands, and leaves report-only items alone", () => {
      const { home, ran, fake } = host(["bun", "xcrun", "brew"]);
      const items = machineItems([], fake);
      expect(
        items
          .filter(item => item.reportOnly)
          .map(item => item.id)
          .toSorted(),
      ).toEqual(["gradle-caches", "unavailable-simulators"]);
      expect(applyMachine(items, () => [])).toBe(0);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Build"))).toBe(false);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/SourcePackages/checkouts/Lib/.git/HEAD"))).toBe(true);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/SourcePackages/checkouts/Shared/.git/HEAD"))).toBe(true);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Packages/checkouts/Custom/.git/HEAD"))).toBe(true);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/clone/src/main.swift"))).toBe(true);
      for (const kept of ["App-abc/Tools/.env", ".env", "notes.sqlite", ".secrets/Build/key"]) {
        expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData", kept))).toBe(true);
      }
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/info.plist"))).toBe(false);
      expect(ran.toSorted()).toEqual(["brew cleanup", "bun pm cache rm"]);
      expect(existsSync(path.join(home, ".gradle/caches/x"))).toBe(true);
    });

    test("lists every machine item in a fixed order, with its kind and guard", () => {
      const { home, fake } = host(["bun", "xcrun", "brew", "npm", "pnpm", "tmutil", "docker"]);
      write(home, {
        ".npm/_cacache/x": "x",
        "Library/Caches/ms-playwright/x": "x",
        "Library/Developer/Xcode/iOS DeviceSupport/x": "x",
        "Library/Developer/CoreSimulator/Devices/x": "x",
      });
      const output = fake.output;
      fake.output = (command, args) => (command === "tmutil" ? "com.apple.TimeMachine.1.local\ncom.apple.TimeMachine.2.local\n" : output(command, args));
      const procs: Proc[] = [{ pid: 5, ppid: 1, name: "bun", args: "bun install", cwd: "/x" }];
      const items = machineItems(procs, fake).map(({ id, description, reportOnly, bytes, skipped, apply, guard }) => ({
        id,
        description,
        reportOnly,
        bytes: String(typeof bytes),
        skipped,
        apply: String(typeof apply),
        guard: String(typeof guard),
      }));
      const item = (id: string, description: string, reportOnly: boolean, bytes: string, apply: boolean, skipped?: string) => ({
        id,
        description,
        reportOnly,
        bytes,
        skipped,
        apply: apply ? "function" : "undefined",
        guard: skipped !== undefined || id === "xcode-derived-data" ? "function" : "undefined",
      });
      const installing = "an install is running (pid 5)";
      expect(items).toEqual([
        item(
          "xcode-derived-data",
          "Xcode DerivedData builds and indexes, keeping SourcePackages, repositories, and data files (~/Library/Developer/Xcode/DerivedData)",
          false,
          "number",
          true,
        ),
        item(
          "unavailable-simulators",
          "1 simulators whose runtime is no longer installed; `xcrun simctl delete unavailable` removes them and their app data",
          true,
          "undefined",
          false,
        ),
        item("homebrew-cleanup", "Old Homebrew versions and downloads (`brew cleanup`)", false, "number", true, installing),
        item("bun-cache", "Bun install cache (~/.bun/install/cache)", false, "number", true, installing),
        item("npm-cache", "npm cache (~/.npm/_cacache)", false, "number", true, installing),
        item("pnpm-store", "Packages no project references in the pnpm store (`pnpm store prune`)", false, "undefined", true, installing),
        item(
          "gradle-caches",
          "Gradle caches; delete with Gradle stopped if Android builds can wait for a re-download (~/.gradle/caches)",
          true,
          "number",
          false,
        ),
        item("playwright-browsers", "Playwright browsers; old versions no project pins can go (~/Library/Caches/ms-playwright)", true, "number", false),
        item(
          "ios-device-support",
          "iOS DeviceSupport; versions for devices no longer used can go (~/Library/Developer/Xcode/iOS DeviceSupport)",
          true,
          "number",
          false,
        ),
        item(
          "simulator-devices",
          "Simulator devices; `xcrun simctl erase` or delete ones no project uses (~/Library/Developer/CoreSimulator/Devices)",
          true,
          "number",
          false,
        ),
        item("local-snapshots", "2 Time Machine local snapshots hold deleted files' space until macOS thins them", true, "undefined", false),
        item("docker", "Docker images, containers, and volumes; `docker system df` sizes them, and pruning is the owner's call", true, "undefined", false),
      ]);
    });

    test("waits for running installs and Xcode builds", () => {
      const { home, ran, fake } = host(["bun", "brew"]);
      const procs: Proc[] = [
        { pid: 5, ppid: 1, name: "bun", args: "bun install --frozen-lockfile", cwd: "/x" },
        { pid: 6, ppid: 1, name: "xcodebuild", args: "xcodebuild -workspace App", cwd: "/x" },
      ];
      const items = machineItems(procs, fake);
      expect(Object.fromEntries(items.map(item => [item.id, item.skipped]))).toMatchObject({
        "xcode-derived-data": "xcodebuild is running (pid 6)",
        "bun-cache": "an install is running (pid 5)",
        "homebrew-cleanup": "an install is running (pid 5)",
      });
      expect(applyMachine(items, () => procs)).toBe(0);
      expect(ran).toEqual([]);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x"))).toBe(true);
    });
  });

  test("rechecks machine guards against processes started after the scan", () => {
    const home = tempDir("space-cleanup-home");
    write(home, { "Library/Developer/Xcode/DerivedData/App-abc/Build/x": "x" });
    const fake: Host = { home, has: () => false, output: () => "", run: () => "" };
    const items = machineItems([], fake);
    expect(items[0]?.skipped).toBeUndefined();
    applyMachine(items, () => [{ pid: 7, ppid: 1, name: "xcodebuild", args: "xcodebuild", cwd: "/x" }]);
    expect(items[0]?.skipped).toBe("xcodebuild is running (pid 7)");
    expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x"))).toBe(true);
  });

  test("skips repositories that became busy after the scan", () => {
    const root = realpathSync(fixture());
    let calls = 0;
    const discover = (): Proc[] => (calls++ === 0 ? [] : [{ pid: 999999, ppid: 1, name: "node", args: "vite build", cwd: path.join(root, "src") }]);
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(main([root, "--apply"], root, discover)).toBe(0);
    } finally {
      console.log = quiet;
    }
    expect(calls).toBe(2);
    expect(existsSync(path.join(root, ".turbo"))).toBe(true);
  });

  test("canonicalizes symlinked targets so busy detection sees them", () => {
    const root = realpathSync(fixture());
    const linkDir = tempDir("space-cleanup-link");
    symlinkSync(root, path.join(linkDir, "repo"));
    expect(resolveTargets(linkDir, ["repo"]).targets.map(target => target.root)).toEqual([root]);
  });

  test("canonicalizes checkouts reached through a symlinked checkouts directory", () => {
    const workspace = realpathSync(fixture());
    write(workspace, {
      "matrix.json": "{}",
      ".gitignore": "checkouts\n",
    });
    const elsewhere = realpathSync(tempDir("space-cleanup-checkouts"));
    const checkout = fixture(path.join(elsewhere, "app"));
    symlinkSync(elsewhere, path.join(workspace, "checkouts"));
    expect(resolveTargets(workspace, []).targets.map(target => target.root)).toEqual([workspace, realpathSync(checkout)]);
  });

  test("recognizes installs however they are launched", () => {
    for (const args of [
      "bun install --frozen-lockfile",
      "bun run agent-tool bun install",
      "/opt/homebrew/Library/Homebrew/brew.rb install ffmpeg",
      "/opt/homebrew/Library/Homebrew/brew.rb upgrade",
      "node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs install",
      "node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci",
      "node .yarn/releases/yarn.js add left-pad",
      "bun --cwd /repo install",
      "npm --prefix packages/api ci",
      "pnpm -C web install --frozen-lockfile",
      "bun --verbose install",
      "bun run agent-tool bun install --cwd packages/api",
      "bun update",
      "npm update react",
      "pnpm up --latest",
      "bun run agent-tool bun update typescript",
      "bun run agent-tool bun remove left-pad",
      "bunx prettier --check .",
      "npx tsc",
      "pnpm dlx create-vite",
      "bun x eslint",
    ])
      expect(INSTALLING.test(args)).toBe(true);
    for (const args of ["bun test", "npm run build", "brew list", "node install.js", "bun --cwd /repo test"]) expect(INSTALLING.test(args)).toBe(false);
  });

  test("lists processes again before each guarded machine item", () => {
    const home = tempDir("space-cleanup-home");
    write(home, {
      "Library/Developer/Xcode/DerivedData/App-abc/Build/x": "x",
      ".npm/_cacache/x": "x",
    });
    const ran: string[] = [];
    const fake: Host = {
      home,
      has: command => command === "npm",
      output: () => "",
      run: (command, args) => {
        ran.push(`${command} ${args.join(" ")}`);
        return "";
      },
    };
    const items = machineItems([], fake);
    let calls = 0;
    // An install starts after DerivedData is cleaned and before the npm cache is.
    applyMachine(items, () => (calls++ === 0 ? [] : [{ pid: 8, ppid: 1, name: "node", args: "node /x/npm-cli.js install", cwd: "/x" }]));
    expect(calls).toBe(2);
    expect(ran).toEqual([]);
    expect(items.find(item => item.id === "npm-cache")?.skipped).toBe("an install is running (pid 8)");
  });

  test("refuses paths inside protected directories", () => {
    const root = fixture();
    write(root, {
      ".gitignore": ".secrets-dir/\n.env.local/\n",
      ".env.local/build/x": "x",
    });
    gitIn(root, "add", ".gitignore");
    expect(unsafeReason(root, ".env.local/build")).toBe("inside .env.local");
    expect(protectedName(".secrets")).toBe(true);
    expect(protectedName("app.sqlite3")).toBe(true);
    expect(protectedName(".env.example")).toBe(false);
    expect(protectedName(".envrc")).toBe(true);
    expect(protectedName(".env-production")).toBe(true);
    expect(protectedName("dist")).toBe(false);
  });

  test("fails closed when a live process of this user has no visible working directory", () => {
    const table = ["  1   0   1   0 Ss   launchd", " 10   1  10 501 S    node", " 11   1  11 501 Z    <defunct>", " 12   1  12 501 S    gone"].join("\n");
    const args = " 1 launchd\n 10 node build\n 11 \n 12 gone";
    const alive = (pid: number) => pid !== 12;
    expect(() => parseProcesses(table, args, "", 501, alive)).toThrow("cannot read the working directory of node 10");
    const procs = parseProcesses(table, args, "p10\nfcwd\nn/repo\n", 501, alive);
    expect(procs.map(proc => [proc.pid, proc.cwd])).toEqual([
      [1, undefined],
      [10, "/repo"],
      [12, undefined],
    ]);
  });

  test("exits nonzero when a repository cannot be scanned", () => {
    const root = realpathSync(fixture());
    // A corrupt index keeps the repository resolvable but makes `git status` fail.
    writeFileSync(path.join(root, ".git", "index"), "not an index");
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(main([root], root, () => [])).toBe(1);
    } finally {
      console.log = quiet;
    }
  });

  test("refuses trees holding credentials or bare repositories", () => {
    const root = fixture();
    write(root, { "dist/.envrc": "export TOKEN=1" });
    expect(unsafeReason(root, "dist")).toBe("contains dist/.envrc");
    rmSync(path.join(root, "dist/.envrc"));
    for (const part of ["HEAD", "objects/x", "refs/heads/main"]) write(root, { [`dist/mirror.git/${part}`]: "x" });
    expect(unsafeReason(root, "dist")).toBe("contains repository dist/mirror.git");
  });

  test("sizes a nested cache even when its parent is measured too", () => {
    const root = fixture();
    writeFileSync(path.join(root, "node_modules/.cache/babel/a"), "x".repeat(64 * 1024));
    const quiet = console.log;
    let output = "";
    console.log = (text: string) => {
      output += text;
    };
    try {
      main([root, "--json", "--include-busy"], root, () => []);
    } finally {
      console.log = quiet;
    }
    const report = JSON.parse(output) as { repos: Array<{ candidates: Array<{ path: string; bytes: number }> }> };
    const cache = report.repos[0]!.candidates.find(candidate => candidate.path === "node_modules/.cache");
    expect(cache!.bytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  test("keeps machine guards when --include-busy is given and processes cannot be listed", () => {
    const home = tempDir("space-cleanup-home");
    write(home, { "Library/Developer/Xcode/DerivedData/App-abc/Build/x": "x" });
    const items = machineItems([], { home, has: () => false, output: () => "", run: () => "" });
    applyMachine(items, () => {
      throw new Error("cannot list processes with lsof");
    });
    expect(items[0]?.skipped).toContain("cannot list processes");
    expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x"))).toBe(true);
  });

  test("leaves a DerivedData that is a repository or a symlink alone", () => {
    for (const kind of ["repository", "symlink"]) {
      const home = tempDir("space-cleanup-home");
      const target = kind === "repository" ? path.join(home, "Library/Developer/Xcode/DerivedData") : path.join(home, "elsewhere");
      write(target, {
        ".git/HEAD": "x",
        "Project/src/main.swift": "x",
      });
      if (kind === "symlink") {
        mkdirSync(path.join(home, "Library/Developer/Xcode"), { recursive: true });
        symlinkSync(target, path.join(home, "Library/Developer/Xcode/DerivedData"));
      }
      const items = machineItems([], { home, has: () => false, output: () => "", run: () => "" });
      expect(applyMachine(items, () => [])).toBe(1);
      expect(existsSync(path.join(target, "Project/src/main.swift"))).toBe(true);
    }
  });

  test("rechecks activity before each repository", () => {
    const first = realpathSync(fixture());
    const second = realpathSync(fixture());
    let calls = 0;
    // The second repository becomes busy while the first is being cleaned.
    const discover = (): Proc[] => (++calls <= 2 ? [] : [{ pid: 999998, ppid: 1, name: "node", args: "vite", cwd: second }]);
    const quiet = console.log;
    console.log = () => {};
    try {
      main([first, second, "--apply"], first, discover);
    } finally {
      console.log = quiet;
    }
    expect(existsSync(path.join(first, ".turbo"))).toBe(false);
    expect(existsSync(path.join(second, ".turbo"))).toBe(true);
  });

  test("refuses candidates inside a nested repository", () => {
    const root = fixture();
    write(root, { "node_modules/.git/HEAD": "x" });
    expect(unsafeReason(root, "node_modules/.cache")).toBe("inside repository node_modules");
    expect(findCandidates(root).map(candidate => candidate.path)).not.toContain("node_modules/.cache");
  });

  test("sizes DerivedData by what it would remove", () => {
    const home = tempDir("space-cleanup-home");
    const derived = path.join(home, "Library/Developer/Xcode/DerivedData");
    write(derived, {
      "App-abc/Build/x": "x".repeat(8 * 1024),
      "App-abc/SourcePackages/checkouts/Lib/big": "x".repeat(512 * 1024),
    });
    expect(derivedDataRemovals(derived)).toEqual([path.join(derived, "App-abc/Build")]);
    const item = machineItems([], { home, has: () => false, output: () => "", run: () => "" })[0]!;
    expect(item.bytes!).toBeLessThan(512 * 1024);
  });

  describe("report", () => {
    const CACHES = [
      ".turbo",
      ".parcel-cache",
      "coverage",
      ".nyc_output",
      "test-results",
      "playwright-report",
      "blob-report",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
    ];

    /** A repository whose ten caches sort by size in list order: `.turbo` largest. */
    function cachesFixture(): string {
      const root = realpathSync(tempDir("space-cleanup-report"));
      gitInit(root);
      write(root, { ".gitignore": `${CACHES.join("\n")}\n`, "src/index.ts": "x" });
      for (const [index, name] of CACHES.entries()) write(root, { [`${name}/data`]: "x".repeat((CACHES.length - index) * 16 * 1024) });
      gitIn(root, "add", ".gitignore", "src/index.ts");
      gitIn(root, "commit", "-qm", "init");
      return root;
    }

    /** What `main` prints and returns, with sizes and the fixture root replaced by placeholders. */
    function run(argv: string[], cwd: string, discover: () => Proc[]): { code: number; output: string } {
      const quiet = console.log;
      let output = "";
      console.log = (text: string) => {
        output += `${text}\n`;
      };
      let code: number;
      try {
        code = main(argv, cwd, discover);
      } finally {
        console.log = quiet;
      }
      return { code, output: output.replaceAll(cwd, "<root>").replace(/ +\d+(?:\.\d)? (?:B|KiB|MiB|GiB|TiB)/g, " <size>") };
    }

    test("prints a dry run with its busy repositories, longest lists cut short", () => {
      const root = cachesFixture();
      const procs = [900001, 900002, 900003, 900004].map(pid => ({ pid, ppid: 0, name: "node", args: "vite", cwd: root }));
      const { code, output } = run([root], root, () => procs);
      expect(code).toBe(0);
      expect(output).toBe(
        [
          "Space cleanup (dry run): <size> free",
          "",
          `${path.basename(root)} skipped, busy: node 900001, node 900002, node 900003, ...`,
          "  caches <size>, builds <size>, deps <size>",
          ...CACHES.slice(0, 8).map(name => `  caches <size>  ${name}`),
          "  ... and 2 more",
          "",
          "Totals: caches <size>, builds <size> (--builds), deps <size> (--deps)",
          "Nothing changed; rerun with --apply to remove the listed tiers.",
          "",
        ].join("\n"),
      );
    });

    test("prints what --apply removed and what it refused, and fails on a refusal", () => {
      const root = cachesFixture();
      let calls = 0;
      // The tree changes between the scan and the removal: `.turbo` now holds credentials.
      const discover = (): Proc[] => {
        if (calls++ === 1) write(root, { ".turbo/.env": "SECRET=1" });
        return [];
      };
      const { code, output } = run([root, "--apply", "--builds"], root, discover);
      expect(code).toBe(1);
      expect(calls).toBe(2);
      expect(output).toBe(
        [
          "Space cleanup (applied): <size> free",
          "",
          path.basename(root),
          "  caches <size>, builds <size>, deps <size>",
          "  caches <size>  .turbo",
          ...CACHES.slice(1, 8).map(name => `  removed <size>  ${name}`),
          "  ... and 2 more",
          "  FAILED .turbo: contains .turbo/.env",
          "",
          "Totals: caches <size>, builds <size>, deps <size> (--deps)",
          "Free: <size> -> <size>",
          "",
        ].join("\n"),
      );
      expect(existsSync(path.join(root, ".turbo/data"))).toBe(true);
      for (const name of CACHES.slice(1)) expect(existsSync(path.join(root, name))).toBe(false);
    });

    test("prints a repository that cannot be scanned, and JSON with every field", () => {
      const root = cachesFixture();
      writeFileSync(path.join(root, ".git", "index"), "not an index");
      const text = run([root], root, () => []);
      expect(text.code).toBe(1);
      expect(text.output).toMatch(
        new RegExp(`^Space cleanup \\(dry run\\): <size> free\n\n${path.basename(root)} error: .+\n  caches <size>, builds <size>, deps <size>\n\nTotals: `),
      );
      const busy = cachesFixture();
      const json = run([busy, "--json", "--deps"], busy, () => [{ pid: 900007, ppid: 0, name: "bun", args: "bun test", cwd: busy }]);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.output);
      expect(Object.keys(report)).toEqual(["applied", "workspace", "tiers", "free", "totals", "repos"]);
      expect(report).toMatchObject({ applied: false, workspace: null, tiers: ["caches", "deps"], totals: { builds: 0, deps: 0 } });
      expect(Object.keys(report.free)).toEqual(["before"]);
      expect(report.repos).toHaveLength(1);
      expect(report.repos[0]).toMatchObject({
        name: path.basename(busy),
        root: "<root>",
        busy: [{ pid: 900007, name: "bun", cwd: "<root>" }],
        skipped: "busy",
      });
      expect(report.repos[0].candidates.map((candidate: { path: string }) => candidate.path).sort()).toEqual([...CACHES].sort());
    });
  });

  test("rejects unknown options", () => {
    expect(() => parseOptions(["--force"])).toThrow("unknown option --force");
    expect(parseOptions(["--builds", "--deps", "tearleads"]).tiers).toEqual(new Set(["caches", "builds", "deps"]));
  });

  test("parses every option into its field", () => {
    const none = parseOptions([]);
    expect(Object.keys(none)).toEqual(["names", "tiers", "apply", "json", "machine", "includeBusy"]);
    expect(none).toEqual({ names: [], tiers: new Set(["caches"]), apply: false, json: false, machine: false, includeBusy: false });
    expect(parseOptions(["a", "--apply", "--json", "--machine", "--include-busy", "--builds", "b"])).toEqual({
      names: ["a", "b"],
      tiers: new Set(["caches", "builds"]),
      apply: true,
      json: true,
      machine: true,
      includeBusy: true,
    });
    expect(() => parseOptions(["-x"])).toThrow("unknown option -x\n\nUsage: space-cleanup");
  });

  test("names each unsafe path's first failing check, in order", () => {
    const root = fixture();
    for (const rel of ["", "/abs", "a/../b", "./dist", "dist/.git/x"]) expect(unsafeReason(root, rel), rel).toBe("outside the repository");
    expect(unsafeReason(root, "nothing-here")).toBe("missing");
    symlinkSync(path.join(root, "dist"), path.join(root, "linked"));
    expect(unsafeReason(root, "linked/index.js")).toBe("symlink");
    // A repository named like credentials is reported as the repository.
    mkdirSync(path.join(root, ".env.d/.git"), { recursive: true });
    write(root, { ".env.d/build/x": "x" });
    expect(unsafeReason(root, ".env.d/build")).toBe("inside repository .env.d");
    expect(unsafeReason(root, "src/index.ts")).toBe("tracked");
    expect(unsafeReason(root, "coverage")).toBe("not ignored");
    expect(unsafeReason(root, "dist")).toBeUndefined();
  });

  test("joins process listings field by field", () => {
    const table = [" 10   1  10 501 S    /usr/bin/node", " 11  10  10 501 S+   bun", "garbage"].join("\n");
    const args = " 10 node build\n 11 bun test --watch";
    const lsof = "n/ignored-before-any-pid\np10\nfcwd\nn/repo\np11\nn/repo/app\n";
    expect(parseProcesses(table, args, lsof, 501, () => true)).toEqual([
      { pid: 10, ppid: 1, pgid: 10, name: "node", args: "node build", cwd: "/repo" },
      { pid: 11, ppid: 10, pgid: 10, name: "bun", args: "bun test --watch", cwd: "/repo/app" },
    ]);
    const many = [1, 2, 3, 4].map(pid => ` ${pid} 0 ${pid} 501 S proc${pid}`).join("\n");
    expect(() => parseProcesses(many, "", "", 501, () => true)).toThrow(
      /^cannot read the working directory of proc1 1, proc2 2, proc3 3, \.\.\.; without every process's/,
    );
  });
});
