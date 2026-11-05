import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codeLines, language, scanFile, scanText } from "../skills/explicit-state-machines/scripts/scan";
import { main, parseOptions } from "../skills/explicit-state-machines/scripts/state-machines";
import { resolveTargets } from "../skills/explicit-state-machines/scripts/targets";
import { resolveTargets as cleanupTargets } from "../skills/space-cleanup/scripts/targets";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

function repo(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
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
    expect(signals.find(signal => signal.kind === "status")).toEqual({ kind: "status", names: ["status"], values: ["done", "error", "running"], lines: [4, 7, 10] });
    expect(signals.find(signal => signal.kind === "flags")?.names).toEqual(["_running", "is_dirty"]);
  });

  test("ignores one flag, flags set only one way, guards, settings, comments and explicit unions", () => {
    expect(scanText("const [isLoading, setIsLoading] = useState(false);\nsetIsLoading(true);\nsetIsLoading(false);", "c")).toEqual([]);
    expect(scanText("let isDone = false;\nlet isReady = false;\nisDone = true;", "c")).toEqual([]);
    expect(scanText("let cancelled = false;\nlet settled = false;\ncancelled = true;\nsettled = true;", "c")).toEqual([]);
    expect(scanText("let darkMode = false;\nlet enabled = true;\ndarkMode = true;\nenabled = false;", "c")).toEqual([]);
    expect(scanText("// isLoading = true; hasError = false;\n/* isLoading = false;\n hasError = true; */", "c")).toEqual([]);
    expect(scanText("type S =\n  | { status: \"idle\" }\n  | { status: \"loading\" }\n  | { status: \"failed\" };\nreturn { status: \"idle\" };", "c")).toEqual([]);
    expect(scanText("if (status === \"a\") x();\nif (status == \"b\") y();\nif (status === \"c\") z();", "c")).toEqual([]);
  });

  test("keeps line numbers through block comments and URLs", () => {
    expect(codeLines("a /* x */ b\n/* start\nmiddle\nend */ c\nurl = \"https://x\" // note", "c")).toEqual(["a  b", "", "", " c", "url = \"https://x\" "]);
    expect(codeLines("  # comment\nx = 1", "hash")).toEqual(["", "x = 1"]);
    // Comment markers inside strings are text, not comments.
    expect(codeLines("const glob = \"src/*\"; isLoading = true;\nconst u = 'a//b'; hasError = false; // c\nconst e = \"\\\"/*\";", "c"))
      .toEqual(["const glob = \"src/*\"; isLoading = true;", "const u = 'a//b'; hasError = false; ", "const e = \"\\\"/*\";"]);
    const glob = "const glob = \"src/*.ts\";\nsetIsLoading(true);\nsetIsLoading(false);\nsetHasError(true);\nsetHasError(false);";
    expect(scanText(glob, "c").map(signal => signal.names)).toEqual([["hasError", "isLoading"]]);
  });

  test("reads application source only", () => {
    expect(language("src/app.tsx")).toBe("c");
    expect(language("scripts/run.sh")).toBe("hash");
    for (const skipped of ["src/app.test.ts", "node_modules/x/index.js", "dist/app.js", "types.d.ts", ".agents/skills/x/run.ts", "src/__tests__/a.ts", "vendor/lib.go", "README.md", "app.min.js"]) {
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
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "explicit-state-machines-")));
    temps.push(home);
    const root = path.join(home, "matrix");
    repo(path.join(root, "checkouts", "app"), { "src/Items.tsx": FETCHER, "src/Items.test.tsx": FETCHER });
    repo(path.join(root, "checkouts", "worker"), { "worker.py": WORKER });
    write(path.join(root, "checkouts", "app"), "src/Untracked.tsx", FETCHER);
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

  test("resolves targets exactly as space-cleanup does", () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "explicit-state-machines-")));
    temps.push(home);
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
        else expect(resolve(cwd, names).targets.map(target => target.root).sort()).toEqual(roots!.sort());
      }
    }
  });
});
