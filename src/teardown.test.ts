import { expect, test } from "bun:test";
import { type AgentToolTeardown, isAgentToolTeardown, teardownAll } from "./teardown";

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
  // The latest successful inspection is the current picture: pid 42 exited between the first and
  // second, and the third inspection failing does not erase what the second saw.
  const reports: Array<() => AgentToolTeardown> = [
    () => ({ ...base, sessionShells: shells, notes: [] }),
    () => ({ ...base, sessionShells: [shells[1]!], notes: [] }),
    () => {
      throw new Error("agent-tool teardown could not run: ENOENT");
    },
  ];
  const targets = ["one", "two", "three"].map(name => ({ repo: `a2f0/${name}`, path: `/${name}` }));
  const result = teardownAll(targets, () => reports.shift()!(), false);
  expect(result.ok).toBe(false);
  expect(result.repos.map(item => item.ok)).toEqual([true, true, false]);
  expect(result.sessionShells).toEqual(["pid 7 bash, running 1m"]);
  expect(result.notes).toEqual([]);
  const ordered = teardownAll([targets[0]!], () => ({ ...base, sessionShells: [...shells].reverse(), notes: [] }), false);
  expect(ordered.sessionShells).toEqual(["pid 7 bash, running 1m", "pid 42 zsh, running 2h 5m"]);
  // An agent-tool older than 0.1.65 reports neither field, and the harness may be unknown.
  expect(teardownAll([targets[0]!], () => base, false)).toMatchObject({ ok: true, sessionShells: [], notes: [] });
  const missing = teardownAll([targets[0]!], () => ({ ...base, sessionShells: [], notes: ["no agent harness found"] }), false);
  expect(missing.notes).toEqual(["no agent harness found"]);
});

test("accepts only a report with the fields matrix reads", () => {
  const report = { ok: true, leftover: [], kept: [], stopped: [], untracked: [], worktrees: [], unavailable: [], skipped: [] };
  expect(isAgentToolTeardown(report)).toBe(true);
  for (const value of [null, [], "ok", { ...report, ok: "yes" }, { ...report, leftover: undefined }]) expect(isAgentToolTeardown(value)).toBe(false);
  // sessionShells and notes are optional, but readable when present.
  const shell = { pid: 7, ageSeconds: 95, shell: "bash", chars: 40 };
  expect(isAgentToolTeardown({ ...report, sessionShells: [shell], notes: ["a note"] })).toBe(true);
  for (const malformed of [
    { sessionShells: [null] },
    { sessionShells: "zsh" },
    { sessionShells: [{ ...shell, pid: "7" }] },
    { sessionShells: [{ ...shell, ageSeconds: Number.NaN }] },
    { sessionShells: [{ pid: 7, ageSeconds: 95 }] },
    { notes: [1] },
    { notes: "a note" },
  ])
    expect(isAgentToolTeardown({ ...report, ...malformed })).toBe(false);
});
