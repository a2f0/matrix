import { expect, test } from "bun:test";
import type { Audit } from "./audit";
import type { CheckoutStatus } from "./checkouts";
import { assessHealth, markdownHealth } from "./health";
import type { Retro } from "./sweeps";

function status(repo: string, overrides: Partial<CheckoutStatus> = {}): CheckoutStatus {
  return { repo, path: `checkouts/${repo.split("/")[1]}`, present: true, ready: true, branch: "main", defaultBranch: "main", head: "a".repeat(40), changes: 0, ahead: 0, behind: 0, ...overrides };
}

const cleanAudit: Audit = { ok: true, rules: [{ id: "agents-md", summary: "", source: "" }], failures: {}, checkouts: [] };
const quietRetro: Retro = { sweeps: [], recurring: [], isolated: [], reviews: { verdicts: {}, reviewers: {} }, unfinished: [] };

test("reports nothing to do for a healthy matrix", () => {
  const health = assessHealth({ statuses: [status("a2f0/one")], unmanaged: [], audit: cleanAudit, retro: quietRetro });
  expect(health).toMatchObject({ ok: true, remote: false, suggestions: [], checkouts: { total: 1, ready: 1 } });
  expect(markdownHealth(health, new Date("2026-10-28T12:00:00Z"))).toBe([
    "# Matrix health",
    "",
    "Checked 2026-10-28T12:00:00.000Z from local checkouts.",
    "",
    "- Checkouts: 1 of 1 ready; no stale installs; no unmanaged entries.",
    "- Audit (1 rule): every checkout passes.",
    "- Discovery: not checked; run with --remote.",
    "- Sweeps: 0 ledgers read; no recurring friction; nothing unfinished.",
    "",
    "## Next steps",
    "",
    "Nothing to do.",
    "",
  ].join("\n"));
});

test("orders suggestions from checkout state to standards to friction", () => {
  const health = assessHealth({
    statuses: [
      status("a2f0/one", { ready: false, branch: "feat/x" }),
      status("a2f0/two", { agentTool: { pinned: "0.1.21", installed: "0.1.19", current: false } }),
    ],
    unmanaged: ["checkouts/old"],
    audit: { ...cleanAudit, ok: false, failures: { "agent-tool-latest": ["a2f0/one", "a2f0/two"] } },
    retro: {
      ...quietRetro,
      sweeps: ["docs/links"],
      recurring: [{ kind: "retry", cause: "enospc", occurrences: 3, repos: ["a2f0/one", "a2f0/two", "a2f0/three"], sweeps: ["docs/links"], details: [] }],
      unfinished: [{ branch: "docs/links", repo: "a2f0/two", status: "open", pr: "https://github.com/a2f0/two/pull/3" }],
    },
    discovery: { added: ["a2f0/new"], notDiscovered: [] },
  });
  expect(health.ok).toBe(false);
  expect(health.suggestions).toEqual([
    "Inspect a2f0/one before the next sweep: on branch feat/x.",
    "Reinstall dependencies in a2f0/two; their node_modules hold a different agent-tool than they pin.",
    "Onboard a2f0/new: `bun run discover --apply`, then the onboarding steps in AGENTS.md.",
    "Fix `agent-tool-latest` in 2 checkouts (a2f0/one, a2f0/two); `bun run audit --rule agent-tool-latest` has the details.",
    "Resolve recurring retry `enospc` (3 repositories, 1 sweep); see docs/sweeps.md#retro.",
    "Finish a2f0/two in sweep `docs/links`: open (https://github.com/a2f0/two/pull/3).",
    "Remove or manage checkouts/old; matrix leaves unmanaged entries alone.",
  ]);
  const markdown = markdownHealth(health);
  expect(markdown).toContain("- Discovery: 1 new repository, 0 no longer found.");
  expect(markdown).toContain("- Sweeps: 1 ledger read; retry `enospc` in 3; 1 unfinished.");
  expect(markdown).toContain("4. Fix `agent-tool-latest`");
});
