import { beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CheckoutStatus, notReady } from "./checkouts";
import { applyUpdate, listSweeps, PHASE, type RepoEntry, STATUSES, type StoredUpdate, sweepsDirectory } from "./sweepLedger";
import { retro } from "./sweepRetro";
import { markdownReport, parseEvent, parseUpdate, recordEntry, startSweep, sweepReport } from "./sweeps";
import { gitIn, gitInit, tempDir } from "./testFixtures";

const HEAD = "a".repeat(40);
let root: string;

function ready(repo: string): CheckoutStatus {
  return {
    repo,
    path: `checkouts/${repo.split("/")[1]}`,
    present: true,
    ready: true,
    branch: "main",
    defaultBranch: "main",
    head: HEAD,
    changes: 0,
    ahead: 0,
    behind: 0,
  };
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
  root = tempDir("matrix-sweeps");
  gitInit(root);
});

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
    expect(directory.startsWith(path.join(gitIn(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "matrix"))).toBe(true);
    expect(statSync(path.join(directory, "sweep.json")).mode & 0o777).toBe(0o600);
    expect(gitIn(root, "status", "--porcelain")).toBe("");
  });

  test("refuses a second ledger for the same branch and invalid names", () => {
    start("chore/demo", ["a2f0/one"]);
    expect(() => start("chore/demo", ["a2f0/one"])).toThrow("already exists");
    for (const branch of ["bad..name", "-x", "trailing/", "with space"]) expect(() => start(branch, ["a2f0/one"])).toThrow("not a valid branch name");
    expect(() => startSweep(root, "chore/other", ["a2f0/one"], statusOf, { issue: "matrix#4" })).toThrow("owner/repo#number");
  });

  test("leaves nothing behind when a start fails, so a corrected retry succeeds", () => {
    expect(() => startSweep(root, "chore/demo", ["a2f0/one"], statusOf, { topic: "  " })).toThrow("--topic must not be empty");
    expect(() =>
      startSweep(root, "chore/demo", ["a2f0/one"], () => {
        throw new Error("status failed");
      }),
    ).toThrow("status failed");
    expect(existsSync(path.join(sweepsDirectory(root), encodeURIComponent("chore/demo")))).toBe(false);
    expect(start("chore/demo", ["a2f0/one"]).counts).toEqual({ pending: 1 });
  });

  test("names a ledger directory that an interrupted start left without sweep.json", () => {
    const directory = path.join(sweepsDirectory(root), encodeURIComponent("chore/demo"));
    mkdirSync(path.join(directory, "repos", "one"), { recursive: true });
    writeFileSync(path.join(directory, "repos", "one", "000001.json"), `${JSON.stringify({ at: at(0).toISOString(), status: "pending" })}\n`);
    const interrupted = `The sweep ledger at ${directory} has no sweep.json because an earlier sweep start was interrupted; remove that directory and run sweep start again.`;
    expect(() => start("chore/demo", ["a2f0/one"])).toThrow(interrupted);
    expect(() => recordEntry(root, "chore/demo", "one", { status: "merged" })).toThrow(interrupted);
    expect(() => sweepReport(root, "chore/demo")).toThrow(interrupted);
    expect(readdirSync(sweepsDirectory(root))).toEqual([encodeURIComponent("chore/demo")]);
    rmSync(directory, { recursive: true });
    expect(start("chore/demo", ["a2f0/one"]).counts).toEqual({ pending: 1 });
  });

  test("builds the ledger aside, so a start killed midway neither blocks nor lists a sweep", () => {
    const staging = path.join(sweepsDirectory(root), ".start-killed");
    mkdirSync(path.join(staging, "repos"), { recursive: true });
    writeFileSync(
      path.join(staging, "sweep.json"),
      `${JSON.stringify({ schemaVersion: 1, branch: "chore/demo", startedAt: at(0).toISOString(), repos: [] })}\n`,
    );
    expect(listSweeps(root)).toEqual([]);
    expect(start("chore/demo", ["a2f0/one"], 1).counts).toEqual({ pending: 1 });
    expect(listSweeps(root).map(result => result.sweep.branch)).toEqual(["chore/demo"]);
  });

  test("lets exactly one of several concurrent starts create the ledger", async () => {
    const module = path.join(import.meta.dir, "sweeps.ts");
    const starters = Array.from(
      { length: 4 },
      (_, index) =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const status = {
            repo: "a2f0/one",
            path: "checkouts/one",
            present: true,
            ready: true,
            branch: "main",
            defaultBranch: "main",
            head: HEAD,
            changes: 0,
            ahead: 0,
            behind: 0,
          };
          const script = `import { startSweep } from ${JSON.stringify(module)}; startSweep(${JSON.stringify(root)}, "chore/demo", ["a2f0/one"], () => (${JSON.stringify(status)}), { topic: "starter ${index}" });`;
          const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", chunk => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", code => resolve({ code, stderr }));
        }),
    );
    const results = await Promise.all(starters);
    expect(results.filter(result => result.code === 0)).toHaveLength(1);
    for (const result of results.filter(result => result.code !== 0)) expect(result.stderr).toContain("A sweep ledger already exists");
    expect(readdirSync(sweepsDirectory(root))).toEqual([encodeURIComponent("chore/demo")]);
    expect(sweepReport(root, "chore/demo").counts).toEqual({ pending: 1 });
  }, 30_000);

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
    const entry = recordEntry(
      root,
      "chore/demo",
      "A2F0/ONE",
      parseUpdate(
        { status: "merged", head: "b".repeat(40), pr: "https://github.com/a2f0/one/pull/12", reviewer: "codex", verdict: "clean" },
        { retry: ["enospc:bun install ran out of space", "browser-timing"], note: ["deploy is manual"] },
      ),
      at(2),
    );
    expect(entry).toMatchObject({
      status: "merged",
      base: HEAD,
      head: "b".repeat(40),
      verdict: "CLEAN",
      reviewer: "codex",
      notes: ["deploy is manual"],
      updatedAt: at(2).toISOString(),
    });
    expect(entry).not.toHaveProperty("reason");
    expect(entry.events).toEqual([
      { kind: "retry", cause: "enospc", detail: "bun install ran out of space", at: at(2).toISOString() },
      { kind: "retry", cause: "browser-timing", at: at(2).toISOString() },
    ]);
    expect(recordEntry(root, "chore/demo", "one", { notes: ["second"] }).notes).toEqual(["deploy is manual", "second"]);
  });

  test("keeps the reason when the same status is recorded again without one", () => {
    start("chore/demo", ["a2f0/one"]);
    recordEntry(root, "chore/demo", "one", parseUpdate({ status: "blocked", reason: "waits for producer release" }, {}), at(1));
    const entry = recordEntry(root, "chore/demo", "one", parseUpdate({ status: "blocked" }, { retry: ["enospc"] }), at(2));
    expect(entry).toMatchObject({ status: "blocked", reason: "waits for producer release" });
    expect(retro(root).unfinished).toEqual([{ branch: "chore/demo", repo: "a2f0/one", status: "blocked", reason: "waits for producer release" }]);
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
    expect(parseEvent("declined", "restore-claude-md: Codex asked again ")).toEqual({
      kind: "declined",
      cause: "restore-claude-md",
      detail: "Codex asked again",
    });
  });

  test("replays updates in the order they were recorded, even within one millisecond", () => {
    start("chore/demo", ["a2f0/one"]);
    for (const status of ["in-progress", "open", "blocked", "merged"] as const) recordEntry(root, "chore/demo", "one", { status }, at(1));
    expect(sweepReport(root, "chore/demo").repos[0]!.status).toBe("merged");
  });

  test("keeps every update when processes record the same repository at once", async () => {
    start("chore/demo", ["a2f0/one"]);
    const module = path.join(import.meta.dir, "sweeps.ts");
    const writers = Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<number | null>((resolve, reject) => {
          const script = `import { recordEntry } from ${JSON.stringify(module)}; recordEntry(${JSON.stringify(root)}, "chore/demo", "one", { notes: ["writer ${index}"], events: [{ kind: "retry", cause: "writer-${index}" }] });`;
          const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit"] });
          child.on("error", reject);
          child.on("exit", resolve);
        }),
    );
    expect(await Promise.all(writers)).toEqual(Array(8).fill(0));
    const entry = sweepReport(root, "chore/demo").repos[0]!;
    expect(entry.notes.toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => `writer ${index}`));
    expect(entry.events.map(event => event.cause).toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => `writer-${index}`));
  }, 30_000);
});

describe("applyUpdate", () => {
  const base: RepoEntry = { repo: "a2f0/one", status: "pending", notes: [], events: [], updatedAt: "" };
  const t = (minute: number) => at(minute).toISOString();
  const replay = (...updates: StoredUpdate[]) => updates.reduce(applyUpdate, base);

  test("allows every status to follow every other, since a later record corrects an earlier one", () => {
    for (const from of STATUSES) for (const to of STATUSES) expect(replay({ at: t(0), status: from }, { at: t(1), status: to }).status).toBe(to);
  });

  test("clears the reason only when the status changes without a new one", () => {
    const blocked = replay({ at: t(0), status: "blocked", reason: "waits" });
    const cases: Array<[StoredUpdate, string | undefined]> = [
      [{ at: t(1), status: "in-progress" }, undefined],
      [{ at: t(1), status: "blocked" }, "waits"],
      [{ at: t(1), status: "failed", reason: "broke" }, "broke"],
      [{ at: t(1), status: "blocked", reason: "other" }, "other"],
      [{ at: t(1), notes: ["n"] }, "waits"],
      [{ at: t(1), reason: "reworded" }, "reworded"],
    ];
    for (const [update, reason] of cases) expect(applyUpdate(blocked, update).reason).toBe(reason);
  });

  test("keeps merge and PR fields when leaving merged, and a reason recorded without a status", () => {
    const entry = replay(
      { at: t(0), status: "merged", pr: "https://github.com/a2f0/one/pull/1", merge: HEAD },
      { at: t(1), status: "in-progress" },
      { at: t(2), reason: "round two" },
    );
    expect(entry).toMatchObject({ status: "in-progress", pr: "https://github.com/a2f0/one/pull/1", merge: HEAD, reason: "round two" });
  });

  test("appends notes and events stamped with their update, and never mutates the entry", () => {
    const first = replay({ at: t(0), notes: ["a"], events: [{ kind: "retry", cause: "enospc" }] });
    const second = applyUpdate(first, { at: t(1), notes: ["b"], events: [{ kind: "manual", cause: "login" }] });
    expect(second.notes).toEqual(["a", "b"]);
    expect(second.events).toEqual([
      { kind: "retry", cause: "enospc", at: t(0) },
      { kind: "manual", cause: "login", at: t(1) },
    ]);
    expect(first.notes).toEqual(["a"]);
    expect(second.updatedAt).toBe(t(1));
  });

  test("keeps the entry's JSON key order: identity, then fields in the order first recorded", () => {
    const entry = replay(
      { at: t(0), status: "blocked", reason: "waits", base: HEAD },
      { at: t(1), status: "merged", pr: "https://github.com/a2f0/one/pull/1", verdict: "CLEAN" },
      { at: t(2), reason: "late" },
    );
    expect(Object.keys(entry)).toEqual(["repo", "status", "notes", "events", "updatedAt", "base", "pr", "verdict", "reason"]);
  });

  test("classifies every status into one phase that report and retro share", () => {
    expect(STATUSES.map(status => [status, PHASE[status]])).toEqual([
      ["pending", "remaining"],
      ["skipped", "done"],
      ["unchanged", "done"],
      ["in-progress", "remaining"],
      ["open", "waiting"],
      ["merged", "done"],
      ["blocked", "remaining"],
      ["failed", "done"],
    ]);
  });
});

describe("reports", () => {
  test("renders a Markdown ledger that escapes table syntax", () => {
    start("chore/demo", ["a2f0/one", "a2f0/missing"]);
    recordEntry(
      root,
      "chore/demo",
      "one",
      parseUpdate(
        { status: "merged", pr: "https://github.com/a2f0/one/pull/12", reviewer: "codex", verdict: "MINOR", validation: "check | build\npassed" },
        { retry: ["enospc"] },
      ),
    );
    expect(markdownReport(sweepReport(root, "chore/demo"))).toBe(
      [
        "Sweep `chore/demo`: Demo change",
        "",
        "skipped 1, merged 1",
        "",
        "| Repository | Status | PR | Review | Detail | Friction |",
        "| --- | --- | --- | --- | --- | --- |",
        "| a2f0/one | merged | [a2f0/one#12](https://github.com/a2f0/one/pull/12) | MINOR (codex) | check \\| build passed | retry enospc |",
        "| a2f0/missing | skipped |  |  | checkout missing; run sync |  |",
        "",
      ].join("\n"),
    );
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
    recordEntry(
      root,
      "chore/first",
      "two",
      parseUpdate({ status: "open", pr: "https://github.com/a2f0/two/pull/3" }, { retry: ["enospc"], fallback: ["reviewer-unavailable"] }),
    );
    start("chore/second", ["a2f0/one"], 5);
    recordEntry(
      root,
      "chore/second",
      "one",
      parseUpdate({ status: "blocked", reason: "needs dnbm 0.3.0", reviewer: "claude", verdict: "MAJOR" }, { declined: ["restore-claude-md"] }),
    );
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

test("refuses ledger files without the fields that locate and order records", () => {
  start("chore/demo", ["a2f0/one"]);
  const directory = path.join(sweepsDirectory(root), encodeURIComponent("chore/demo"));
  writeFileSync(path.join(directory, "repos", "one", "000002.json"), '{"status": "open"}\n');
  expect(() => sweepReport(root, "chore/demo")).toThrow("000002.json: it is not a sweep ledger record.");
  for (const [field, value] of [
    ["status", "done"],
    ["verdict", "OK"],
    ["status", 1],
  ] as const) {
    writeFileSync(path.join(directory, "repos", "one", "000002.json"), `${JSON.stringify({ at: at(1).toISOString(), [field]: value })}\n`);
    expect(() => sweepReport(root, "chore/demo")).toThrow("000002.json: it is not a sweep ledger record.");
  }
  writeFileSync(path.join(directory, "sweep.json"), "[]\n");
  expect(() => sweepReport(root, "chore/demo")).toThrow("sweep.json: it is not a sweep ledger record.");
});
