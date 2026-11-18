import { expect, test } from "bun:test";
import { isAgentToolTeardown, teardownAll } from "./teardown";

test("reports a failed inspection's message, whatever was thrown", () => {
  const thrown: unknown[] = [new Error("agent-tool teardown could not run: ENOENT"), "spawn failed"];
  const result = teardownAll(
    [
      { repo: "a2f0/one", path: "/one" },
      { repo: "a2f0/two", path: "/two" },
    ],
    () => {
      throw thrown.shift();
    },
    false,
  );
  expect(result.ok).toBe(false);
  expect(result.repos.map(item => item.problems)).toEqual([["agent-tool teardown could not run: ENOENT"], ["spawn failed"]]);
});

test("lists the session's background shells once, without failing teardown", () => {
  const base = { ok: true, leftover: [], kept: [], stopped: [], untracked: [], worktrees: [], unavailable: [], skipped: [] };
  const shells = [
    { pid: 42, ageSeconds: 7_530, shell: "zsh", chars: 900 },
    { pid: 7, ageSeconds: 95, shell: "bash", chars: 40 },
  ];
  const reports = [
    { ...base, sessionShells: shells, notes: [] },
    { ...base, sessionShells: [...shells].reverse(), notes: [] },
    // An agent-tool older than 0.1.65 reports neither field.
    base,
  ];
  const result = teardownAll(
    ["one", "two", "three"].map(name => ({ repo: `a2f0/${name}`, path: `/${name}` })),
    () => reports.shift()!,
    false,
  );
  expect(result.ok).toBe(true);
  expect(result.sessionShells).toEqual(["pid 7 bash, running 1m", "pid 42 zsh, running 2h 5m"]);
  expect(result.notes).toEqual([]);
  const missing = teardownAll([{ repo: "a2f0/one", path: "/one" }], () => ({ ...base, sessionShells: [], notes: ["no agent harness found"] }), false);
  expect(missing.notes).toEqual(["no agent harness found"]);
});

test("accepts only a report with the fields matrix reads", () => {
  const report = { ok: true, leftover: [], kept: [], stopped: [], untracked: [], worktrees: [], unavailable: [], skipped: [] };
  expect(isAgentToolTeardown(report)).toBe(true);
  for (const value of [null, [], "ok", { ...report, ok: "yes" }, { ...report, leftover: undefined }]) expect(isAgentToolTeardown(value)).toBe(false);
});
