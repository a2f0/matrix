import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { busyRoots, findCandidates, main, parseIgnored, parseOptions, resolveTargets, selected, unsafeReason, INSTALLING, applyMachine, gitEnvironment, machineItems, type Host, type Proc } from "../skills/space-cleanup/scripts/space-cleanup";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, rel: string, text = "x") {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

/** A repository with every kind of ignored path the cleanup must tell apart. */
function fixture(root = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-"))): string {
  temps.push(root);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  write(root, ".gitignore", ["node_modules/", ".turbo/", "dist/", "build/", "out/", ".wrangler/", ".secrets", ".env", "packages/*/node_modules/", "scratch/"].join("\n"));
  write(root, "src/index.ts");
  write(root, ".turbo/cache/a");
  write(root, "dist/index.js");
  // Build-named trees holding credentials or a local database.
  write(root, "packages/app/dist/.env", "SECRET=1");
  write(root, "packages/app/out/data.sqlite");
  write(root, "packages/app/.turbo/.env.example");
  // A clone nested deep inside a cache directory.
  mkdirSync(path.join(root, "test-results/vendor/clone/.git"), { recursive: true });
  write(root, "test-results/vendor/clone/notes.md");
  write(root, "node_modules/pkg/index.js");
  write(root, "node_modules/.cache/babel/a");
  write(root, "packages/app/package.json", "{}");
  write(root, "packages/app/node_modules/pkg/index.js");
  write(root, ".wrangler/state/d1/db.sqlite");
  write(root, ".wrangler/tmp/bundle.js");
  write(root, ".env", "SECRET=1");
  write(root, "scratch/notes.md");
  // Untracked but not ignored: only a person decides about these.
  write(root, "coverage/lcov.info");
  // Ignored but tracked: never removed.
  write(root, "build/keep.txt");
  git(root, "add", "-f", "build/keep.txt");
  // An ignored nested repository named like build output.
  mkdirSync(path.join(root, "out", ".git"), { recursive: true });
  write(root, "out/file");
  // A symlink to credentials outside the repository.
  const secrets = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-secrets-"));
  temps.push(secrets);
  write(secrets, "prod/key", "secret");
  symlinkSync(secrets, path.join(root, ".secrets"));
  git(root, "add", ".gitignore", "src/index.ts", "packages/app/package.json");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
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
      "dist": "builds",
      "node_modules": "deps",
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
    } finally { console.log = quiet; }
    for (const gone of ["packages/app/.turbo", ".turbo", "node_modules/.cache", ".wrangler/tmp"]) expect(existsSync(path.join(root, gone))).toBe(false);
    for (const kept of ["packages/app/dist/.env", "packages/app/out/data.sqlite", "test-results/vendor/clone/notes.md", "dist", "node_modules/pkg", ".wrangler/state/d1/db.sqlite", ".env", "scratch/notes.md", "coverage/lcov.info", "build/keep.txt", "out/file", ".secrets/prod/key", "src/index.ts"]) {
      expect(existsSync(path.join(root, kept))).toBe(true);
    }
  });

  test("resolves a matrix workspace to itself and its checkouts, and a checkout to itself", () => {
    const workspace = fixture();
    write(workspace, "matrix.json", "{}");
    const checkout = realpathSync(fixture(path.join(workspace, "checkouts", "app")));
    write(workspace, ".gitignore", "checkouts/\n");
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
    ];
    const busy = busyRoots(procs, ["/w", "/w/checkouts/a", "/w/checkouts/b"], 11);
    expect(Object.fromEntries([...busy].map(([root, list]) => [root, list.map(proc => proc.pid)]))).toEqual({
      "/w/checkouts/a": [13, 22],
      "/w/checkouts/b": [21, 24],
      "/w": [23],
    });
  });

  test("rechecks tracked files at removal time", () => {
    const root = fixture();
    expect(unsafeReason(root, ".turbo")).toBeUndefined();
    git(root, "add", "-f", ".turbo/cache/a");
    expect(unsafeReason(root, ".turbo")).toBe("tracked");
  });

  test("--deps alone adds only dependencies", () => {
    expect(parseOptions(["--deps"]).tiers).toEqual(new Set(["caches", "deps"]));
  });

  test("fails closed when processes cannot be listed", () => {
    const root = fixture();
    expect(() => main([root, "--apply"], root, () => { throw new Error("cannot list processes with lsof"); })).toThrow("cannot list processes");
    expect(existsSync(path.join(root, ".turbo"))).toBe(true);
  });

  test("ignores inherited variables that bind git to another repository", () => {
    const root = fixture();
    const other = fixture();
    write(other, ".turbo/tracked");
    git(other, "add", "-f", ".turbo/tracked");
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      expect(gitEnvironment().GIT_DIR).toBeUndefined();
      expect(unsafeReason(root, ".turbo")).toBeUndefined();
      expect(findCandidates(root).map(candidate => candidate.path)).toContain(".turbo");
      expect(unsafeReason(other, ".turbo")).toBe("tracked");
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  describe("--machine", () => {
    function host(commands: string[]) {
      const home = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-home-"));
      temps.push(home);
      write(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x");
      write(home, "Library/Developer/Xcode/DerivedData/App-abc/SourcePackages/checkouts/Lib/.git/HEAD");
      write(home, "Library/Developer/Xcode/DerivedData/SourcePackages/checkouts/Shared/.git/HEAD");
      write(home, ".bun/install/cache/pkg/x");
      write(home, ".gradle/caches/x");
      const ran: string[] = [];
      const fake: Host = {
        home,
        has: command => commands.includes(command),
        output: command => {
          if (command === "bun") return path.join(home, ".bun/install/cache");
          if (command === "xcrun") return "    iPhone 8 (ABC) (Shutdown) (unavailable, runtime profile not found)\n";
          if (command === "brew") return "==> This operation would free approximately 1.5GB of disk space.";
          return "";
        },
        run: (command, args) => { ran.push(`${command} ${args.join(" ")}`); return ""; },
      };
      return { home, ran, fake };
    }

    test("empties DerivedData, runs cache commands, and leaves report-only items alone", () => {
      const { home, ran, fake } = host(["bun", "xcrun", "brew"]);
      const items = machineItems([], fake);
      expect(items.filter(item => item.reportOnly).map(item => item.id).toSorted()).toEqual(["gradle-caches", "unavailable-simulators"]);
      expect(applyMachine(items, () => [])).toBe(0);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/Build"))).toBe(false);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/App-abc/SourcePackages/checkouts/Lib/.git/HEAD"))).toBe(true);
      expect(existsSync(path.join(home, "Library/Developer/Xcode/DerivedData/SourcePackages/checkouts/Shared/.git/HEAD"))).toBe(true);
      expect(ran.toSorted()).toEqual(["brew cleanup", "bun pm cache rm"]);
      expect(existsSync(path.join(home, ".gradle/caches/x"))).toBe(true);
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
    const home = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-home-"));
    temps.push(home);
    write(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x");
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
    const discover = (): Proc[] => calls++ === 0 ? [] : [{ pid: 999999, ppid: 1, name: "node", args: "vite build", cwd: path.join(root, "src") }];
    const quiet = console.log;
    console.log = () => {};
    try { expect(main([root, "--apply"], root, discover)).toBe(0); } finally { console.log = quiet; }
    expect(calls).toBe(2);
    expect(existsSync(path.join(root, ".turbo"))).toBe(true);
  });

  test("canonicalizes symlinked targets so busy detection sees them", () => {
    const root = realpathSync(fixture());
    const linkDir = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-link-"));
    temps.push(linkDir);
    symlinkSync(root, path.join(linkDir, "repo"));
    expect(resolveTargets(linkDir, ["repo"]).targets.map(target => target.root)).toEqual([root]);
  });

  test("canonicalizes checkouts reached through a symlinked checkouts directory", () => {
    const workspace = realpathSync(fixture());
    write(workspace, "matrix.json", "{}");
    write(workspace, ".gitignore", "checkouts\n");
    const elsewhere = realpathSync(mkdtempSync(path.join(os.tmpdir(), "space-cleanup-checkouts-")));
    temps.push(elsewhere);
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
    ]) expect(INSTALLING.test(args)).toBe(true);
    for (const args of ["bun test", "npm run build", "brew list", "node install.js"]) expect(INSTALLING.test(args)).toBe(false);
  });

  test("lists processes again before each guarded machine item", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "space-cleanup-home-"));
    temps.push(home);
    write(home, "Library/Developer/Xcode/DerivedData/App-abc/Build/x");
    write(home, ".npm/_cacache/x");
    const ran: string[] = [];
    const fake: Host = { home, has: command => command === "npm", output: () => "", run: (command, args) => { ran.push(`${command} ${args.join(" ")}`); return ""; } };
    const items = machineItems([], fake);
    let calls = 0;
    // An install starts after DerivedData is cleaned and before the npm cache is.
    applyMachine(items, () => calls++ === 0 ? [] : [{ pid: 8, ppid: 1, name: "node", args: "node /x/npm-cli.js install", cwd: "/x" }]);
    expect(calls).toBe(2);
    expect(ran).toEqual([]);
    expect(items.find(item => item.id === "npm-cache")?.skipped).toBe("an install is running (pid 8)");
  });

  test("rejects unknown options", () => {
    expect(() => parseOptions(["--force"])).toThrow("unknown option --force");
    expect(parseOptions(["--builds", "--deps", "tearleads"]).tiers).toEqual(new Set(["caches", "builds", "deps"]));
  });
});
