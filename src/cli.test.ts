import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, type Services } from "./cli";

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
  // Sweep ledgers live in the workspace's Git directory.
  git(root, "init", "-q");
  checkout("good");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("audit exits zero only when every selected checkout passes", () => {
  expect(matrix("audit", "good")).toMatchObject({ status: 0, output: { ok: true, failures: {} } });
  expect(matrix("audit")).toMatchObject({ status: 1, output: { ok: false } });
  writeFileSync(path.join(root, "checkouts", "good", ".gitignore"), "node_modules/\n");
  expect(matrix("audit", "good", "--rule", "ds-store-ignored")).toMatchObject({ status: 1, output: { failures: { "ds-store-ignored": ["a2f0/good"] } } });
});

/** Services that record output and stand in for GitHub and the registry. */
function fakeServices(overrides: Partial<Services> = {}) {
  const writes: string[] = [];
  const calls = { discover: 0, registry: 0 };
  const services: Services = {
    write: text => { writes.push(text); },
    listOwnerRepos: () => { calls.discover++; return ["a2f0/good", "a2f0/missing", "a2f0/new"]; },
    registryLatest: () => { calls.registry++; return "0.1.23"; },
    ...overrides,
  };
  return { services, writes, calls };
}

test("health reports findings without the network unless asked, and exits zero", () => {
  const offline = fakeServices({
    listOwnerRepos: () => { throw new Error("health asked GitHub without --remote"); },
    registryLatest: () => { throw new Error("health asked the registry without --remote"); },
  });
  expect(main(["health"], root, undefined, offline.services)).toBe(0);
  const report = JSON.parse(offline.writes.join("")) as Record<string, unknown>;
  expect(report).toMatchObject({ ok: false, remote: false, checkouts: { total: 2, ready: 1 }, audit: { failures: {}, unaudited: ["a2f0/missing"] } });
  expect(report).not.toHaveProperty("discovery");
  expect(report.suggestions).toEqual([
    "Inspect a2f0/missing before the next sweep: checkout missing; run sync.",
    // The fixture pins agent-tool without installing it.
    "Reinstall dependencies in a2f0/good; their node_modules hold a different agent-tool than they pin.",
  ]);

  const online = fakeServices();
  expect(main(["health", "--remote", "--markdown"], root, undefined, online.services)).toBe(0);
  const markdown = online.writes.join("");
  expect(online.calls).toEqual({ discover: 1, registry: 1 });
  expect(markdown).toContain("- Audit (11 rules): `agent-tool-latest` fails in 1; a2f0/missing not audited.");
  expect(markdown).toContain("- Discovery: 1 new repository, 0 no longer found.");
  expect(markdown).toContain("Onboard a2f0/new: `bun run discover --apply`");
});

test("health rejects arguments it does not take", () => {
  expect(() => main(["health", "dnbm"], root, undefined, fakeServices().services)).toThrow("Usage: matrix health");
  expect(() => main(["health", "--apply"], root, undefined, fakeServices().services)).toThrow("Unknown health option '--apply'.");
});
