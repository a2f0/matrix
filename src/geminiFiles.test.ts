import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
    ]);
    writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
    gitIn(repo, "add", ".gitignore", ".gemini/policies/agent-tool.toml");
    gitIn(repo, "commit", "-q", "-m", "init");
    // `.env` and `packages/web/.env` are ignored, the rest untracked; the committed policy is tracked.
    expect(untrackedGeminiFiles(repo)).toEqual([
      ".env",
      ".gemini/settings.json",
      "GEMINI.md",
      "packages/web/.env",
      "packages/web/.gemini/commands/deploy.toml",
    ]);
    expect(untrackedGeminiFiles(repo, ["/packages/"])).toEqual([".env", ".gemini/settings.json", "GEMINI.md"]);
    expect(() => untrackedGeminiFiles(tempDir("matrix-not-git"))).toThrow(/git ls-files failed/);
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
    write(base, [".env"]);
    // A checkout Git cannot list is reported on its own, and the others are still scanned.
    const broken = path.join(root, "checkouts", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent\n");
    const { files, unscanned } = geminiFiles(root, [broken, checkout], path.join(base, "home"));
    expect(files.filter(file => !file.startsWith("/") || file.startsWith(base))).toEqual([
      ".gemini/settings.json",
      "checkouts/demo/.env",
      "checkouts/demo/app/.gemini/.env",
      path.join(base, ".env"),
    ]);
    expect(unscanned).toEqual(["checkouts/broken"]);
  },
  SPAWNS,
);
