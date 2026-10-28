import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AuditContext, audit, MINIMUM_AGENT_TOOL, RULES, selectRules } from "./audit";
import type { CheckoutStatus } from "./checkouts";

let root: string;
const context: AuditContext = { latest: () => "0.1.23" };

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
    "package.json": JSON.stringify({ name, scripts: { "agent:run": "agent-tool run", "agent:logs": "agent-tool logs" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
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
    expect(result.checkouts[0]).toMatchObject({ repo, failed: [], skipped: [{ rule: "brand-images", detail: "no assets/brand" }] });
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

  test("compares the pin with the registry only for remote rules", () => {
    const repo = checkout("current");
    expect(failures(repo, [], true)["agent-tool-latest"]).toBe(`pins ${MINIMUM_AGENT_TOOL}; latest is 0.1.23`);
    expect(failures(repo, ["agent-tool-latest"])["agent-tool-latest"]).toBe(`pins ${MINIMUM_AGENT_TOOL}; latest is 0.1.23`);
    expect(() => audit(root, [repo], selectRules([], true), statusOf, { latest: () => { throw new Error("offline"); } })).toThrow("offline");
  });

  test("checks output capture scripts and guidance, including AGENTS.md without sections", () => {
    expect(failures(checkout("capture", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "agent-tool run" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
      "AGENTS.md": "# Guidance\n\n## Validation\n\nRun `bun run agent:run`.\n",
    }))["output-capture"]).toBe("no agent:logs script; AGENTS.md has no Output capture section; AGENTS.md does not mention agent:logs");
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
    expect(failures(checkout("agentic", { "README.md": `${README}\n## Output capture\n\nUse agent:run.\n` }))["readme-agent-free"]).toBe("README.md mentions Output capture, agent:run");
  });

  test("checks brand sources and committed rasters", () => {
    expect(failures(checkout("brand", { "assets/brand/logo.svg": "<svg/>", "assets/brand/icon.png": "png", "agent-tool.json": "{}" }))["brand-images"])
      .toBe("agent-tool.json declares no images; committed rasters: assets/brand/icon.png");
    expect(failures(checkout("brand-ok", { "assets/brand/logo.svg": "<svg/>", "agent-tool.json": JSON.stringify({ images: { targets: {} } }) }))).toEqual({});
  });

  test("finds superseded commands in Markdown, every spelling, outside managed skills", () => {
    const repo = checkout("stale", {
      "AGENTS.md": `${GUIDANCE}\nReply with \`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies\`.\n`,
      "docs/shipping.md": "Run `git push -u origin HEAD`, then `gh pr checks --watch`.\nOr `git push origin --delete feat/x`.\n",
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
