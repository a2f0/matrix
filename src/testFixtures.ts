// Fixtures shared by matrix tests: temporary directories that clean up after
// each test, Git with a fixed identity, and file trees.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const temporary: string[] = [];

/** A new empty directory, by its real path as Git and lsof report it, removed after the current test. */
export function tempDir(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), `${prefix}-`)));
  temporary.push(directory);
  return directory;
}

/** Remove every directory `tempDir` made; the test preload runs this after each test. */
export function removeTempDirs(): void {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
}

const IDENTITY = ["-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

/**
 * The environment without GIT_* variables, which tests set for the code under
 * test (GIT_DIR, GIT_CONFIG_*), and with no global or system config, so
 * fixtures always build the repository they name.
 */
function fixtureEnvironment(): Record<string, string | undefined> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...environment, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Run Git in `root` as a fixed test identity that never signs; returns trimmed stdout and throws on failure. */
export function gitIn(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...IDENTITY, ...args], { encoding: "utf8", env: fixtureEnvironment() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Write each file under `root`, creating its directories. */
export function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** The default AGENTS.md and README.md of `checkoutFixture`. */
export const GUIDANCE = "# Repository guidance\n\n## Output capture\n\nRun `bun run agent:run` and read `bun run agent:logs <log>`.\n";
export const README = "# demo\n\nA demo project.\n\n## Quick start\n\n```sh\nbun install\n```\n";

let template: string | undefined;

/**
 * Make `directory` an empty repository on branch main. It copies one
 * hook-free `.git` made per test process, which costs a fraction of a
 * `git init` per fixture on a loaded machine.
 */
export function gitInit(directory: string): void {
  if (!template) {
    const holder = mkdtempSync(path.join(tmpdir(), "matrix-test-template-"));
    process.on("exit", () => rmSync(holder, { recursive: true, force: true }));
    gitIn(holder, "init", "-q", "--template=", "-b", "main");
    template = path.join(holder, ".git");
  }
  cpSync(template, path.join(directory, ".git"), { recursive: true });
}

/**
 * A checkout meeting every audit standard, pinned to `agentTool`, at
 * `directory` with an SSH origin named after it. `files` override or, with
 * null, delete the defaults. Everything is staged, not committed.
 */
export function checkoutFixture(directory: string, agentTool: string, files: Record<string, string | null> = {}): void {
  const name = path.basename(directory);
  const all: Record<string, string | null> = {
    "AGENTS.md": GUIDANCE,
    "README.md": README,
    ".gitignore": "node_modules/\n.DS_Store\n",
    "package.json": JSON.stringify({ name, scripts: { "agent:run": "agent-tool run", "agent:logs": "agent-tool logs", "agents:check": "agent-tool skills check && agent-tool permissions check" }, devDependencies: { "@a2f0/agent-tool": agentTool } }),
    ".agent-tool-permissions.json": JSON.stringify({ schemaVersion: 1 }),
    ".claude/settings.json": JSON.stringify({ permissions: { allow: [], ask: [] } }),
    ".codex/rules/agent-tool.rules": "prefix_rule(pattern=[\"agent-tool\", \"doctor\"], decision=\"allow\")\n",
    "agent-tool.json": JSON.stringify({ schemaVersion: 1 }),
    ".agent-tool-skills.json": JSON.stringify({ schemaVersion: 1, files: { ".agents/skills/ship-pr/SKILL.md": "x" } }),
    ".agents/skills/ship-pr/SKILL.md": "Reply via POST /repos/o/r/pulls/1/comments/2/replies.\n",
    ...files,
  };
  mkdirSync(directory, { recursive: true });
  gitInit(directory);
  write(directory, Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null)));
  gitIn(directory, "add", "-A");
  gitIn(directory, "remote", "add", "origin", `git@github.com:a2f0/${name}.git`);
}
