import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { envFilesAbove, geminiFiles, untrackedGeminiFiles } from "./geminiFiles";
import { gitIn, gitInit, SPAWNS, tempDir } from "./testFixtures";

function write(root: string, files: string[]): void {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "x\n");
  }
}

test(
  "lists untracked and ignored .gemini/ and .env files at any depth, outside node_modules, and never tracked ones",
  () => {
    const repo = tempDir("matrix-gemini");
    gitInit(repo);
    write(repo, [
      ".gitignore",
      ".gemini/policies/agent-tool.toml",
      ".gemini/settings.json",
      ".env",
      "packages/web/.env",
      "packages/web/.gemini/commands/deploy.toml",
      "node_modules/pkg/.gemini/settings.json",
      "packages/web/node_modules/pkg/.env",
      "src/.envrc",
      "notes.env",
      "GEMINI.md",
      "packages/web/build/.env",
      "packages/api/.ENV",
      "scripts/build/GEMINI.md",
      "dist/GEMINI.md",
    ]);
    writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\ndist/\n");
    gitIn(repo, "add", ".gitignore", ".gemini/policies/agent-tool.toml");
    gitIn(repo, "commit", "-q", "-m", "init");
    // `.env` and `packages/web/.env` are ignored, the rest untracked; the committed policy is tracked.
    // A build tree's ignored files are skipped, but one Git does not ignore can hold source.
    // Names match in any case, as macOS's default file system does.
    const listed = [
      ".env",
      ".gemini/settings.json",
      "GEMINI.md",
      "packages/api/.ENV",
      "packages/web/.env",
      "packages/web/.gemini/commands/deploy.toml",
      "scripts/build/GEMINI.md",
    ];
    expect(untrackedGeminiFiles(repo)).toEqual(listed);
    expect(untrackedGeminiFiles(repo, ["/packages/"])).toEqual([".env", ".gemini/settings.json", "GEMINI.md", "scripts/build/GEMINI.md"]);
    expect(() => untrackedGeminiFiles(tempDir("matrix-not-git"))).toThrow(/git ls-files failed/);
    // A scanned folder's fsmonitor never runs, and an inherited GIT_DIR does not redirect the listing.
    const marker = path.join(tempDir("matrix-fsmonitor"), "ran");
    const monitor = path.join(path.dirname(marker), "fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    gitIn(repo, "config", "core.fsmonitor", monitor);
    const other = tempDir("matrix-other");
    gitInit(other);
    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, ".git");
    try {
      // Another repository's empty index would list the committed policy as untracked.
      expect(untrackedGeminiFiles(repo)).toEqual(listed);
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
    expect(existsSync(marker)).toBe(false);
  },
  SPAWNS,
);

test("finds the .env files Gemini's upward search reaches above the workspace, nearest first, by home-relative name", () => {
  // A linked home resolves too, so files under it show once, as ~/...
  // A link to the workspace resolves first, as Gemini starts from its real working directory.
  const base = realpathSync(tempDir("matrix-above"));
  const root = path.join(base, "github", "matrix"),
    home = path.join(base, "home");
  mkdirSync(root, { recursive: true });
  symlinkSync(root, path.join(base, "link"));
  write(base, ["github/matrix/checkouts/.env", "github/.gemini/.env", "github/.env", ".env", "home/.gemini/.env", "home/.env", "github/matrix/.env"]);
  const inFixture = (files: string[]) => files.filter(file => file.startsWith(base) || file.startsWith("~") || file.startsWith("checkouts/"));
  symlinkSync(home, path.join(base, "home-link"));
  expect(inFixture(envFilesAbove(path.join(base, "link"), path.join(base, "home-link")))).toEqual(inFixture(envFilesAbove(path.join(base, "link"), home)));
  expect(inFixture(envFilesAbove(path.join(base, "link"), home))).toEqual([
    "checkouts/.env",
    path.join(base, "github", ".gemini", ".env"),
    path.join(base, "github", ".env"),
    path.join(base, ".env"),
    "~/.gemini/.env",
    "~/.env",
  ]);
});

test(
  "combines the workspace outside checkouts/, each checkout relative to the workspace, and the files above",
  () => {
    const base = realpathSync(tempDir("matrix-combined"));
    const root = path.join(base, "matrix"),
      checkout = path.join(root, "checkouts", "demo");
    mkdirSync(checkout, { recursive: true });
    gitInit(root);
    gitInit(checkout);
    write(root, [".gemini/settings.json", "checkouts/demo/.env", "checkouts/demo/app/.gemini/.env", "checkouts/demo/.venv/lib/pkg/.env"]);
    writeFileSync(path.join(checkout, ".gitignore"), ".venv/\n");
    write(base, [".env"]);
    // A checkout Git cannot list is reported on its own, and the others are still scanned.
    const broken = path.join(root, "checkouts", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent\n");
    const { files, unscanned } = geminiFiles(root, { managed: [broken, checkout], unmanaged: [] }, path.join(base, "home"));
    expect(files.filter(file => !file.startsWith("/") || file.startsWith(base))).toEqual([
      ".gemini/settings.json",
      "checkouts/demo/.env",
      "checkouts/demo/app/.gemini/.env",
      path.join(base, ".env"),
    ]);
    expect(unscanned).toEqual(["checkouts/broken"]);
    // A workspace Git cannot list is named as `.`, and its checkouts are still scanned.
    const loose = path.join(base, "loose"),
      inside = path.join(loose, "checkouts", "demo");
    mkdirSync(inside, { recursive: true });
    gitInit(inside);
    write(loose, ["checkouts/demo/GEMINI.md"]);
    const partial = geminiFiles(loose, { managed: [inside], unmanaged: [] }, path.join(base, "home"));
    expect(partial.files.filter(file => !file.startsWith("/") && !file.startsWith("~"))).toEqual(["checkouts/demo/GEMINI.md"]);
    expect(partial.unscanned).toEqual(["."]);
    // An unmanaged clone's committed files load too, and no audit covers them, so they are listed as well.
    const clone = path.join(root, "checkouts", "clone");
    mkdirSync(clone, { recursive: true });
    gitInit(clone);
    write(clone, [".gemini/settings.json", "GEMINI.md"]);
    gitIn(clone, "add", ".");
    gitIn(clone, "commit", "-q", "-m", "init");
    const unmanagedScan = geminiFiles(root, { managed: [], unmanaged: [clone] }, path.join(base, "home"));
    expect(unmanagedScan.files.filter(file => file.startsWith("checkouts/"))).toEqual(["checkouts/clone/.gemini/settings.json", "checkouts/clone/GEMINI.md"]);
    expect(geminiFiles(root, { managed: [clone], unmanaged: [] }, path.join(base, "home")).files.filter(file => file.startsWith("checkouts/"))).toEqual([]);
    // A linked checkout, and every checkout inside a linked checkouts/, is named without being followed.
    const linked = path.join(base, "linked");
    mkdirSync(linked, { recursive: true });
    symlinkSync(checkout, path.join(root, "checkouts", "link"));
    symlinkSync(path.join(root, "checkouts"), path.join(linked, "checkouts"));
    gitInit(linked);
    expect(geminiFiles(root, { managed: [], unmanaged: [path.join(root, "checkouts", "link")] }, path.join(base, "home")).unscanned).toEqual([
      "checkouts/link",
    ]);
    // A link loop is named too, not allowed to stop the scan.
    const loop = path.join(root, "checkouts", "loop");
    symlinkSync(loop, loop);
    expect(geminiFiles(root, { managed: [], unmanaged: [loop] }, path.join(base, "home")).unscanned).toEqual(["checkouts/loop"]);
    expect(geminiFiles(linked, { managed: [path.join(linked, "checkouts", "demo")], unmanaged: [] }, path.join(base, "home")).unscanned).toEqual([
      "checkouts/demo",
    ]);
    // A listing that outlasts the scan's limit is named too, as a large ignored folder outside the build trees
    // would be, and so is every folder left after it, without another listing.
    const bin = tempDir("matrix-slow-git");
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
    const inherited = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${inherited}`;
    try {
      expect(geminiFiles(root, { managed: [checkout], unmanaged: [] }, path.join(base, "home"), 200).unscanned).toEqual([".", "checkouts/demo"]);
    } finally {
      process.env.PATH = inherited;
    }
  },
  SPAWNS,
);
