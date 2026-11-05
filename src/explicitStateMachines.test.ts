import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { codeLines, language, scanFile, scanText } from "../skills/explicit-state-machines/scripts/scan";
import { main, parseOptions, readInside } from "../skills/explicit-state-machines/scripts/state-machines";
import { resolveTargets } from "../skills/explicit-state-machines/scripts/targets";
import { resolveTargets as cleanupTargets } from "../skills/space-cleanup/scripts/targets";
import { gitIn, gitInit, tempDir, write } from "./testFixtures";

function repo(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  gitInit(root);
  write(root, files);
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-qm", "init");
  return root;
}

const FETCHER = `
export function Items() {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [open, setOpen] = useState(false);
  async function load() {
    setIsLoading(true);
    setHasError(false);
    try { await fetchItems(); } catch { setHasError(true); } finally { setIsLoading(false); }
  }
  // setOpen(true) only opens a panel
  return null;
}
`;

const WORKER = `
class SyncWorker:
    def start(self):
        self.status = "running"
        self._running = True
    def fail(self):
        self.status = "error"
        self._running = False
    def finish(self):
        self.status = "done"
        self.is_dirty = True
    def reset(self):
        self.is_dirty = False
`;

describe("explicit-state-machines scan", () => {
  test("finds lifecycle booleans that are toggled together", () => {
    const signals = scanText(FETCHER, "c");
    expect(signals).toEqual([{ kind: "flags", names: ["hasError", "isLoading"], lines: [3, 4, 7, 8, 9] }]);
  });

  test("finds a status written with many values from many places, in Python too", () => {
    const signals = scanText(WORKER, "hash");
    expect(signals.find(signal => signal.kind === "status")).toEqual({
      kind: "status",
      names: ["status"],
      values: ["done", "error", "running"],
      lines: [4, 7, 10],
    });
    expect(signals.find(signal => signal.kind === "flags")?.names).toEqual(["_running", "is_dirty"]);
  });

  test("finds machines held in refs, private fields, object members and nested status writes", () => {
    // Shapes the first sweep's readers found and the scanner missed.
    const refs = "busy.current = true;\nbusy.current = false;\nconst [paging, setPaging] = useState(false);\nsetPaging(true);";
    expect(scanText(refs, "c")).toEqual([{ kind: "flags", names: ["busy", "paging"], lines: [1, 2, 3, 4] }]);
    const element = "this.#rendered = false;\nthis.#loading = true;\nthis.#rendered = true;\nthis.#loading = false;";
    expect(scanText(element, "c").map(signal => signal.names)).toEqual([["loading", "rendered"]]);
    const viewer = "this.booting = true;\nviewer.unavailable = false;\nthis.booting = false;\nviewer.unavailable = true;";
    expect(scanText(viewer, "c").map(signal => signal.names)).toEqual([["booting", "unavailable"]]);
    const report = 'record.steps[i]!.status = "running";\nrecord.steps[i]!.status = "passed";\nrecord.steps[index].status = "failed";';
    expect(scanText(report, "c")).toEqual([{ kind: "status", names: ["status"], values: ["failed", "passed", "running"], lines: [1, 2, 3] }]);
    expect(scanText("a.b == true;\nisDone !== false;\nconst f = () => true;\nx <= true;", "c")).toEqual([]);
  });

  test("reads extensionless and Expect scripts by their shebang", () => {
    const script = "#!/usr/bin/env bash\nlocked=false\napplying=false\nlocked=true\napplying=true\n";
    expect(language("bin/deploy")).toBe("maybe");
    expect(language("bin/deploy", "#!/usr/bin/env bash")).toBe("hash");
    expect(language("bin/deploy", "#!/bin/sh")).toBe("hash");
    expect(language("bin/run", "#!/usr/bin/env -S python3 -u")).toBe("hash");
    expect(language("LICENSE", "MIT License")).toBeUndefined();
    expect(language("qemu.exp")).toBe("hash");
    expect(language("bin/boot", "#!/usr/bin/expect -f")).toBe("hash");
    expect(language("bin/run", "#!/usr/bin/env PYTHONPATH=. python3.13")).toBe("hash");
    expect(language("bin/node", "#!/usr/bin/env node")).toBeUndefined();
    expect(language("bin/shout", "#!/opt/shellac")).toBeUndefined();
    // A long, unrecognized first line returns at once instead of backtracking.
    const started = performance.now();
    expect(language("blob", `#!${"/x".repeat(200_000)}`)).toBeUndefined();
    expect(language("blob", `#!${"a".repeat(400_000)} b`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
    // A real Expect script: flags and a status set with Tcl's `set`.
    const expect_ = [
      "#!/usr/bin/expect -f",
      "set is_booted 0",
      "set ::is_installing false",
      "set phase fetch",
      "proc install {} {",
      "    set is_installing true",
      '    set phase "install"',
      "}",
      "set is_booted 1",
      "set is_installing false",
      "set phase verify",
      "set timeout 30",
    ].join("\n");
    const report = scanFile("qemu.exp", expect_);
    expect(report?.signals).toEqual([
      { kind: "flags", names: ["is_booted", "is_installing"], lines: [2, 3, 6, 9, 10] },
      { kind: "status", names: ["phase"], values: ["fetch", "install", "verify"], lines: [4, 7, 11] },
    ]);
    // Shell `set` options are not assignments.
    expect(scanText("set -euo pipefail\nset -x\nset +e", "hash")).toEqual([]);
    expect(scanFile("bin/deploy", script)).toBeUndefined();
    const flagged = "#!/usr/bin/env bash\nisLocked=false\nisApplying=false\nisLocked=true\nisApplying=true\n";
    expect(scanFile("bin/deploy", flagged)?.signals[0]?.names).toEqual(["isApplying", "isLocked"]);
    expect(scanFile("LICENSE", "isLocked=false\nisApplying=false\nisLocked=true\nisApplying=true")).toBeUndefined();
  });

  test("ignores one flag, flags set only one way, guards, settings, comments and explicit unions", () => {
    expect(scanText("const [isLoading, setIsLoading] = useState(false);\nsetIsLoading(true);\nsetIsLoading(false);", "c")).toEqual([]);
    expect(scanText("let isDone = false;\nlet isReady = false;\nisDone = true;", "c")).toEqual([]);
    expect(scanText("let cancelled = false;\nlet settled = false;\ncancelled = true;\nsettled = true;", "c")).toEqual([]);
    expect(scanText("let darkMode = false;\nlet enabled = true;\ndarkMode = true;\nenabled = false;", "c")).toEqual([]);
    expect(scanText("// isLoading = true; hasError = false;\n/* isLoading = false;\n hasError = true; */", "c")).toEqual([]);
    expect(scanText('type S =\n  | { status: "idle" }\n  | { status: "loading" }\n  | { status: "failed" };\nreturn { status: "idle" };', "c")).toEqual([]);
    expect(scanText('if (status === "a") x();\nif (status == "b") y();\nif (status === "c") z();', "c")).toEqual([]);
  });

  test("keeps line numbers through block comments and URLs", () => {
    expect(codeLines('a /* x */ b\n/* start\nmiddle\nend */ c\nurl = "https://x" // note', "c")).toEqual(["a  b", "", "", " c", 'url = "https://x" ']);
    expect(codeLines("  # comment\nx = 1", "hash")).toEqual(["", "x = 1"]);
    // Comment markers inside strings are text, not comments.
    expect(codeLines('const glob = "src/*"; isLoading = true;\nconst u = \'a//b\'; hasError = false; // c\nconst e = "\\"/*";', "c")).toEqual([
      'const glob = "src/*"; isLoading = true;',
      "const u = 'a//b'; hasError = false; ",
      'const e = "\\"/*";',
    ]);
    // Escapes, an escape or string left open at the line's end, and a block that closes and reopens.
    expect(codeLines("a = 'x\\\\' // c\nb = \"open // c\nc = \"end\\\\\nd /* x */ e /* y\nz */ f // g", "c")).toEqual([
      "a = 'x\\\\' ",
      'b = "open // c',
      'c = "end\\\\',
      "d  e ",
      " f ",
    ]);
    // Status setters, Python booleans, and a field written from too few lines.
    const setters = 'setStatus("idle");\nsetStatus("loading"); setStatus("failed");\nthis.mode = "a";\nthis.mode = "b"; this.mode = "c";\nsetStatus(\'done\');';
    expect(scanText(setters, "c")).toEqual([{ kind: "status", names: ["status"], values: ["done", "failed", "idle", "loading"], lines: [1, 2, 5] }]);
    const python = "self.is_busy = True\nself.is_busy = False\nis_open = False\nis_open = True\nmode = 'a'\nmode = 'b'\nmode = 'c'";
    expect(scanText(python, "hash")).toEqual([
      { kind: "flags", names: ["is_busy", "is_open"], lines: [1, 2, 3, 4] },
      { kind: "status", names: ["mode"], values: ["a", "b", "c"], lines: [5, 6, 7] },
    ]);
    const glob = 'const glob = "src/*.ts";\nsetIsLoading(true);\nsetIsLoading(false);\nsetHasError(true);\nsetHasError(false);';
    expect(scanText(glob, "c").map(signal => signal.names)).toEqual([["hasError", "isLoading"]]);
  });

  test("reads application source only", () => {
    expect(language("src/app.tsx")).toBe("c");
    expect(language("scripts/run.sh")).toBe("hash");
    expect(language("pkg/sync.go")).toBe("c");
    expect(language("app/testing_tools.py")).toBe("hash");
    for (const skipped of [
      "src/app.test.ts",
      "node_modules/x/index.js",
      "dist/app.js",
      "types.d.ts",
      ".agents/skills/x/run.ts",
      "src/__tests__/a.ts",
      "vendor/lib.go",
      "README.md",
      "app.min.js",
      "pkg/sync_test.go",
      "app/test_worker.py",
      "app/worker_test.py",
      "conftest.py",
      "AppTests.swift",
      "SyncSpec.kt",
    ]) {
      expect(language(skipped)).toBeUndefined();
    }
    expect(scanFile("src/app.test.tsx", FETCHER)).toBeUndefined();
    expect(scanFile("src/app.tsx", FETCHER)?.score).toBe(4);
  });
});

describe("explicit-state-machines CLI", () => {
  test("parses options and rejects unknown or invalid ones", () => {
    expect(parseOptions(["app", "--limit", "0", "--min-score", "2", "--json"])).toEqual({ names: ["app"], json: true, limit: 0, minScore: 2 });
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown option --bogus.");
    expect(() => parseOptions(["--limit"])).toThrow("--limit needs a value.");
    expect(() => parseOptions(["--limit", "-1"])).toThrow("non-negative integer");
    expect(() => parseOptions(["--min-score", "1.5"])).toThrow("non-negative integer");
  });

  test("scans every checkout of a workspace, tracked files only, and changes nothing", () => {
    const home = realpathSync(tempDir("explicit-state-machines"));
    const root = path.join(home, "matrix");
    repo(path.join(root, "checkouts", "app"), { "src/Items.tsx": FETCHER, "src/Items.test.tsx": FETCHER });
    repo(path.join(root, "checkouts", "worker"), { "worker.py": WORKER });
    write(path.join(root, "checkouts", "app"), { "src/Untracked.tsx": FETCHER });
    repo(root, { "matrix.json": "{}", ".gitignore": "checkouts/\n" });
    const before = readFileSync(path.join(root, "checkouts", "app", "src", "Items.tsx"), "utf8");
    const output: string[] = [];
    expect(main(["--json"], root, text => output.push(text))).toBe(0);
    const { repos } = JSON.parse(output.join("\n"));
    const byName = Object.fromEntries(repos.map((repo: { name: string }) => [repo.name, repo]));
    expect(Object.keys(byName).sort()).toEqual(["app", "matrix", "worker"]);
    expect(byName.app.files.map((file: { path: string }) => file.path)).toEqual(["src/Items.tsx"]);
    expect(byName.worker.files[0].score).toBe(7);
    expect(byName.matrix.files).toEqual([]);
    expect(readFileSync(path.join(root, "checkouts", "app", "src", "Items.tsx"), "utf8")).toBe(before);

    output.length = 0;
    expect(main(["worker", "--min-score", "8"], root, text => output.push(text))).toBe(0);
    expect(output.join("\n")).toContain("worker (");
    expect(output.join("\n")).toContain("0 candidate files of 1 scanned");

    output.length = 0;
    expect(main(["app", "--limit", "0"], path.join(root, "checkouts", "worker"), text => output.push(text))).toBe(2);
    expect(main(["--help"], home, text => output.push(text))).toBe(0);
    expect(output.at(-1)).toContain("Usage: state-machines");
  });

  test("defaults to listing a lone three-value status, and never reads through tracked symlinks", () => {
    expect(parseOptions([]).minScore).toBe(3);
    const home = realpathSync(tempDir("explicit-state-machines"));
    write(home, { "secret/worker.py": WORKER });
    const status = 'def a(self):\n    self.status = "one"\ndef b(self):\n    self.status = "two"\ndef c(self):\n    self.status = "three"\n';
    const root = repo(path.join(home, "repo"), { "status.py": status });
    symlinkSync(path.join(home, "secret", "worker.py"), path.join(root, "linked.py"));
    symlinkSync(path.join(home, "secret"), path.join(root, "linked-dir"));
    gitIn(root, "add", "linked.py", "linked-dir");
    gitIn(root, "commit", "-qm", "links");
    expect(readInside(root, "linked.py")).toBeUndefined();
    expect(readInside(root, "linked-dir/worker.py")).toBeUndefined();
    expect(readInside(root, "../secret/worker.py")).toBeUndefined();
    expect(readInside(root, "status.py")).toBe(status);
    // A tracked directory replaced by a link to an ignored directory inside the repository.
    write(root, { "src/app.py": WORKER });
    gitIn(root, "add", "src/app.py");
    gitIn(root, "commit", "-qm", "src");
    write(root, { ".secrets/app.py": "TOKEN = True" });
    rmSync(path.join(root, "src"), { recursive: true });
    symlinkSync(path.join(root, ".secrets"), path.join(root, "src"));
    expect(readInside(root, "src/app.py")).toBeUndefined();
    rmSync(path.join(root, "src"));
    write(root, { "src/app.py": WORKER });
    expect(readInside(root, "src/app.py")).toBe(WORKER);
    const output: string[] = [];
    expect(main(["--json"], root, text => output.push(text))).toBe(0);
    const [report] = JSON.parse(output.join("\n")).repos;
    expect(report.files.map((file: { path: string; score: number }) => [file.path, file.score])).toEqual([
      ["src/app.py", 7],
      ["status.py", 3],
    ]);
  });

  test("ranks candidates by score then path, and says how many --limit left out", () => {
    const status = 'def a(self):\n    self.status = "one"\ndef b(self):\n    self.status = "two"\ndef c(self):\n    self.status = "three"\n';
    const root = repo(path.join(realpathSync(tempDir("explicit-state-machines")), "repo"), { "b.py": WORKER, "a.py": WORKER, "status.py": status });
    const output: string[] = [];
    expect(main(["--json", "--limit", "2"], root, text => output.push(text))).toBe(0);
    const [report] = JSON.parse(output.join("\n")).repos;
    expect(Object.keys(report)).toEqual(["name", "root", "scanned", "files", "more"]);
    expect(report.files.map((file: { path: string }) => file.path)).toEqual(["a.py", "b.py"]);
    expect(report.more).toBe(1);
    output.length = 0;
    expect(main(["--limit", "1"], root, text => output.push(text))).toBe(0);
    expect(output.join("\n")).toContain("3 candidate files of 3 scanned");
    expect(output.join("\n")).toContain("  ... 2 more (raise --limit)");
    output.length = 0;
    expect(main(["--json", "--limit", "0"], root, text => output.push(text))).toBe(0);
    expect(JSON.parse(output.join("\n")).repos[0]).toMatchObject({ more: 0, files: [{ path: "a.py" }, { path: "b.py" }, { path: "status.py" }] });
  });

  test("resolves targets exactly as space-cleanup does", () => {
    const home = realpathSync(tempDir("explicit-state-machines"));
    const root = path.join(home, "matrix");
    const app = repo(path.join(root, "checkouts", "app"), { "a.ts": "" });
    const lib = repo(path.join(root, "checkouts", "lib"), { "b.ts": "" });
    repo(root, { "matrix.json": "{}", ".gitignore": "checkouts/\n" });
    const outside = repo(path.join(home, "outside"), { "c.ts": "" });
    const rows: Array<{ cwd: string; names: string[]; roots?: string[]; error?: string }> = [
      { cwd: root, names: [], roots: [root, app, lib] },
      { cwd: root, names: ["a2f0/app", "lib", "app"], roots: [app, lib] },
      { cwd: app, names: [], roots: [app] },
      { cwd: root, names: [outside], roots: [outside] },
      { cwd: root, names: ["missing"], error: "missing is neither a checkout name nor a path inside a git repository" },
      { cwd: home, names: [], error: "is not inside a git repository; name one" },
    ];
    for (const { cwd, names, roots, error } of rows) {
      for (const resolve of [resolveTargets, cleanupTargets]) {
        if (error) expect(() => resolve(cwd, names)).toThrow(error);
        else
          expect(
            resolve(cwd, names)
              .targets.map(target => target.root)
              .sort(),
          ).toEqual(roots!.sort());
      }
    }
  });
});
