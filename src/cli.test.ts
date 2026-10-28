import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.com", ...args], { cwd, stdio: "ignore" });
}

/** A conforming checkout whose origin metadata satisfies `status` without a network. */
function checkout(name: string): void {
  const directory = path.join(root, "checkouts", name);
  mkdirSync(directory, { recursive: true });
  const files: Record<string, string> = {
    "AGENTS.md": "# Guidance\n\n## Output capture\n\nUse `bun run agent:run` and `bun run agent:logs`.\n",
    "README.md": `# ${name}\n\n## Quick start\n`,
    ".gitignore": ".DS_Store\n",
    "package.json": JSON.stringify({ scripts: { "agent:run": "agent-tool run", "agent:logs": "agent-tool logs" }, devDependencies: { "@a2f0/agent-tool": "0.1.21" } }),
    "agent-tool.json": "{}",
    ".agent-tool-skills.json": JSON.stringify({ schemaVersion: 1, files: {} }),
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(directory, file), content);
  git(directory, "init", "-q", "-b", "main");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "init");
  git(directory, "remote", "add", "origin", `git@github.com:a2f0/${name}.git`);
  git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

/** Run the CLI in its own process, as a script would, and return its exit status and JSON output. */
function matrix(...args: string[]): { status: number | null; output: Record<string, unknown> } {
  const cli = path.join(import.meta.dir, "cli.ts");
  const script = `import { main } from ${JSON.stringify(cli)}; process.exitCode = main(${JSON.stringify(args)}, ${JSON.stringify(root)});`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  return { status: result.status, output: JSON.parse(result.stdout) as Record<string, unknown> };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "matrix-cli-"));
  const manifest = { schemaVersion: 1, protocol: "ssh", discover: { owner: "a2f0", visibility: "public", exclude: [] }, repos: ["a2f0/good", "a2f0/missing"] };
  writeFileSync(path.join(root, "matrix.json"), `${JSON.stringify(manifest)}\n`);
  checkout("good");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("audit exits zero only when every selected checkout passes", () => {
  expect(matrix("audit", "good")).toMatchObject({ status: 0, output: { ok: true, failures: {} } });
  expect(matrix("audit")).toMatchObject({ status: 1, output: { ok: false } });
  writeFileSync(path.join(root, "checkouts", "good", ".gitignore"), "node_modules/\n");
  expect(matrix("audit", "good", "--rule", "ds-store-ignored")).toMatchObject({ status: 1, output: { failures: { "ds-store-ignored": ["a2f0/good"] } } });
});
