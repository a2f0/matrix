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
    "package.json": JSON.stringify({ scripts: { "agent:run": "agent-tool run", "agent:logs": "agent-tool logs", "agents:check": "agent-tool skills check && agent-tool permissions check" }, devDependencies: { "@a2f0/agent-tool": "0.1.21" } }),
    ".agent-tool-permissions.json": JSON.stringify({ schemaVersion: 1 }),
    ".claude/settings.json": JSON.stringify({ permissions: { allow: [], ask: [] } }),
    ".codex/rules/agent-tool.rules": "",
    "agent-tool.json": "{}",
    ".agent-tool-skills.json": JSON.stringify({ schemaVersion: 1, files: {} }),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
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
const GIB = 1024 ** 3;
const CLEAN_TEARDOWN = { ok: true, leftover: [], kept: [], stopped: [], untracked: [], worktrees: [], unavailable: [], skipped: [] };

function fakeServices(overrides: Partial<Services> = {}) {
  const writes: string[] = [];
  const warnings: string[] = [];
  const calls = { discover: 0, registry: 0 };
  const services: Services = {
    write: text => { writes.push(text); },
    warn: text => { warnings.push(text); },
    listOwnerRepos: () => { calls.discover++; return ["a2f0/good", "a2f0/missing", "a2f0/new"]; },
    // Released long enough ago that a pin without it is past the grace period.
    registryReleases: () => { calls.registry++; return { "0.1.21": "2026-01-01T00:00:00.000Z", "0.1.23": "2026-02-01T00:00:00.000Z" }; },
    diskSpace: () => ({ free: 200 * GIB, total: 500 * GIB }),
    teardown: () => CLEAN_TEARDOWN,
    ...overrides,
  };
  return { services, writes, warnings, calls };
}

test("health reports findings without the network unless asked, and exits zero", () => {
  const offline = fakeServices({
    listOwnerRepos: () => { throw new Error("health asked GitHub without --remote"); },
    registryReleases: () => { throw new Error("health asked the registry without --remote"); },
  });
  expect(main(["health"], root, undefined, offline.services)).toBe(0);
  const report = JSON.parse(offline.writes.join("")) as Record<string, unknown>;
  expect(report).toMatchObject({ ok: false, remote: false, checkouts: { total: 2, ready: 1 }, audit: { failures: {}, unaudited: ["a2f0/missing"] } });
  expect(report).not.toHaveProperty("discovery");
  expect(report.disk).toEqual({ free: 200 * GIB, total: 500 * GIB, low: false });
  expect(report.suggestions).toEqual([
    "Inspect a2f0/missing before the next sweep: checkout missing; run sync.",
    // The fixture pins agent-tool without installing it.
    "Reinstall dependencies in a2f0/good; their node_modules hold a different agent-tool than they pin.",
  ]);

  const online = fakeServices({ diskSpace: () => ({ free: 31.5 * GIB, total: 926 * GIB }) });
  expect(main(["health", "--remote", "--markdown"], root, undefined, online.services)).toBe(0);
  const markdown = online.writes.join("");
  expect(online.calls).toEqual({ discover: 1, registry: 1 });
  expect(markdown).toContain("- Disk: 31 GiB free of 926 GiB, under the 50 GiB a sweep needs.");
  expect(markdown).toContain("1. Free disk space before the next sweep: 31 GiB free of 926 GiB; validation needs at least 50 GiB; `bun run space` lists what is safe to remove.");
  expect(markdown).toContain("- Audit (14 rules): `agent-tool-latest` fails in 1; a2f0/missing not audited.");
  expect(markdown).toContain("- Discovery: 1 new repository, 0 no longer found.");
  expect(markdown).toContain("Onboard a2f0/new: `bun run discover --apply`");
});

test("teardown inspects the workspace and each present checkout, and exits 1 while anything remains", () => {
  const calls: Array<[string, boolean]> = [];
  const { services, writes } = fakeServices({
    teardown: (_root, directory, apply) => {
      calls.push([path.relative(root, directory) || ".", apply]);
      return directory.endsWith("good") && !apply
        ? { ...CLEAN_TEARDOWN, ok: false, leftover: [{ id: "0123abcd", label: "site", ports: ["127.0.0.1:4000"] }], untracked: [{ pid: 9, command: "python3 -m http.server", ports: ["*:8000"] }, { pid: 10, command: "zsh", ports: [] }] }
        : { ...CLEAN_TEARDOWN, stopped: apply ? [{ id: "0123abcd", stopped: true }] : [] };
    },
  });
  expect(main(["teardown"], root, undefined, services)).toBe(1);
  // The missing checkout is skipped; the workspace comes first.
  expect(calls).toEqual([[".", false], ["checkouts/good", false]]);
  expect(JSON.parse(writes.join(""))).toEqual({
    ok: false,
    applied: false,
    repos: [
      { repo: "workspace", path: root, ok: true, leftover: [], listeners: [], kept: [], stopped: [], worktrees: [], problems: [] },
      { repo: "a2f0/good", path: path.join(root, "checkouts", "good"), ok: false, leftover: ["site (0123abcd) on 127.0.0.1:4000"], listeners: ["pid 9 on *:8000: python3 -m http.server"], kept: [], stopped: [], worktrees: [], problems: [] },
    ],
  });
  calls.length = 0; writes.length = 0;
  expect(main(["teardown", "good", "--apply"], root, undefined, services)).toBe(0);
  expect(calls).toEqual([["checkouts/good", true]]);
  expect(JSON.parse(writes.join(""))).toMatchObject({ ok: true, applied: true, repos: [{ repo: "a2f0/good", stopped: ["0123abcd"] }] });
  // One repository failing to inspect is reported, and the rest still run.
  const failing = fakeServices({ teardown: (_root, directory) => { if (directory === root) throw new Error("agent-tool teardown could not run: ENOENT"); return CLEAN_TEARDOWN; } });
  expect(main(["teardown"], root, undefined, failing.services)).toBe(1);
  expect(JSON.parse(failing.writes.join("")).repos.map((item: { repo: string; ok: boolean; problems: string[] }) => [item.repo, item.ok, item.problems])).toEqual([
    ["workspace", false, ["agent-tool teardown could not run: ENOENT"]],
    ["a2f0/good", true, []],
  ]);
});

test("health suggests stopping what teardown finds", () => {
  const { services, writes } = fakeServices({ teardown: (_root, directory) => directory === root ? CLEAN_TEARDOWN : { ...CLEAN_TEARDOWN, ok: false, unavailable: ["listening ports (lsof)"] } });
  expect(main(["health", "--markdown"], root, undefined, services)).toBe(0);
  const markdown = writes.join("");
  expect(markdown).toContain("- Running: teardown fails in a2f0/good.");
  expect(markdown).toContain("1. Stop what earlier work left running in a2f0/good: `bun run teardown` lists it, `--apply` stops recorded processes, and untracked ones need stopping by hand.");
});

test("health rejects arguments it does not take", () => {
  expect(() => main(["health", "dnbm"], root, undefined, fakeServices().services)).toThrow("Usage: matrix health");
  expect(() => main(["health", "--apply"], root, undefined, fakeServices().services)).toThrow("Unknown health option '--apply'.");
});

test("sweep record warns about a new cause, and resolve quiets a recurring one", () => {
  const { services, warnings } = fakeServices();
  expect(main(["sweep", "start", "chore/one", "good", "missing"], root, undefined, services)).toBe(0);
  expect(main(["sweep", "record", "chore/one", "good", "--retry", "machine-load:suite timed out"], root, undefined, services)).toBe(0);
  // The first ledger has nothing to compare with.
  expect(warnings).toEqual([]);
  expect(main(["sweep", "start", "chore/two", "good"], root, undefined, services)).toBe(0);
  expect(main(["sweep", "record", "chore/two", "good", "--retry", "host-load", "--retry", "machine-load"], root, undefined, services)).toBe(0);
  expect(warnings).toEqual(["Note: 'host-load' is a new retry cause; earlier ledgers use machine-load. Reuse one when it names the same cause, so retro can group them.\n"]);

  const retroOf = () => {
    const run = fakeServices();
    main(["sweep", "retro"], root, undefined, run.services);
    return JSON.parse(run.writes.join("")) as { recurring: Array<{ cause: string }>; resolved: Array<{ cause: string; resolution: { resolution: string } }> };
  };
  expect(retroOf().recurring.map(group => group.cause)).toEqual(["machine-load"]);
  expect(main(["sweep", "resolve", "retry", "machine-load", "--resolution", "Run at most two heavy suites at once", "--pr", "https://github.com/a2f0/matrix/pull/41"], root, undefined, services)).toBe(0);
  expect(retroOf()).toMatchObject({ recurring: [], resolved: [{ cause: "machine-load", resolution: { resolution: "Run at most two heavy suites at once" } }] });

  // A cause that happens again after its resolution recurs again.
  expect(main(["sweep", "record", "chore/two", "good", "--retry", "machine-load"], root, undefined, services)).toBe(0);
  expect(retroOf().recurring.map(group => group.cause)).toEqual(["machine-load"]);

  expect(() => main(["sweep", "resolve", "retry", "machine-load"], root, undefined, services)).toThrow("Usage: matrix sweep resolve");
  expect(() => main(["sweep", "resolve", "rerun", "machine-load", "--resolution", "x"], root, undefined, services)).toThrow("--kind must be one of");
  expect(() => main(["sweep", "resolve", "retry", "machine-load:detail", "--resolution", "x"], root, undefined, services)).toThrow("without a detail");
});
