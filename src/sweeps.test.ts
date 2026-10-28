import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckoutStatus } from "./checkouts";
import { listSweeps, markdownReport, notReady, parseEvent, parseUpdate, recordEntry, retro, startSweep, sweepReport, sweepsDirectory } from "./sweeps";

const HEAD = "a".repeat(40);
let root: string;

function ready(repo: string): CheckoutStatus {
  return { repo, path: `checkouts/${repo.split("/")[1]}`, present: true, ready: true, branch: "main", defaultBranch: "main", head: HEAD, changes: 0, ahead: 0, behind: 0 };
}

const statuses: Record<string, CheckoutStatus> = {
  "a2f0/one": ready("a2f0/one"),
  "a2f0/two": { ...ready("a2f0/two"), agentTool: { pinned: "0.1.21", installed: "0.1.19", current: false } },
  "a2f0/feature": { ...ready("a2f0/feature"), ready: false, branch: "feat/x" },
  "a2f0/dirty": { ...ready("a2f0/dirty"), ready: false, changes: 2 },
  "a2f0/missing": { repo: "a2f0/missing", path: "checkouts/missing", present: false, ready: false },
};
const statusOf = (repo: string) => statuses[repo]!;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 12, minute));

function start(branch: string, repos: string[], minute = 0) {
  return startSweep(root, branch, repos, statusOf, { topic: "Demo change" }, at(minute));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "matrix-sweeps-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("startSweep", () => {
  test("opens ready checkouts at their commit and skips the rest with a reason", () => {
    const result = start("chore/demo", Object.keys(statuses));
    expect(result.counts).toEqual({ pending: 2, skipped: 3 });
    expect(result.remaining).toEqual(["a2f0/one", "a2f0/two"]);
    expect(result.repos.map(entry => [entry.repo, entry.status, entry.base ?? entry.reason])).toEqual([
      ["a2f0/one", "pending", HEAD],
      ["a2f0/two", "pending", HEAD],
      ["a2f0/feature", "skipped", "on branch feat/x"],
      ["a2f0/dirty", "skipped", "2 local changes"],
      ["a2f0/missing", "skipped", "checkout missing; run sync"],
    ]);
    expect(result.repos[1]!.notes).toEqual(["node_modules holds agent-tool 0.1.19, pinned 0.1.21; run the checkout's install before its scripts"]);
  });

  test("keeps ledgers private in the Git common directory, never in the worktree", () => {
    start("chore/demo", ["a2f0/one"]);
    const directory = path.join(sweepsDirectory(root), encodeURIComponent("chore/demo"));
    expect(directory.startsWith(path.join(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim(), "matrix"))).toBe(true);
    expect(statSync(path.join(directory, "sweep.json")).mode & 0o777).toBe(0o600);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  test("refuses a second ledger for the same branch and invalid names", () => {
    start("chore/demo", ["a2f0/one"]);
    expect(() => start("chore/demo", ["a2f0/one"])).toThrow("already exists");
    for (const branch of ["bad..name", "-x", "trailing/", "with space"]) expect(() => start(branch, ["a2f0/one"])).toThrow("not a valid branch name");
    expect(() => startSweep(root, "chore/other", ["a2f0/one"], statusOf, { issue: "matrix#4" })).toThrow("owner/repo#number");
  });

  test("leaves nothing behind when a start fails, so a corrected retry succeeds", () => {
    expect(() => startSweep(root, "chore/demo", ["a2f0/one"], statusOf, { topic: "  " })).toThrow("--topic must not be empty");
    expect(() => startSweep(root, "chore/demo", ["a2f0/one"], () => { throw new Error("status failed"); })).toThrow("status failed");
    expect(existsSync(path.join(sweepsDirectory(root), encodeURIComponent("chore/demo")))).toBe(false);
    expect(start("chore/demo", ["a2f0/one"]).counts).toEqual({ pending: 1 });
  });

  test("records a repository named twice once", () => {
    expect(start("chore/demo", ["a2f0/one", "a2f0/two", "A2F0/one"]).sweep.repos).toEqual(["a2f0/one", "a2f0/two"]);
  });

  test("never reads another branch's ledger where the filesystem ignores case", () => {
    start("chore/Fix", ["a2f0/one"]);
    const folded = existsSync(path.join(sweepsDirectory(root), encodeURIComponent("chore/fix")));
    if (folded) {
      expect(() => recordEntry(root, "chore/fix", "one", { status: "merged" })).toThrow("belongs to 'chore/Fix', not 'chore/fix'");
      expect(() => start("chore/fix", ["a2f0/one"])).toThrow("differs by more than case");
    } else {
      expect(() => recordEntry(root, "chore/fix", "one", { status: "merged" })).toThrow("No sweep ledger");
    }
    expect(sweepReport(root, "chore/Fix").repos[0]!.status).toBe("pending");
  });

  test("keeps branches that differ only in separators apart", () => {
    start("chore/a-b", ["a2f0/one"]);
    start("chore-a/b", ["a2f0/two"], 1);
    expect(sweepReport(root, "chore/a-b").sweep.repos).toEqual(["a2f0/one"]);
    expect(sweepReport(root, "chore-a/b").sweep.repos).toEqual(["a2f0/two"]);
  });
});

describe("recordEntry", () => {
  test("merges fields, appends notes and events, and clears a stale reason on a new status", () => {
    start("chore/demo", ["a2f0/one"]);
    recordEntry(root, "chore/demo", "one", parseUpdate({ status: "blocked", reason: "waits for producer release" }, {}), at(1));
    const entry = recordEntry(root, "chore/demo", "A2F0/ONE", parseUpdate(
      { status: "merged", head: "b".repeat(40), pr: "https://github.com/a2f0/one/pull/12", reviewer: "codex", verdict: "clean" },
      { retry: ["enospc:bun install ran out of space", "browser-timing"], note: ["deploy is manual"] },
    ), at(2));
    expect(entry).toMatchObject({ status: "merged", base: HEAD, head: "b".repeat(40), verdict: "CLEAN", reviewer: "codex", notes: ["deploy is manual"], updatedAt: at(2).toISOString() });
    expect(entry).not.toHaveProperty("reason");
    expect(entry.events).toEqual([
      { kind: "retry", cause: "enospc", detail: "bun install ran out of space", at: at(2).toISOString() },
      { kind: "retry", cause: "browser-timing", at: at(2).toISOString() },
    ]);
    expect(recordEntry(root, "chore/demo", "one", { notes: ["second"] }).notes).toEqual(["deploy is manual", "second"]);
  });

  test("rejects unknown repositories, sweeps, and malformed values", () => {
    start("chore/demo", ["a2f0/one"]);
    expect(() => recordEntry(root, "chore/demo", "a2f0/two", { status: "merged" })).toThrow("not part of sweep");
    expect(() => recordEntry(root, "chore/none", "one", { status: "merged" })).toThrow("No sweep ledger");
    expect(() => parseUpdate({ status: "done" }, {})).toThrow("--status must be one of");
    expect(() => parseUpdate({ verdict: "OK" }, {})).toThrow("--verdict must be one of");
    expect(() => parseUpdate({ head: "abc123" }, {})).toThrow("full commit ID");
    expect(() => parseUpdate({ pr: "https://example.com/pull/1" }, {})).toThrow("pull request URL");
    expect(() => parseUpdate({ reason: "  " }, {})).toThrow("must not be empty");
    expect(() => parseEvent("retry", "Out Of Space")).toThrow("kebab-case cause");
    expect(parseEvent("declined", "restore-claude-md: Codex asked again ")).toEqual({ kind: "declined", cause: "restore-claude-md", detail: "Codex asked again" });
  });

  test("keeps every update when processes record the same repository at once", async () => {
    start("chore/demo", ["a2f0/one"]);
    const module = path.join(import.meta.dir, "sweeps.ts");
    const writers = Array.from({ length: 8 }, (_, index) => new Promise<number | null>((resolve, reject) => {
      const script = `import { recordEntry } from ${JSON.stringify(module)}; recordEntry(${JSON.stringify(root)}, "chore/demo", "one", { notes: ["writer ${index}"], events: [{ kind: "retry", cause: "writer-${index}" }] });`;
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("error", reject);
      child.on("exit", resolve);
    }));
    expect(await Promise.all(writers)).toEqual(Array(8).fill(0));
    const entry = sweepReport(root, "chore/demo").repos[0]!;
    expect(entry.notes.toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => `writer ${index}`));
    expect(entry.events.map(event => event.cause).toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => `writer-${index}`));
  }, 30_000);
});

describe("reports", () => {
  test("renders a Markdown ledger that escapes table syntax", () => {
    start("chore/demo", ["a2f0/one", "a2f0/missing"]);
    recordEntry(root, "chore/demo", "one", parseUpdate(
      { status: "merged", pr: "https://github.com/a2f0/one/pull/12", reviewer: "codex", verdict: "MINOR", validation: "check | build\npassed" },
      { retry: ["enospc"] },
    ));
    expect(markdownReport(sweepReport(root, "chore/demo"))).toBe([
      "Sweep `chore/demo`: Demo change",
      "",
      "skipped 1, merged 1",
      "",
      "| Repository | Status | PR | Review | Detail | Friction |",
      "| --- | --- | --- | --- | --- | --- |",
      "| a2f0/one | merged | [a2f0/one#12](https://github.com/a2f0/one/pull/12) | MINOR (codex) | check \\| build passed | retry enospc |",
      "| a2f0/missing | skipped |  |  | checkout missing; run sync |  |",
      "",
    ].join("\n"));
  });

  test("lists sweeps newest first", () => {
    start("chore/old", ["a2f0/one"], 0);
    start("chore/new", ["a2f0/one"], 5);
    expect(listSweeps(root).map(result => result.sweep.branch)).toEqual(["chore/new", "chore/old"]);
  });
});

describe("retro", () => {
  test("surfaces causes that recur across repositories or sweeps", () => {
    start("chore/first", ["a2f0/one", "a2f0/two"], 0);
    recordEntry(root, "chore/first", "one", parseUpdate({ status: "merged", reviewer: "codex", verdict: "CLEAN" }, { retry: ["enospc:install"] }));
    recordEntry(root, "chore/first", "two", parseUpdate({ status: "open", pr: "https://github.com/a2f0/two/pull/3" }, { retry: ["enospc"], fallback: ["reviewer-unavailable"] }));
    start("chore/second", ["a2f0/one"], 5);
    recordEntry(root, "chore/second", "one", parseUpdate({ status: "blocked", reason: "needs dnbm 0.3.0", reviewer: "claude", verdict: "MAJOR" }, { declined: ["restore-claude-md"] }));
    start("chore/third", ["a2f0/one"], 9);
    recordEntry(root, "chore/third", "one", parseUpdate({ status: "merged" }, { declined: ["restore-claude-md"] }));

    const result = retro(root);
    expect(result.sweeps).toEqual(["chore/third", "chore/second", "chore/first"]);
    expect(result.recurring.map(group => [group.kind, group.cause, group.repos, group.sweeps])).toEqual([
      ["declined", "restore-claude-md", ["a2f0/one"], ["chore/second", "chore/third"]],
      ["retry", "enospc", ["a2f0/one", "a2f0/two"], ["chore/first"]],
    ]);
    expect(result.recurring[1]!.details).toEqual(["chore/first a2f0/one: install"]);
    expect(result.isolated.map(group => group.cause)).toEqual(["reviewer-unavailable"]);
    expect(result.reviews).toEqual({ verdicts: { CLEAN: 1, MAJOR: 1 }, reviewers: { codex: 1, claude: 1 } });
    expect(result.unfinished).toEqual([
      { branch: "chore/second", repo: "a2f0/one", status: "blocked", reason: "needs dnbm 0.3.0" },
      { branch: "chore/first", repo: "a2f0/two", status: "open", pr: "https://github.com/a2f0/two/pull/3" },
    ]);

    expect(retro(root, { last: 1 }).recurring).toEqual([]);
    expect(retro(root, { branches: ["chore/first"], minRepos: 3 }).recurring).toEqual([]);
  });

  test("describes why a checkout is not ready", () => {
    expect(notReady(ready("a2f0/one"))).toBeUndefined();
    expect(notReady({ ...ready("a2f0/one"), branch: null })).toBe("detached HEAD");
    expect(notReady({ ...ready("a2f0/one"), ahead: 1 })).toBe("1 unpushed commit");
    expect(notReady({ ...ready("a2f0/one"), behind: 3 })).toBe("3 commits behind origin; run sync");
    expect(notReady({ ...ready("a2f0/one"), error: "origin is a2f0/other, expected a2f0/one" })).toBe("origin is a2f0/other, expected a2f0/one");
  });
});
