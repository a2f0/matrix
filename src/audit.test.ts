import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_TOOL_GRACE_DAYS, type AuditContext, audit, MINIMUM_AGENT_TOOL, RULES, selectRules } from "./audit";
import type { CheckoutStatus } from "./checkouts";

let root: string;
const RELEASES = { "0.1.9": "2026-10-01T00:00:00.000Z", [MINIMUM_AGENT_TOOL]: "2026-10-10T00:00:00.000Z", "0.1.22": "2026-10-20T00:00:00.000Z", "0.1.23": "2026-10-27T00:00:00.000Z" };
const context: AuditContext = { releases: () => RELEASES, now: new Date("2026-10-28T12:00:00.000Z") };

const GUIDANCE = "# Repository guidance\n\n## Output capture\n\nRun `bun run agent:run` and read `bun run agent:logs <log>`.\n";
const README = "# demo\n\nA demo project.\n\n## Quick start\n\n```sh\nbun install\n```\n";

/** A checkout that meets every standard, with overrides; a null value deletes the file. */
function checkout(name: string, files: Record<string, string | null> = {}): string {
  const directory = path.join(root, "checkouts", name);
  mkdirSync(directory, { recursive: true });
  const all: Record<string, string | null> = {
    "AGENTS.md": GUIDANCE,
    "README.md": README,
    ".gitignore": "node_modules/\n.DS_Store\n",
    "package.json": JSON.stringify({ name, scripts: { "agent:run": "agent-tool run", "agent:logs": "agent-tool logs", "agents:check": "agent-tool skills check && agent-tool permissions check" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
    ".agent-tool-permissions.json": JSON.stringify({ schemaVersion: 1 }),
    ".claude/settings.json": JSON.stringify({ permissions: { allow: [], ask: [] } }),
    ".codex/rules/agent-tool.rules": "prefix_rule(pattern=[\"agent-tool\", \"doctor\"], decision=\"allow\")\n",
    "agent-tool.json": JSON.stringify({ schemaVersion: 1 }),
    ".agent-tool-skills.json": JSON.stringify({ schemaVersion: 1, files: { ".agents/skills/ship-pr/SKILL.md": "x" } }),
    ".agents/skills/ship-pr/SKILL.md": "Reply via POST /repos/o/r/pulls/1/comments/2/replies.\n",
    ...files,
  };
  execFileSync("git", ["init", "-q"], { cwd: directory });
  for (const [file, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: directory });
  return `a2f0/${name}`;
}

function statusOf(repo: string): CheckoutStatus {
  const name = repo.split("/")[1]!;
  return name === "missing"
    ? { repo, path: `checkouts/${name}`, present: false, ready: false }
    : { repo, path: `checkouts/${name}`, present: true, ready: true, branch: "main", defaultBranch: "main", head: "a".repeat(40), changes: 0, ahead: 0, behind: 0 };
}

function failures(repo: string, ids: string[] = [], remote = false) {
  const result = audit(root, [repo], selectRules(ids, remote), statusOf, context);
  return Object.fromEntries(result.checkouts[0]!.failed.map(({ rule, detail }) => [rule, detail]));
}

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "matrix-audit-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("audit", () => {
  test("passes a conforming checkout and ignores superseded text in managed skills", () => {
    const repo = checkout("good");
    const result = audit(root, [repo, "a2f0/missing"], selectRules([], false), statusOf, context);
    expect(result.checkouts[0]).toMatchObject({ repo, failed: [], skipped: [
      { rule: "brand-images", detail: "no assets/brand" },
      { rule: "import-cycle-guard", detail: "no TypeScript sources or Python package" },
    ] });
    expect(result.checkouts[1]).toMatchObject({ repo: "a2f0/missing", error: "checkout missing; run sync" });
    expect(result.ok).toBe(false);
    expect(result.rules.map(rule => rule.id)).not.toContain("agent-tool-latest");
  });

  test("reports guidance and repository hygiene failures", () => {
    const repo = checkout("bad", {
      "AGENTS.md": null,
      "CLAUDE.md": "@AGENTS.md\n",
      "packages/web/CLAUDE.md": "notes\n",
      ".gitignore": "/.DS_Store\n",
    });
    expect(failures(repo)).toMatchObject({
      "agents-md": "no tracked AGENTS.md at the root",
      "no-claude-md": "tracked CLAUDE.md, packages/web/CLAUDE.md",
      "ds-store-ignored": "root .gitignore does not list .DS_Store",
      "output-capture": "no AGENTS.md for the Output capture section",
    });
  });

  test("reads the working tree, so an unstaged deletion fails", () => {
    const repo = checkout("deleted");
    rmSync(path.join(root, "checkouts", "deleted", "AGENTS.md"));
    expect(failures(repo)).toMatchObject({
      "agents-md": "AGENTS.md is tracked but missing from the working tree",
      "output-capture": "no AGENTS.md for the Output capture section",
    });
  });

  test("checks the agent-tool pin, its minimum, and the producer exemption", () => {
    expect(failures(checkout("range", { "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": "^0.1.21" } }), "agent-tool.json": null }))["agent-tool-pin"])
      .toBe("pin '^0.1.21' is not an exact version; no agent-tool.json");
    expect(failures(checkout("old", { "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": "0.1.9" } }) }))["agent-tool-pin"])
      .toBe(`pins 0.1.9, older than ${MINIMUM_AGENT_TOOL}`);
    const producer = checkout("agent-tool", { "package.json": JSON.stringify({ name: "@a2f0/agent-tool", scripts: { "agent:run": "x", "agent:logs": "y" } }), ".agent-tool-skills.json": null });
    expect(audit(root, [producer], selectRules(["agent-tool-pin", "agent-tool-latest"], false), statusOf, context).checkouts[0]!.skipped.map(entry => entry.rule))
      .toEqual(["agent-tool-pin", "agent-tool-latest"]);
  });

  test("checks generated harness permissions and a CI check for them", () => {
    const missing = checkout("unprotected", { ".codex/rules/agent-tool.rules": null, "package.json": JSON.stringify({ scripts: { "agents:check": "agent-tool skills check" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }) });
    expect(failures(missing, ["harness-permissions"])["harness-permissions"])
      .toBe("no .codex/rules/agent-tool.rules; run agent-tool permissions install --apply; neither the agents:check script nor a workflow runs agent-tool permissions check");
    const workflow = checkout("workflow", { "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }), ".github/workflows/ci.yml": "steps:\n  - run: bun run agent-tool permissions check\n" });
    expect(failures(workflow, ["harness-permissions"])).toEqual({});
  });

  test("compares the pin with the registry only for remote rules", () => {
    const repo = checkout("current");
    const expected = `pins ${MINIMUM_AGENT_TOOL}; latest is 0.1.23; 0.1.22 has been out 8 days`;
    expect(failures(repo, [], true)["agent-tool-latest"]).toBe(expected);
    expect(failures(repo, ["agent-tool-latest"])["agent-tool-latest"]).toBe(expected);
    expect(() => audit(root, [repo], selectRules([], true), statusOf, { releases: () => { throw new Error("offline"); } })).toThrow("offline");
  });

  test(`lets the agent-tool pin trail newer releases for ${AGENT_TOOL_GRACE_DAYS} days`, () => {
    const latest = checkout("latest", { "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.23" } }) });
    const trailing = checkout("trailing", { "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.22" } }) });
    const result = audit(root, [latest, trailing], selectRules(["agent-tool-latest"], true), statusOf, context);
    expect(result.ok).toBe(true);
    expect(result.checkouts[0]).toMatchObject({ failed: [], skipped: [] });
    expect(result.checkouts[1]!.skipped).toEqual([{ rule: "agent-tool-latest", detail: `pins 0.1.22; latest is 0.1.23; 0.1.23 has been out 1 day, inside the ${AGENT_TOOL_GRACE_DAYS}-day grace` }]);
    // The age that counts is the oldest release the pin lacks, so frequent releases cannot keep a pin current forever.
    const later = audit(root, [trailing], selectRules(["agent-tool-latest"], true), statusOf, { ...context, now: new Date("2026-11-03T00:00:00.000Z") });
    expect(later.checkouts[0]!.failed).toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.22; latest is 0.1.23; 0.1.23 has been out 7 days" }]);
    // A fresh patch on an older line does not hide a newer release that has been out longer.
    const backport = checkout("backport", { "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.20" } }) });
    const backported = audit(root, [backport], selectRules(["agent-tool-latest"], true), statusOf, { releases: () => ({ "0.1.20": "2026-10-01T00:00:00.000Z", "0.1.20-1": "x", "0.1.21": "2026-10-27T00:00:00.000Z", "0.2.0": "2026-10-10T00:00:00.000Z" }), now: context.now });
    expect(backported.checkouts[0]!.failed).toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.20; latest is 0.2.0; 0.2.0 has been out 18 days" }]);
    const typo = checkout("typo", { "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.230" } }) });
    expect(audit(root, [typo], selectRules(["agent-tool-latest"], true), statusOf, context).checkouts[0]!.failed)
      .toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.230, which the registry has not published" }]);
    const undated = audit(root, [trailing], selectRules(["agent-tool-latest"], true), statusOf, { releases: () => ({ "0.1.22": "2026-10-01T00:00:00.000Z", "0.1.23": "soon" }) });
    expect(undated.checkouts[0]!.failed).toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.22; latest is 0.1.23; the registry gives no release time for 0.1.23" }]);
  });

  test("checks output capture scripts and guidance, including AGENTS.md without sections", () => {
    expect(failures(checkout("capture", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "agent-tool run" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
      "AGENTS.md": "# Guidance\n\n## Validation\n\nRun `bun run agent:run`.\n",
    }))["output-capture"]).toBe("no agent:logs script; AGENTS.md has no Output capture section");
    expect(failures(checkout("empty-section", {
      "AGENTS.md": "# Guidance\n\n## Output capture\n\nTBD.\n\n## Validation\n\nRun `bun run agent:run` and `bun run agent:logs`.\n",
    }))["output-capture"]).toBe("Output capture guidance does not mention agent:run; Output capture guidance does not mention agent:logs");
    expect(failures(checkout("subsection", {
      "AGENTS.md": "# Guidance\n\n## Output capture\n\nUse `agent:run`.\n\n### Logs\n\nRead with `agent:logs`.\n",
    }))).toEqual({});
    expect(failures(checkout("paragraph", { "AGENTS.md": "# Guidance\n\nRun `bun run agent:run` and `bun run agent:logs <log>`.\n" }))).toEqual({});
  });

  test("checks README titles, quick starts outside code fences, and agent instructions", () => {
    expect(failures(checkout("linked", { "README.md": "# [demo](https://demo.example)\n\n## Quick start\n" }))["readme-title"]).toBe("H1 '# [demo](https://demo.example)' contains a link");
    expect(failures(checkout("link-line", { "README.md": "# demo\n<https://demo.example>\n\n## Quick start\n" }))["readme-title"]).toBe("a standalone link line follows the H1: '<https://demo.example>'");
    expect(failures(checkout("no-start", { "README.md": "# demo\n\n```md\n## Quick start\n```\n" }))["readme-quick-start"]).toBe("README.md has no Quick start section");
    expect(failures(checkout("nested", { "README.md": "# demo\n\n````md\n```sh\nbun install\n```\n## Quick start\n````\n" }))["readme-quick-start"]).toBe("README.md has no Quick start section");
    expect(failures(checkout("tilde", { "README.md": "# demo\n\n~~~\n```\n~~~\n\n## Quick start\n" }))).toEqual({});
    expect(failures(checkout("closed", { "README.md": "# demo #\n\n## Quick start ##\n", "AGENTS.md": "# Guidance\n\n## Output capture ##\n\n`agent:run`, `agent:logs`\n" }))).toEqual({});
    expect(failures(checkout("reference", { "README.md": "# [demo][site]\n\n## Quick start\n\n[site]: https://demo.example\n" }))["readme-title"]).toBe("H1 '# [demo][site]' contains a link");
    expect(failures(checkout("shortcut", { "README.md": "# [demo]\n\n## Quick start\n\n[demo]: https://demo.example\n" }))["readme-title"]).toBe("H1 '# [demo]' contains a link");
    expect(failures(checkout("brackets", { "README.md": "# [demo]\n[beta]\n\n## Quick start\n" }))).toEqual({});
    expect(failures(checkout("setext", { "README.md": "# demo\n\nQuick start\n-----------\n\n```sh\nbun install\n```\n" }))).toEqual({});
    expect(failures(checkout("rule", { "README.md": "# demo\n\nOne\nparagraph\nQuick start\n---\n" }))["readme-quick-start"]).toBe("README.md has no Quick start section");
    expect(failures(checkout("agentic", { "README.md": `${README}\n## Output capture\n\nUse agent:run.\n` }))["readme-agent-free"]).toBe("README.md mentions Output capture, agent:run");
  });

  test("checks brand sources and committed rasters", () => {
    expect(failures(checkout("brand", { "assets/brand/logo.svg": "<svg/>", "assets/brand/icon.png": "png", "agent-tool.json": "{}" }))["brand-images"])
      .toBe("agent-tool.json declares no images; committed rasters: assets/brand/icon.png");
    expect(failures(checkout("brand-ok", { "assets/brand/logo.svg": "<svg/>", "agent-tool.json": JSON.stringify({ images: { targets: {} } }) }))).toEqual({});
  });

  test("requires an import-cycle guard that counts type-only imports wherever TypeScript or a Python package exists", () => {
    const guard = (name: string, files: Record<string, string>) => failures(checkout(name, { "src/a.ts": "export const a = 1;\n", ...files }), ["import-cycle-guard"])["import-cycle-guard"];
    const missing = "no Biome noImportCycles with ignoreTypes: false, dependency-cruiser no-circular rule, or module-graph test";
    expect(guard("unguarded", {})).toBe(missing);
    expect(guard("biome-default", { "biome.json": '{ "linter": { "rules": { "suspicious": { "noImportCycles": "error" } } } }' })).toBe(missing);
    expect(guard("biome", { "packages/web/biome.jsonc": '{ "suspicious": { "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } } } }' })).toBeUndefined();
    expect(guard("cruiser", { "dependency-cruiser.config.ts": 'export default { forbidden: [{ name: "no-circular", severity: "error", from: {}, to: { circular: true } }], options: { tsPreCompilationDeps: "specify" } };' })).toBeUndefined();
    expect(guard("cruiser-policy", { "scripts/checks/architecturePolicy.ts": 'import type { IForbiddenRuleType } from "dependency-cruiser";\nexport const rules = [{ name: "no-circular", severity: "error", to: {\n  circular: true,\n} }];\nexport const options = { parser: "swc" };' })).toBeUndefined();
    expect(guard("cruiser-multiline", { ".dependency-cruiser.cjs": 'require("dependency-cruiser");\nmodule.exports = { forbidden: [{\n  name: "no-circular",\n  severity: "error",\n  to: { circular:\n    true },\n}], options: { tsPreCompilationDeps: true } };' })).toBeUndefined();
    // Disabled rules, test fixtures, and unrelated data are not guards.
    expect(guard("biome-off", { "biome.json": '{ "suspicious": { "noImportCycles": { "level": "off", "options": { "ignoreTypes": false } } } }' })).toBe(missing);
    expect(guard("cruiser-fixture", { "tests/fixtures/depcruise.ts": 'import "dependency-cruiser";\nconst rule = { name: "no-circular", severity: "error", to: { circular: true } };\nconst options = { tsPreCompilationDeps: true };' })).toBe(missing);
    expect(guard("cruiser-test", { "src/policy.test.ts": 'import "dependency-cruiser";\nconst rule = { name: "no-circular", severity: "error", to: { circular: true } };\nconst options = { tsPreCompilationDeps: true };' })).toBe(missing);
    expect(guard("circular-data", { "data/graph.json": '{ "name": "no-circular", "circular": true }' })).toBe(missing);
    expect(guard("cruiser-json", { ".dependency-cruiser.json": '{ "forbidden": [{ "name": "no-circular", "severity": "error", "to": { "circular": true } }], "options": { "tsPreCompilationDeps": true } }' })).toBeUndefined();
    // A rule that skips type-only imports, or only warns, does not gate a merge.
    expect(guard("cruiser-untyped", { "dependency-cruiser.config.ts": 'export default { forbidden: [{ name: "no-circular", severity: "error", to: { circular: true } }] };' })).toBe(missing);
    expect(guard("cruiser-ignored", { "dependency-cruiser.config.ts": 'export default { forbidden: [{ name: "no-circular", severity: "ignore", to: { circular: true } }], options: { tsPreCompilationDeps: true } };' })).toBe(missing);
    expect(guard("cruiser-default", { "dependency-cruiser.config.ts": 'export default { forbidden: [{ name: "no-circular", to: { circular: true } }], options: { tsPreCompilationDeps: true } };' })).toBe(missing);
    expect(guard("graph-test", { "tests/module-graph.test.ts": "test('acyclic', () => {});\n" })).toBeUndefined();
    expect(failures(checkout("python", { "plugin/__init__.py": "", "tests/test_module_graph.py": "" }), ["import-cycle-guard"])).toEqual({});
    expect(failures(checkout("python-bare", { "plugin/__init__.py": "" }), ["import-cycle-guard"])["import-cycle-guard"]).toBe(missing);
    // Declarations and managed skills are not sources.
    const skipped = audit(root, [checkout("types-only", { "types/env.d.ts": "declare const x: 1;\n" })], selectRules(["import-cycle-guard"], false), statusOf, context);
    expect(skipped.checkouts[0]!.skipped).toEqual([{ rule: "import-cycle-guard", detail: "no TypeScript sources or Python package" }]);
  });

  test("finds superseded commands in Markdown, every spelling, outside managed skills", () => {
    const repo = checkout("stale", {
      "AGENTS.md": `${GUIDANCE}\nReply with \`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies\`.\n`,
      "docs/shipping.md": "Run `git push -u origin HEAD`, then `gh pr checks 12 --watch`.\nOr `git push origin --delete feat/x`.\n",
      "docs/cleanup.md": "Delete atomically: `git push --force-with-lease=refs/heads/x:abc --delete origin x`.\n",
      "scripts/ship.sh": "gh pr checks --watch\n",
    });
    expect(failures(repo)["superseded-guidance"]).toBe([
      "review-reply-endpoint at AGENTS.md:7 (use agent-tool pr threads reply)",
      "pr-checks-watch at docs/shipping.md:1 (use agent-tool pr checks --wait)",
      "push-head-upstream at docs/shipping.md:1 (use agent-tool branch push <reviewed-head> --remote origin)",
      "push-delete at docs/shipping.md:2 (use agent-tool repo cleanup)",
    ].join("; "));
  });

  test("rejects unknown rules", () => {
    expect(() => selectRules(["nope"], false)).toThrow("Unknown audit rule 'nope'");
    expect(new Set(RULES.map(rule => rule.id)).size).toBe(RULES.length);
  });
});
