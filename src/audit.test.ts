import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { AGENT_TOOL_GRACE_DAYS, AGENTS_MD_MAX_CHARS, type AuditContext, audit, MINIMUM_AGENT_TOOL, RULES, selectRules } from "./audit";
import type { CheckoutStatus } from "./checkouts";
import type { PushGateResult } from "./pushGates";
import { checkoutFixture, GUIDANCE, gitIn, README, tempDir } from "./testFixtures";

let root: string;
const RELEASES = {
  "0.1.9": "2026-10-01T00:00:00.000Z",
  [MINIMUM_AGENT_TOOL]: "2026-10-10T00:00:00.000Z",
  "0.1.22": "2026-10-20T00:00:00.000Z",
  "0.1.23": "2026-10-27T00:00:00.000Z",
};
const context: AuditContext = {
  releases: () => RELEASES,
  now: new Date("2026-10-28T12:00:00.000Z"),
  pushGate: () => ({ status: "none", detail: "no pre-push hook" }),
  strictFreshness: () => [],
};

/** A checkout that meets every standard, with overrides; a null value deletes the file. */
function checkout(name: string, files: Record<string, string | null> = {}): string {
  checkoutFixture(path.join(root, "checkouts", name), MINIMUM_AGENT_TOOL, files);
  return `a2f0/${name}`;
}

function statusOf(repo: string): CheckoutStatus {
  const name = repo.split("/")[1]!;
  return name === "missing"
    ? { repo, path: `checkouts/${name}`, present: false, ready: false }
    : {
        repo,
        path: `checkouts/${name}`,
        present: true,
        ready: true,
        branch: "main",
        defaultBranch: "main",
        head: "a".repeat(40),
        changes: 0,
        ahead: 0,
        behind: 0,
      };
}

function failures(repo: string, ids: string[] = [], remote = false) {
  const result = audit(root, [repo], selectRules(ids, remote), statusOf, context);
  return Object.fromEntries(result.checkouts[0]!.failed.map(({ rule, detail }) => [rule, detail]));
}

beforeEach(() => {
  root = tempDir("matrix-audit");
});

describe("audit", () => {
  test("passes a conforming checkout and ignores superseded text in managed skills", () => {
    const repo = checkout("good");
    const result = audit(root, [repo, "a2f0/missing"], selectRules([], false), statusOf, context);
    expect(result.checkouts[0]).toMatchObject({
      repo,
      failed: [],
      skipped: [
        { rule: "brand-images", detail: "no assets/brand" },
        { rule: "screenshots-store", detail: "captures no screenshots" },
        { rule: "screenshots-gallery", detail: "no website that shows captured screenshots" },
        { rule: "import-cycle-guard", detail: "no TypeScript sources or Python package" },
        { rule: "mise-lock", detail: "declares no mise tools" },
        { rule: "push-gate", detail: "no pre-push hook" },
      ],
    });
    expect(result.checkouts[1]).toMatchObject({ repo: "a2f0/missing", error: "checkout missing; run sync" });
    expect(result.ok).toBe(false);
    expect(result.rules.map(rule => rule.id)).not.toContain("agent-tool-latest");
  });

  test("reports a checkout whose status could not be read without auditing it", () => {
    const result = audit(root, ["a2f0/broken"], selectRules([], false), repo => ({ ...statusOf(repo), error: "git failed" }), context);
    expect(result.checkouts).toEqual([{ repo: "a2f0/broken", path: "checkouts/broken", failed: [], skipped: [], error: "git failed" }]);
    expect(result).toMatchObject({ ok: false, failures: {} });
  });

  test("lists failing repositories per rule in checkout order", () => {
    const repos = [
      checkout("first", { ".gitignore": "/.DS_Store\n" }),
      checkout("fine"),
      checkout("second", { "AGENTS.md": null, ".gitignore": "/.DS_Store\n" }),
    ];
    const result = audit(root, repos, selectRules(["agents-md", "ds-store-ignored"], false), statusOf, context);
    // Rules appear in the order a checkout first fails them, not rule order.
    expect(Object.keys(result.failures)).toEqual(["ds-store-ignored", "agents-md"]);
    expect(result.failures).toEqual({ "ds-store-ignored": ["a2f0/first", "a2f0/second"], "agents-md": ["a2f0/second"] });
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

  test("counts characters, not bytes, in every AGENTS.md against the context limit", () => {
    const at = (chars: number) => GUIDANCE + "x".repeat(chars - GUIDANCE.length);
    // Multi-byte characters count once: 20,000 of them pass although they take 60,000 bytes.
    expect(
      failures(
        checkout("at-limit", { "AGENTS.md": GUIDANCE + "€".repeat(AGENTS_MD_MAX_CHARS - GUIDANCE.length), "packages/web/AGENTS.md": at(AGENTS_MD_MAX_CHARS) }),
      )["agents-md-size"],
    ).toBeUndefined();
    expect(failures(checkout("over", { "AGENTS.md": at(AGENTS_MD_MAX_CHARS + 1), "packages/web/AGENTS.md": at(45_248) }))["agents-md-size"]).toBe(
      `AGENTS.md has ${AGENTS_MD_MAX_CHARS + 1} characters; packages/web/AGENTS.md has 45248 characters; the limit is ${AGENTS_MD_MAX_CHARS}`,
    );
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
    expect(
      failures(checkout("range", { "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": "^0.1.21" } }), "agent-tool.json": null }))[
        "agent-tool-pin"
      ],
    ).toBe("pin '^0.1.21' is not an exact version; no agent-tool.json");
    expect(failures(checkout("old", { "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": "0.1.9" } }) }))["agent-tool-pin"]).toBe(
      `pins 0.1.9, older than ${MINIMUM_AGENT_TOOL}`,
    );
    const producer = checkout("agent-tool", {
      "package.json": JSON.stringify({ name: "@a2f0/agent-tool", scripts: { "agent:run": "x", "agent:logs": "y" } }),
      ".agent-tool-skills.json": null,
    });
    expect(
      audit(root, [producer], selectRules(["agent-tool-pin", "agent-tool-latest"], false), statusOf, context).checkouts[0]!.skipped.map(entry => entry.rule),
    ).toEqual(["agent-tool-pin", "agent-tool-latest"]);
  });

  test("checks generated harness permissions and a CI check for them", () => {
    const missing = checkout("unprotected", {
      ".codex/rules/agent-tool.rules": null,
      "package.json": JSON.stringify({ scripts: { "agents:check": "agent-tool skills check" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
    });
    expect(failures(missing, ["harness-permissions"])["harness-permissions"]).toBe(
      "no .codex/rules/agent-tool.rules; run agent-tool permissions install --apply; neither the agents:check script nor a workflow runs agent-tool permissions check",
    );
    const workflow = checkout("workflow", {
      "package.json": JSON.stringify({ devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
      ".github/workflows/ci.yml": "steps:\n  - run: bun run agent-tool permissions check\n",
    });
    expect(failures(workflow, ["harness-permissions"])).toEqual({});
  });

  test("compares the pin with the registry only for remote rules", () => {
    const repo = checkout("current");
    const expected = `pins ${MINIMUM_AGENT_TOOL}; latest is 0.1.23; 0.1.22 has been out 8 days`;
    expect(failures(repo, [], true)["agent-tool-latest"]).toBe(expected);
    expect(failures(repo, ["agent-tool-latest"])["agent-tool-latest"]).toBe(expected);
    expect(() =>
      audit(root, [repo], selectRules([], true), statusOf, {
        ...context,
        releases: () => {
          throw new Error("offline");
        },
      }),
    ).toThrow("offline");
  });

  test(`lets the agent-tool pin trail newer releases for ${AGENT_TOOL_GRACE_DAYS} days`, () => {
    const latest = checkout("latest", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.23" } }),
    });
    const trailing = checkout("trailing", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.22" } }),
    });
    const result = audit(root, [latest, trailing], selectRules(["agent-tool-latest"], true), statusOf, context);
    expect(result.ok).toBe(true);
    expect(result.checkouts[0]).toMatchObject({ failed: [], skipped: [] });
    expect(result.checkouts[1]!.skipped).toEqual([
      { rule: "agent-tool-latest", detail: `pins 0.1.22; latest is 0.1.23; 0.1.23 has been out 1 day, inside the ${AGENT_TOOL_GRACE_DAYS}-day grace` },
    ]);
    // The age that counts is the oldest release the pin lacks, so frequent releases cannot keep a pin current forever.
    const later = audit(root, [trailing], selectRules(["agent-tool-latest"], true), statusOf, { ...context, now: new Date("2026-11-03T00:00:00.000Z") });
    expect(later.checkouts[0]!.failed).toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.22; latest is 0.1.23; 0.1.23 has been out 7 days" }]);
    // A fresh patch on an older line does not hide a newer release that has been out longer.
    const backport = checkout("backport", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.20" } }),
    });
    const backported = audit(root, [backport], selectRules(["agent-tool-latest"], true), statusOf, {
      ...context,
      releases: () => ({ "0.1.20": "2026-10-01T00:00:00.000Z", "0.1.20-1": "x", "0.1.21": "2026-10-27T00:00:00.000Z", "0.2.0": "2026-10-10T00:00:00.000Z" }),
      now: context.now,
    });
    expect(backported.checkouts[0]!.failed).toEqual([{ rule: "agent-tool-latest", detail: "pins 0.1.20; latest is 0.2.0; 0.2.0 has been out 18 days" }]);
    const typo = checkout("typo", {
      "package.json": JSON.stringify({ scripts: { "agent:run": "x", "agent:logs": "y" }, devDependencies: { "@a2f0/agent-tool": "0.1.230" } }),
    });
    expect(audit(root, [typo], selectRules(["agent-tool-latest"], true), statusOf, context).checkouts[0]!.failed).toEqual([
      { rule: "agent-tool-latest", detail: "pins 0.1.230, which the registry has not published" },
    ]);
    const undated = audit(root, [trailing], selectRules(["agent-tool-latest"], true), statusOf, {
      ...context,
      releases: () => ({ "0.1.22": "2026-10-01T00:00:00.000Z", "0.1.23": "soon" }),
    });
    expect(undated.checkouts[0]!.failed).toEqual([
      { rule: "agent-tool-latest", detail: "pins 0.1.22; latest is 0.1.23; the registry gives no release time for 0.1.23" },
    ]);
  });

  test("checks output capture scripts and guidance, including AGENTS.md without sections", () => {
    expect(
      failures(
        checkout("capture", {
          "package.json": JSON.stringify({ scripts: { "agent:run": "agent-tool run" }, devDependencies: { "@a2f0/agent-tool": MINIMUM_AGENT_TOOL } }),
          "AGENTS.md": "# Guidance\n\n## Validation\n\nRun `bun run agent:run`.\n",
        }),
        ["output-capture"],
      )["output-capture"],
    ).toBe("no agent:logs script; AGENTS.md has no Output capture section");
    expect(
      failures(
        checkout("empty-section", {
          "AGENTS.md": "# Guidance\n\n## Output capture\n\nTBD.\n\n## Validation\n\nRun `bun run agent:run` and `bun run agent:logs`.\n",
        }),
        ["output-capture"],
      )["output-capture"],
    ).toBe("Output capture guidance does not mention agent:run; Output capture guidance does not mention agent:logs");
    expect(
      failures(
        checkout("subsection", {
          "AGENTS.md": "# Guidance\n\n## Output capture\n\nUse `agent:run`.\n\n### Logs\n\nRead with `agent:logs`.\n",
        }),
        ["output-capture"],
      ),
    ).toEqual({});
    expect(
      failures(checkout("paragraph", { "AGENTS.md": "# Guidance\n\nRun `bun run agent:run` and `bun run agent:logs <log>`.\n" }), ["output-capture"]),
    ).toEqual({});
  });

  test("checks the State machines section and the installed skill, which agent-tool itself ships from skills/", () => {
    const rule = (name: string, files: Record<string, string | null>) => failures(checkout(name, files), ["state-machines"])["state-machines"];
    expect(
      rule("unadopted", {
        "AGENTS.md": "# Guidance\n\n## Output capture\n\nRun `agent:run` and `agent:logs`.\n",
        ".agents/skills/explicit-state-machines/SKILL.md": null,
      }),
    ).toBe(
      "AGENTS.md has no State machines section; the explicit-state-machines skill is not installed; pin @a2f0/agent-tool 0.1.51 or later and run agent-tool skills install --apply",
    );
    expect(rule("unnamed", { "AGENTS.md": "# Guidance\n\n## State machines\n\nName your states.\n" })).toBe(
      "State machines guidance does not mention explicit-state-machines",
    );
    // Only a manifest entry whose file is present counts as installed.
    expect(rule("listed-only", { ".agents/skills/explicit-state-machines/SKILL.md": null })).toContain("skill is not installed");
    expect(rule("paragraph", { "AGENTS.md": "# Guidance\n\nFollow the explicit-state-machines skill.\n" })).toBeUndefined();
    const producer = {
      "package.json": JSON.stringify({ name: "@a2f0/agent-tool" }),
      ".agent-tool-skills.json": null,
      ".agents/skills/explicit-state-machines/SKILL.md": null,
    };
    expect(rule("agent-tool", producer)).toBe("no tracked skills/explicit-state-machines/SKILL.md");
    expect(rule("agent-tool-shipping", { ...producer, "skills/explicit-state-machines/SKILL.md": "# Explicit State Machines\n" })).toBeUndefined();
  });

  // README cases run only the README rules: a whole audit per fixture made
  // this one test take over 5 s on a loaded machine.
  const README_RULES = ["readme-title", "readme-quick-start", "readme-agent-free"];
  const readme = (name: string, files: Record<string, string>) => failures(checkout(name, files), README_RULES);

  test("rejects README titles that link or carry a link line", () => {
    expect(readme("linked", { "README.md": "# [demo](https://demo.example)\n\n## Quick start\n" })["readme-title"]).toBe(
      "H1 '# [demo](https://demo.example)' contains a link",
    );
    expect(readme("link-line", { "README.md": "# demo\n<https://demo.example>\n\n## Quick start\n" })["readme-title"]).toBe(
      "a standalone link line follows the H1: '<https://demo.example>'",
    );
    expect(readme("reference", { "README.md": "# [demo][site]\n\n## Quick start\n\n[site]: https://demo.example\n" })["readme-title"]).toBe(
      "H1 '# [demo][site]' contains a link",
    );
    expect(readme("shortcut", { "README.md": "# [demo]\n\n## Quick start\n\n[demo]: https://demo.example\n" })["readme-title"]).toBe(
      "H1 '# [demo]' contains a link",
    );
    expect(readme("brackets", { "README.md": "# [demo]\n[beta]\n\n## Quick start\n" })).toEqual({});
  });

  test("finds the Quick start heading only outside code fences", () => {
    expect(readme("no-start", { "README.md": "# demo\n\n```md\n## Quick start\n```\n" })["readme-quick-start"]).toBe("README.md has no Quick start section");
    expect(readme("nested", { "README.md": "# demo\n\n````md\n```sh\nbun install\n```\n## Quick start\n````\n" })["readme-quick-start"]).toBe(
      "README.md has no Quick start section",
    );
    expect(readme("tilde", { "README.md": "# demo\n\n~~~\n```\n~~~\n\n## Quick start\n" })).toEqual({});
    expect(readme("setext", { "README.md": "# demo\n\nQuick start\n-----------\n\n```sh\nbun install\n```\n" })).toEqual({});
    expect(readme("rule", { "README.md": "# demo\n\nOne\nparagraph\nQuick start\n---\n" })["readme-quick-start"]).toBe("README.md has no Quick start section");
  });

  test("accepts closed ATX headings and rejects agent instructions in a README", () => {
    expect(
      failures(
        checkout("closed", {
          "README.md": "# demo #\n\n## Quick start ##\n",
          "AGENTS.md": "# Guidance\n\n## Output capture ##\n\n`agent:run`, `agent:logs`\n",
        }),
        [...README_RULES, "output-capture"],
      ),
    ).toEqual({});
    expect(readme("agentic", { "README.md": `${README}\n## Output capture\n\nUse agent:run.\n` })["readme-agent-free"]).toBe(
      "README.md mentions Output capture, agent:run",
    );
  });

  test("checks brand sources and committed rasters", () => {
    expect(failures(checkout("brand", { "assets/brand/logo.svg": "<svg/>", "assets/brand/icon.png": "png", "agent-tool.json": "{}" }))["brand-images"]).toBe(
      "agent-tool.json declares no images; committed rasters: assets/brand/icon.png",
    );
    expect(failures(checkout("brand-ok", { "assets/brand/logo.svg": "<svg/>", "agent-tool.json": JSON.stringify({ images: { targets: {} } }) }))).toEqual({});
  });

  test("requires a screenshots script and an ignore pattern that matches the store link", () => {
    const rule = (name: string, files: Record<string, string>) => failures(checkout(name, files), ["screenshots-store"])["screenshots-store"];
    expect(rule("no-capture", {})).toBeUndefined();
    expect(rule("slashed", { ".gitignore": ".DS_Store\n.screenshots/\n" })).toBe(
      "ignores .screenshots but has no screenshots package script; the root .gitignore does not list .screenshots without a trailing slash",
    );
    expect(rule("unignored", { "package.json": JSON.stringify({ scripts: { screenshots: "sh capture.sh" } }) })).toBe(
      "the root .gitignore does not list .screenshots without a trailing slash",
    );
    expect(
      rule("ok", { ".gitignore": ".DS_Store\n/.screenshots\n", "package.json": JSON.stringify({ scripts: { screenshots: "sh capture.sh" } }) }),
    ).toBeUndefined();
  });

  test("requires websites that show captures to stage them with agent-tool", () => {
    const rule = (name: string, files: Record<string, string>) => failures(checkout(name, files), ["screenshots-gallery"])["screenshots-gallery"];
    const capture = JSON.stringify({ scripts: { screenshots: "sh capture.sh" } });
    expect(rule("store-only", { "package.json": capture })).toBeUndefined();
    expect(rule("site-only", { "packages/website/astro.config.ts": "export default {};\n" })).toBeUndefined();
    expect(
      rule("copied", {
        "package.json": capture,
        "packages/website/astro.config.ts": "export default {};\n",
        "packages/website/scripts/sharedCapture.ts": "export async function withSharedCapture() {}\n",
        "packages/website/scripts/sharedCapture.test.ts": "withSharedCapture\n",
        "packages/website/scripts/sharedCapture.spec.ts": "withSharedCapture\n",
        "packages/website/__tests__/guard.ts": "withSharedCapture\n",
      }),
    ).toBe(
      "agent-tool.json declares no screenshots targets; no package script runs agent-tool screenshots build; copies the capture guard: packages/website/scripts/sharedCapture.ts",
    );
    const target = JSON.stringify({ screenshots: { targets: { website: { dir: "packages/website/public/shots" } } } });
    expect(rule("unused", { "package.json": capture, "packages/website/astro.config.ts": "export default {};\n", "agent-tool.json": target })).toBe(
      "no package script runs agent-tool screenshots build",
    );
    expect(
      rule("capture-script", {
        "package.json": JSON.stringify({ scripts: { screenshots: "sh capture.sh", build: "bun run screenshots build website" } }),
        "packages/website/astro.config.ts": "export default {};\n",
        "agent-tool.json": target,
      }),
    ).toBe("no package script runs agent-tool screenshots build");
    expect(
      rule("shared", {
        "package.json": capture,
        "packages/website/astro.config.ts": "export default {};\n",
        "agent-tool.json": target,
        "packages/website/package.json": JSON.stringify({ scripts: { prebuild: "agent-tool --repo ../.. screenshots build website" } }),
      }),
    ).toBeUndefined();
  });

  // Each cycle-guard fixture is a checkout of its own, so the cases are split by guard kind.
  const guard = (name: string, files: Record<string, string>) =>
    failures(checkout(name, { "src/a.ts": "export const a = 1;\n", ...files }), ["import-cycle-guard"])["import-cycle-guard"];
  const missing =
    "TypeScript has no Biome noImportCycles with ignoreTypes: false, dependency-cruiser no-circular rule, agent-tool graph check, or module-graph test";

  test("requires an import-cycle guard: Biome noImportCycles that counts type-only imports, or a module-graph test", () => {
    expect(guard("unguarded", {})).toBe(missing);
    expect(guard("biome-default", { "biome.json": '{ "linter": { "rules": { "suspicious": { "noImportCycles": "error" } } } }' })).toBe(missing);
    expect(
      guard("biome", { "packages/web/biome.jsonc": '{ "suspicious": { "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } } } }' }),
    ).toBeUndefined();
    // A commented-out or disabled rule is not a guard.
    expect(
      guard("biome-commented", {
        "biome.jsonc":
          '{\n  // "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } }\n  /* "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } } */\n}',
      }),
    ).toBe(missing);
    expect(
      guard("biome-url", {
        "biome.jsonc":
          '{ "$schema": "https://biomejs.dev/schemas/2.6.2/schema.json", "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } } }',
      }),
    ).toBeUndefined();
    expect(guard("biome-off", { "biome.json": '{ "suspicious": { "noImportCycles": { "level": "off", "options": { "ignoreTypes": false } } } }' })).toBe(
      missing,
    );
    expect(guard("graph-test", { "tests/module-graph.test.ts": "test('acyclic', () => {});\n" })).toBeUndefined();
  });

  test("accepts a dependency-cruiser no-circular rule only as a type-aware error", () => {
    expect(
      guard("cruiser", {
        "dependency-cruiser.config.ts":
          'export default { forbidden: [{ name: "no-circular", severity: "error", from: {}, to: { circular: true } }], options: { tsPreCompilationDeps: "specify" } };',
      }),
    ).toBeUndefined();
    expect(
      guard("cruiser-policy", {
        "scripts/checks/architecturePolicy.ts":
          'import type { IForbiddenRuleType } from "dependency-cruiser";\nexport const rules = [{ name: "no-circular", severity: "error", to: {\n  circular: true,\n} }];\nexport const options = { parser: "swc" };',
      }),
    ).toBeUndefined();
    expect(
      guard("cruiser-multiline", {
        ".dependency-cruiser.cjs":
          'require("dependency-cruiser");\nmodule.exports = { forbidden: [{\n  name: "no-circular",\n  severity: "error",\n  to: { circular:\n    true },\n}], options: { tsPreCompilationDeps: true } };',
      }),
    ).toBeUndefined();
    // Test fixtures and unrelated data are not guards.
    expect(
      guard("cruiser-fixture", {
        "tests/fixtures/depcruise.ts":
          'import "dependency-cruiser";\nconst rule = { name: "no-circular", severity: "error", to: { circular: true } };\nconst options = { tsPreCompilationDeps: true };',
      }),
    ).toBe(missing);
    expect(
      guard("cruiser-test", {
        "src/policy.test.ts":
          'import "dependency-cruiser";\nconst rule = { name: "no-circular", severity: "error", to: { circular: true } };\nconst options = { tsPreCompilationDeps: true };',
      }),
    ).toBe(missing);
    expect(guard("circular-data", { "data/graph.json": '{ "name": "no-circular", "circular": true }' })).toBe(missing);
    expect(
      guard("cruiser-json", {
        ".dependency-cruiser.json":
          '{ "forbidden": [{ "name": "no-circular", "severity": "error", "to": { "circular": true } }], "options": { "tsPreCompilationDeps": true } }',
      }),
    ).toBeUndefined();
    // A rule that skips type-only imports, or only warns, does not gate a merge.
    expect(
      guard("cruiser-untyped", {
        "dependency-cruiser.config.ts": 'export default { forbidden: [{ name: "no-circular", severity: "error", to: { circular: true } }] };',
      }),
    ).toBe(missing);
    expect(
      guard("cruiser-ignored", {
        "dependency-cruiser.config.ts":
          'export default { forbidden: [{ name: "no-circular", severity: "ignore", to: { circular: true } }], options: { tsPreCompilationDeps: true } };',
      }),
    ).toBe(missing);
    expect(
      guard("cruiser-default", {
        "dependency-cruiser.config.ts":
          'export default { forbidden: [{ name: "no-circular", to: { circular: true } }], options: { tsPreCompilationDeps: true } };',
      }),
    ).toBe(missing);
  });

  test("ignores a no-circular mention outside any object or in an unclosed one", () => {
    const options = "options: { tsPreCompilationDeps: true }";
    expect(guard("cruiser-bare", { "dependency-cruiser.config.ts": `"no-circular" severity: "error" circular: true; export default { ${options} };` })).toBe(
      missing,
    );
    expect(
      guard("cruiser-unclosed", {
        "dependency-cruiser.config.ts": `export default { ${options}, rule: { name: "no-circular", severity: "error", to: { circular: true }`,
      }),
    ).toBe(missing);
  });

  test("accepts agent-tool's graph check only where a script, run group, workflow, or runner runs it", () => {
    const graphConfig = JSON.stringify({ schemaVersion: 1, graph: { include: ["src/**"] } });
    expect(
      guard("graph-command", {
        "agent-tool.json": graphConfig,
        "scripts/testing/verify.json": '{ "steps": [{ "label": "graph", "command": ["bun", "run", "agent-tool", "graph", "check"] }] }',
      }),
    ).toBeUndefined();
    expect(
      guard("graph-workflow", { "agent-tool.json": graphConfig, ".github/workflows/ci.yml": "steps:\n  - run: bun run agent-tool graph check\n" }),
    ).toBeUndefined();
    expect(
      guard("graph-multiline", {
        "agent-tool.json": graphConfig,
        "scripts/testing/verify.json":
          '{\n  "steps": [\n    {\n      "label": "graph",\n      "command": [\n        "bun",\n        "run",\n        "agent-tool",\n        "graph",\n        "check"\n      ]\n    }\n  ]\n}\n',
      }),
    ).toBeUndefined();
    expect(
      guard("graph-script", { "agent-tool.json": graphConfig, "package.json": JSON.stringify({ scripts: { "lint:graph": "agent-tool graph check" } }) }),
    ).toBeUndefined();
    expect(
      guard("graph-runner", {
        "agent-tool.json": graphConfig,
        "scripts/testing/check.ts": 'await step("graph", [\n  agentTool,\n  "graph",\n  "check",\n]);\n',
      }),
    ).toBeUndefined();
    expect(guard("graph-runner-test", { "agent-tool.json": graphConfig, "scripts/testing/check.test.ts": 'expect(args).toEqual(["graph", "check"]);\n' })).toBe(
      missing,
    );
    expect(guard("graph-unrun", { "agent-tool.json": graphConfig })).toBe(missing);
    // Generated permission rules name the command without running it.
    expect(
      guard("graph-permitted", {
        "agent-tool.json": graphConfig,
        ".agent-tool-permissions.json": JSON.stringify({ rules: [{ command: ["agent-tool", "graph", "check"], class: "read" }] }),
        ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(bun run agent-tool graph check:*)"] } }),
        ".codex/rules/agent-tool.rules": 'prefix_rule(pattern=["agent-tool", "graph", "check"], decision="allow")\n',
      }),
    ).toBe(missing);
    expect(
      guard("graph-comment", { "agent-tool.json": graphConfig, ".github/workflows/ci.yml": "# TODO: run agent-tool graph check\nsteps:\n  - run: bun test\n" }),
    ).toBe(missing);
    expect(
      guard("graph-empty", {
        "agent-tool.json": JSON.stringify({ schemaVersion: 1, graph: { include: [] } }),
        "package.json": JSON.stringify({ scripts: { graph: "agent-tool graph check" } }),
      }),
    ).toBe(missing);
  });

  test("requires a guard per language and skips declaration-only checkouts", () => {
    const pythonMissing = "the Python package has no test_module_graph.py";
    expect(failures(checkout("python", { "plugin/__init__.py": "", "tests/test_module_graph.py": "" }), ["import-cycle-guard"])).toEqual({});
    expect(failures(checkout("python-bare", { "plugin/__init__.py": "" }), ["import-cycle-guard"])["import-cycle-guard"]).toBe(pythonMissing);
    // Each language needs its own guard: a Biome config cannot check Python.
    const biome = '{ "noImportCycles": { "level": "error", "options": { "ignoreTypes": false } } }';
    expect(guard("mixed", { "biome.json": biome, "plugin/__init__.py": "" })).toBe(pythonMissing);
    expect(guard("mixed-ok", { "biome.json": biome, "plugin/__init__.py": "", "tests/test_module_graph.py": "" })).toBeUndefined();
    expect(failures(checkout("mts-only", { "src/main.mts": "export {};\n" }), ["import-cycle-guard"])["import-cycle-guard"]).toBe(missing);
    // Declarations and managed skills are not sources.
    const skipped = audit(
      root,
      [checkout("types-only", { "types/env.d.ts": "declare const x: 1;\n" })],
      selectRules(["import-cycle-guard"], false),
      statusOf,
      context,
    );
    expect(skipped.checkouts[0]!.skipped).toEqual([{ rule: "import-cycle-guard", detail: "no TypeScript sources or Python package" }]);
  });

  test("requires mise tools to install from a format 4 lock that every pinned CI mise reads", () => {
    const config = '[tools]\nbun = "1.4.4"\n"aqua:koalaman/shellcheck" = { version = "0.11.0" }\n';
    const lock = (header: string, tools: string[]) =>
      `# @generated\n${header}\n${tools.map(tool => `[[tools."${tool}"]]\nversion = "1"\nbackend = "core:${tool}"\n`).join("\n")}`;
    // Each pinned step, then one that installs the latest mise, which reads any format.
    const workflow = (...versions: string[]) =>
      `jobs:\n  check:\n    steps:\n${versions.map(version => `      - uses: jdx/mise-action@f5be966e4a917d54244728e6a5fdcd1d93a35e6c # v5.2.6\n        with:\n          version: ${version}\n`).join("")}      - uses: jdx/mise-action@v5\n`;
    const composite = (version: string) => `runs:\n  using: composite\n  steps:\n  - uses: jdx/mise-action@v5\n    with:\n      version: v${version}\n`;
    const rule = (repo: string) => failures(repo, ["mise-lock"])["mise-lock"];
    expect(
      rule(
        checkout("unlocked", {
          ".mise.toml": config,
          ".github/workflows/ci.yml": workflow("2026.11.0", "2026.11.0", "2026.11.8"),
          ".github/actions/setup/action.yml": composite("2026.10.3"),
        }),
      ),
    ).toBe(
      "no tracked mise.lock beside .mise.toml; run mise lock; .github/actions/setup/action.yml pins mise 2026.10.3, older than 2026.11.1, which reads format 4; .github/workflows/ci.yml pins mise 2026.11.0, older than 2026.11.1, which reads format 4",
    );
    // An older format, or a tool added after locking, fails.
    expect(rule(checkout("format-3", { "mise.toml": config, "mise.lock": lock("", ["bun"]) }))).toBe(
      "mise.lock is unversioned, not format 4; mise.lock has no entry for aqua:koalaman/shellcheck; run mise lock",
    );
    expect(rule(checkout("garbled", { "mise.toml": config, "mise.lock": "lockfile_version = = 4\n" }))).toBe(
      "mise.lock is missing from the working tree or is not valid TOML",
    );
    // lockfile = false turns locking off, which mise-action's --locked rejects.
    const valid = lock("lockfile_version = 4\n", ["bun", "aqua:koalaman/shellcheck"]);
    expect(rule(checkout("lockfile-off", { "mise.toml": `${config}\n[settings]\nlockfile = false\n`, "mise.lock": valid }))).toBe(
      "mise.toml sets lockfile = false",
    );
    expect(
      rule(
        checkout("locked", {
          ".mise.toml": config,
          "mise.lock": valid,
          ".github/workflows/ci.yml": workflow("2026.11.8"),
          ".github/actions/setup/action.yml": composite("2026.11.6"),
        }),
      ),
    ).toBeUndefined();
    // A config the rule cannot read fails rather than passing as one without tools.
    expect(rule(checkout("bad-config", { ".mise.toml": "[tools\nbun = 1\n" }))).toBe(".mise.toml is missing from the working tree or is not valid TOML");
    const deleted = checkout("deleted-config", { ".mise.toml": config });
    rmSync(path.join(root, "checkouts", "deleted-config", ".mise.toml"));
    expect(rule(deleted)).toBe(".mise.toml is missing from the working tree or is not valid TOML");
    const settingsOnly = audit(
      root,
      [checkout("settings-only", { ".mise.toml": "[settings]\nlockfile = true\n" })],
      selectRules(["mise-lock"], false),
      statusOf,
      context,
    );
    expect(settingsOnly.checkouts[0]!.skipped).toEqual([{ rule: "mise-lock", detail: "declares no mise tools" }]);
  });

  test("finds superseded commands in Markdown, every spelling, outside managed skills", () => {
    const repo = checkout("stale", {
      "AGENTS.md": `${GUIDANCE}\nReply with \`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies\`.\n`,
      "docs/shipping.md":
        "Run `git push -u origin HEAD`, then `gh pr checks 12 --watch`.\nOr `git push origin --delete feat/x`.\nMerge with `bun run agent-tool squashMerge 'fix: x' abc main`.\n",
      "docs/cleanup.md": "Delete atomically: `git push --force-with-lease=refs/heads/x:abc --delete origin x`.\n",
      "scripts/ship.sh": "gh pr checks --watch\n",
      "docs/network.md": "Force HTTPS: `GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=git@github.com:`.\n",
      "docs/timings.md": "Read the last push with `sh scripts/git/showPushGateTimings.sh`.\n",
    });
    expect(failures(repo)["superseded-guidance"]).toBe(
      [
        "review-reply-endpoint at AGENTS.md:11 (use agent-tool pr threads reply)",
        "pr-checks-watch at docs/shipping.md:1 (use agent-tool pr checks --wait)",
        "squash-merge-action at docs/shipping.md:3 (use agent-tool pr merge <subject> <reviewed-head> <base-branch>)",
        "push-head-upstream at docs/shipping.md:1 (use agent-tool branch push <reviewed-head> --remote origin)",
        "push-delete at docs/shipping.md:2 (use agent-tool repo cleanup)",
        "push-gate-timings at docs/timings.md:1 (use agent-tool runs list)",
        "https-insteadof at docs/network.md:1 (use SSH through ssh.github.com:443 (matrix docs/health.md#github-over-ssh))",
      ].join("; "),
    );
  });

  test("skips agent-tool's managed skill sources, which consumers install as managed skills", () => {
    const prohibition = "Never prune with raw `git push --delete`.\n";
    const producer = { "package.json": JSON.stringify({ name: "@a2f0/agent-tool" }), "skills/ship-pr/SKILL.md": prohibition };
    expect(failures(checkout("agent-tool", producer), ["superseded-guidance"])).toEqual({});
    expect(failures(checkout("agent-tool-docs", { ...producer, "docs/ship.md": prohibition }), ["superseded-guidance"])["superseded-guidance"]).toBe(
      "push-delete at docs/ship.md:1 (use agent-tool repo cleanup)",
    );
    expect(failures(checkout("consumer", { "skills/ship-pr/SKILL.md": prohibition }), ["superseded-guidance"])["superseded-guidance"]).toBe(
      "push-delete at skills/ship-pr/SKILL.md:1 (use agent-tool repo cleanup)",
    );
  });

  test("requires origin to fetch and push over SSH", () => {
    const repo = checkout("https");
    const directory = path.join(root, "checkouts", "https");
    gitIn(directory, "remote", "set-url", "origin", "https://token@github.com/a2f0/https.git");
    expect(failures(repo, ["origin-ssh"])).toEqual({
      "origin-ssh":
        "origin fetches over https://github.com/a2f0/https.git; use git@github.com:a2f0/https.git; origin pushes over https://github.com/a2f0/https.git; use git@github.com:a2f0/https.git",
    });
    gitIn(directory, "remote", "set-url", "origin", "git@github.com:a2f0/https.git");
    gitIn(directory, "remote", "set-url", "--push", "origin", "https://github.com/a2f0/https.git");
    expect(failures(repo, ["origin-ssh"])).toEqual({ "origin-ssh": "origin pushes over https://github.com/a2f0/https.git; use git@github.com:a2f0/https.git" });
    gitIn(directory, "remote", "set-url", "--push", "origin", "ssh://git@ssh.github.com:443/a2f0/https.git");
    expect(failures(repo, ["origin-ssh"])).toEqual({});
    // Git pushes to every push URL, so a second HTTPS one fails too.
    gitIn(directory, "remote", "set-url", "--add", "--push", "origin", "https://github.com/a2f0/mirror.git");
    expect(failures(repo, ["origin-ssh"])).toEqual({
      "origin-ssh": "origin pushes over https://github.com/a2f0/mirror.git; use git@github.com:a2f0/https.git",
    });
    gitIn(directory, "remote", "remove", "origin");
    expect(failures(repo, ["origin-ssh"])).toEqual({ "origin-ssh": "no origin fetch URL; no origin push URL" });
  });

  test("reports agent-tool's push-gate check, skipping a checkout with no gate", () => {
    const repo = checkout("gated", { "scripts/git/hooks/pre-push": "#!/bin/sh\n" });
    const directories: string[] = [];
    const run = (result: PushGateResult) =>
      audit(root, [repo], selectRules(["push-gate"], false), statusOf, {
        ...context,
        pushGate: directory => {
          directories.push(directory);
          return result;
        },
      }).checkouts[0]!;
    expect(run({ status: "conforms" })).toMatchObject({ failed: [], skipped: [] });
    expect(directories).toEqual([path.join(root, "checkouts", "gated")]);
    expect(run({ status: "fails", problems: ["step tests runs bun test", "pre-push is not the canonical hook"] }).failed).toEqual([
      { rule: "push-gate", detail: "step tests runs bun test; pre-push is not the canonical hook" },
    ]);
    expect(run({ status: "none", detail: "no gate declared" }).skipped).toEqual([{ rule: "push-gate", detail: "no gate declared" }]);
    // Without a hook or a declared gate there is nothing to ask agent-tool about.
    directories.length = 0;
    expect(failures(checkout("hookless"), ["push-gate"])).toEqual({});
    expect(directories).toEqual([]);
    const hooked: Array<Record<string, string>> = [
      {
        "agent-tool.json": JSON.stringify({ schemaVersion: 1, hooks: { files: [{ source: "scripts/git/hooks/pre-push", target: "pre-push" }] } }),
        "scripts/git/hooks/pre-push": "#!/bin/sh\n",
      },
      { "agent-tool.json": JSON.stringify({ schemaVersion: 1, pushGate: { steps: [] } }) },
    ];
    for (const files of hooked) {
      const asked: string[] = [];
      audit(root, [checkout(`hooked-${Bun.hash(JSON.stringify(files))}`, files)], selectRules(["push-gate"], false), statusOf, {
        ...context,
        pushGate: directory => {
          asked.push(directory);
          return { status: "conforms" };
        },
      });
      expect(asked).toHaveLength(1);
    }
  });

  test("fails a pre-push hook that push-gate check cannot see", () => {
    const fix = "replace it with `agent-tool push-gate hook` at scripts/git/hooks/pre-push";
    const installs = (source: string) => JSON.stringify({ schemaVersion: 1, hooks: { files: [{ source, target: "pre-push" }] } });
    const elsewhere = checkout("elsewhere", { "agent-tool.json": installs("hooks/push"), "hooks/push": "bun test\n" });
    expect(failures(elsewhere, ["push-gate"])).toEqual({ "push-gate": `hooks/push is a pre-push hook outside the push gate; ${fix}` });
    // A declared source that is not tracked: agent-tool would report no gate, so the audit says what is missing.
    expect(failures(checkout("untracked-elsewhere", { "agent-tool.json": installs("hooks/push") }), ["push-gate"])).toEqual({
      "push-gate": `hooks.files installs hooks/push as pre-push, but it is not tracked; ${fix}`,
    });
    expect(failures(checkout("untracked-gate", { "agent-tool.json": installs("scripts/git/hooks/pre-push") }), ["push-gate"])).toEqual({
      "push-gate": "hooks.files installs scripts/git/hooks/pre-push as pre-push, but it is not tracked; commit the output of `agent-tool push-gate hook` there",
    });
    expect(failures(checkout("husky", { ".husky/pre-push": "bun test\n" }), ["push-gate"])).toEqual({
      "push-gate": `.husky/pre-push is a pre-push hook outside the push gate; ${fix}`,
    });
  });

  test("fails push-gate for a checkout agent-tool cannot inspect and audits the rest", () => {
    const hooked = (name: string) => checkout(name, { "scripts/git/hooks/pre-push": "#!/bin/sh\n" });
    const asked: string[] = [];
    const broken: AuditContext = {
      ...context,
      pushGate: directory => {
        asked.push(path.basename(directory));
        throw new Error("agent-tool push-gate check printed no report: boom\nmore");
      },
    };
    const result = audit(root, [hooked("first-broken"), hooked("second-broken")], selectRules(["push-gate"], false), statusOf, broken);
    expect(asked).toEqual(["first-broken", "second-broken"]);
    expect(result.checkouts.map(entry => entry.failed)).toEqual([
      [{ rule: "push-gate", detail: "could not run agent-tool push-gate check: agent-tool push-gate check printed no report: boom" }],
      [{ rule: "push-gate", detail: "could not run agent-tool push-gate check: agent-tool push-gate check printed no report: boom" }],
    ]);
  });

  test("fails a checkout whose agent-tool.json requires an up-to-date branch", () => {
    const strict = checkout("strict", { "agent-tool.json": JSON.stringify({ schemaVersion: 1, merge: { requireStrictBaseFreshness: true } }) });
    const relaxed = checkout("relaxed", { "agent-tool.json": JSON.stringify({ schemaVersion: 1, merge: { requireStrictBaseFreshness: false } }) });
    expect(failures(strict, ["base-freshness"])).toEqual({ "base-freshness": "merge.requireStrictBaseFreshness is true; set it to false" });
    expect(failures(relaxed, ["base-freshness"])).toEqual({});
  });

  test("asks GitHub about the default branch's freshness settings only for remote rules", () => {
    const repo = checkout("protected");
    const asked: string[] = [];
    const strict: AuditContext = {
      ...context,
      strictFreshness: (name, branch) => {
        asked.push(`${name}@${branch}`);
        return ["classic branch protection", "ruleset 7"];
      },
    };
    expect(audit(root, [repo], selectRules([], false), statusOf, strict).checkouts[0]!.failed).toEqual([]);
    expect(asked).toEqual([]);
    expect(audit(root, [repo], selectRules(["base-freshness-settings"], true), statusOf, strict).checkouts[0]!.failed).toEqual([
      { rule: "base-freshness-settings", detail: "classic branch protection and ruleset 7 require an up-to-date branch on main" },
    ]);
    expect(asked).toEqual(["a2f0/protected@main"]);
    expect(failures(repo, ["base-freshness-settings"], true)).toEqual({});
    // A GitHub error fails that checkout's rule and leaves the rest of the audit running.
    const broken: AuditContext = {
      ...context,
      strictFreshness: () => {
        throw new Error("gh: HTTP 502: Bad Gateway\n(details)");
      },
    };
    const result = audit(root, [repo, checkout("other")], selectRules(["base-freshness-settings"], true), statusOf, broken);
    expect(result.checkouts.map(entry => entry.failed)).toEqual([
      [{ rule: "base-freshness-settings", detail: "could not read main's protection: gh: HTTP 502: Bad Gateway" }],
      [{ rule: "base-freshness-settings", detail: "could not read main's protection: gh: HTTP 502: Bad Gateway" }],
    ]);
  });

  test("requires a workflow that runs on every push to the default branch", () => {
    const workflow = (on: string) => ({ ".github/workflows/ci.yml": `name: CI\n${on}\njobs: {}\n` });
    const runs = (on: string) => failures(checkout(`ci-${Bun.hash(on)}`, workflow(on)), ["default-branch-ci"])["default-branch-ci"];
    const missing = "no workflow runs on every push to main; add a push trigger for it with no paths filter";
    // Forms that run on every push to main.
    for (const on of [
      "on: push",
      "on: [push, pull_request]",
      "on:\n  push:",
      'on:\n  push:\n    branches: "**"',
      "on:\n  push:\n    branches: [main]",
      "on:\n  push:\n    branches: ['*', '!release/*']",
      "on:\n  push:\n    branches-ignore: [gh-pages]",
    ])
      expect(runs(on)).toBeUndefined();
    // Forms that leave some pushes to main without a run.
    for (const on of [
      "on: pull_request",
      "on:\n  push:\n    branches: [main]\n    paths: [src/**]",
      "on:\n  push:\n    paths-ignore: [docs/**]",
      "on:\n  push:\n    branches: [staging]",
      "on:\n  push:\n    branches: ['*', '!main']",
      "on:\n  push:\n    branches-ignore: [main]",
      "on:\n  push:\n    tags: ['v*']",
    ])
      expect(runs(on)).toBe(missing);
    expect(failures(checkout("no-ci", { ".github/workflows/ci.yml": null }), ["default-branch-ci"])).toEqual({
      "default-branch-ci": "no GitHub Actions workflow",
    });
  });

  test("requires the workflows that run the required checks to run on every push", () => {
    const required = (checks: unknown[]) => JSON.stringify({ schemaVersion: 1, merge: { requiredChecks: checks } });
    const files = {
      ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\n    paths: [src/**]\njobs: {}\n",
      ".github/workflows/deploy.yml": "name: Deploy\non: push\njobs: {}\n",
    };
    // A deploy-only workflow on every push does not stand in for the required checks.
    expect(failures(checkout("deploy-only", { ...files, "agent-tool.json": required([{ name: "CI gate", workflow: "CI" }]) }), ["default-branch-ci"])).toEqual({
      "default-branch-ci": "'CI', which merge.requiredChecks names, does not run on every push to main; add a push trigger for it with no paths filter",
    });
    // A workflow without a name is matched by its path.
    const unnamed = { ".github/workflows/ci.yml": "on: push\njobs: {}\n", "agent-tool.json": required([{ name: "t", workflow: ".github/workflows/ci.yml" }]) };
    expect(failures(checkout("unnamed", unnamed), ["default-branch-ci"])).toEqual({});
    // Required checks without workflows fall back to any workflow on every push.
    expect(failures(checkout("bare-checks", { ...files, "agent-tool.json": required(["CI gate"]) }), ["default-branch-ci"])).toEqual({});
    // A required check whose job a push to the default branch skips leaves merges untested there.
    const gated = (condition: string) =>
      failures(
        checkout(`skips-${Bun.hash(condition)}`, {
          "agent-tool.json": required([{ name: "Tests", workflow: "CI" }]),
          ".github/workflows/ci.yml": `name: CI\non: [push, pull_request]\njobs:\n  test:\n    name: Tests\n    if: ${condition}\n    runs-on: x\n    steps:\n      - run: bun test\n`,
        }),
        ["default-branch-ci"],
      )["default-branch-ci"];
    expect(gated("github.event_name == 'pull_request'")).toBe("required check 'Tests' never runs on a push to main; let its job run there");
    expect(gated("github.ref != 'refs/heads/main'")).toBe("required check 'Tests' never runs on a push to main; let its job run there");
    for (const disabled of ["false", `$\{{ false }}`, "0", "github.event_name == 'push' && false"])
      expect(gated(disabled)).toBe("required check 'Tests' never runs on a push to main; let its job run there");
    for (const condition of ["always()", "github.event_name == 'push' || github.event_name == 'pull_request'", "vars.ENABLED == 'true'"])
      expect(gated(condition)).toBeUndefined();
    // GitHub also skips a job whose needs were skipped, unless its condition says otherwise.
    const aggregate = (gateIf: string) =>
      failures(
        checkout(`aggregate-${Bun.hash(gateIf)}`, {
          "agent-tool.json": required([{ name: "CI gate", workflow: "CI" }]),
          ".github/workflows/ci.yml": `name: CI\non: [push, pull_request]\njobs:\n  tests:\n    if: github.event_name == 'pull_request'\n    runs-on: x\n    steps:\n      - run: bun test\n  lint:\n    runs-on: x\n    steps:\n      - run: bun run lint\n  gate:\n    name: CI gate\n    needs: [lint, tests]\n${gateIf ? `    if: ${gateIf}\n` : ""}    runs-on: x\n    steps:\n      - run: "true"\n`,
        }),
        ["default-branch-ci"],
      )["default-branch-ci"];
    for (const gateIf of ["", "needs.tests.result == 'success' && always()"])
      expect(aggregate(gateIf)).toBe("required check 'CI gate' never runs on a push to main; let its job run there");
    for (const gateIf of ["always()", "always() && needs.lint.result == 'success'"]) expect(aggregate(gateIf)).toBeUndefined();
    // A required check named without its workflow is looked for in every workflow.
    const bare = (prOnly: boolean, workflowOn = "on: [push, pull_request]") =>
      failures(
        checkout(`bare-${prOnly}-${Bun.hash(workflowOn)}`, {
          "agent-tool.json": required(["Tests"]),
          ".github/workflows/ci.yml": `name: CI\n${workflowOn}\njobs:\n  test:\n    name: Tests\n${prOnly ? "    if: github.event_name == 'pull_request'\n" : ""}    runs-on: x\n    steps:\n      - run: bun test\n`,
          ".github/workflows/deploy.yml": "name: Deploy\non: push\njobs: {}\n",
        }),
        ["default-branch-ci"],
      )["default-branch-ci"];
    expect(bare(true)).toBe("required check 'Tests' never runs on a push to main; let its job run there");
    expect(bare(false, "on: pull_request")).toBe("required check 'Tests' never runs on a push to main; let its job run there");
    expect(bare(false)).toBeUndefined();
  });

  test("requires deploy and publish jobs on the default branch to wait for validation", () => {
    const config = { "agent-tool.json": JSON.stringify({ schemaVersion: 1, merge: { requiredChecks: [{ name: "CI gate", workflow: "CI" }] } }) };
    const deploys = (jobs: string, on = "on:\n  push:\n    branches: [main]\n    paths: [package.json]") =>
      failures(checkout(`deploy-${Bun.hash(jobs + on)}`, { ...config, ".github/workflows/ship.yml": `name: Ship\n${on}\njobs:\n${jobs}` }), [
        "deploys-need-checks",
      ])["deploys-need-checks"];
    const step = (run: string) => `    runs-on: x\n    steps:\n      - run: ${run}\n`;
    // Waiting for a required check, a job named for validation, or a job whose steps validate.
    for (const jobs of [
      `  gate:\n    name: CI gate\n${step("true")}  deploy:\n    needs: gate\n${step("wrangler deploy")}`,
      `  build:\n${step("bun run build")}  ci:\n${step("sh wait.sh")}  publish:\n    needs: [build, ci]\n${step("npm publish")}`,
      `  prepare:\n${step("bun run verify")}  publish:\n    needs: prepare\n${step("npm publish")}`,
      `  prepare:\n${step("cargo test --all")}  pack:\n    needs: prepare\n${step("npm pack")}  publish:\n    needs: pack\n${step("npm publish")}`,
      `  deploy:\n${step("bun test && wrangler deploy")}`,
      `  lint:\n${step("bun run lint")}`,
    ])
      expect(deploys(jobs)).toBeUndefined();
    // Shipping jobs that wait for nothing that validates.
    expect(deploys(`  deploy:\n${step("wrangler deploy")}`)).toBe(
      ".github/workflows/ship.yml deploy starts without needing a required check or a job that runs tests",
    );
    expect(
      deploys(
        `  build:\n${step("bun run build")}  publish:\n    name: Publish pkg\n    needs: build\n${step("npm publish")}  deploy-docs:\n    needs: [missing]\n${step("x")}`,
      ),
    ).toBe(
      ".github/workflows/ship.yml publish (Publish pkg), .github/workflows/ship.yml deploy-docs start without needing a required check or a job that runs tests",
    );
    // Workflows that pushes to the default branch never start are out of scope.
    expect(deploys(`  deploy:\n${step("wrangler deploy")}`, "on:\n  push:\n    branches: [staging]")).toBeUndefined();
    expect(deploys(`  deploy:\n${step("wrangler deploy")}`, "on: workflow_dispatch")).toBeUndefined();
  });

  test("rejects unknown rules", () => {
    expect(() => selectRules(["nope"], false)).toThrow("Unknown audit rule 'nope'");
    expect(new Set(RULES.map(rule => rule.id)).size).toBe(RULES.length);
  });
});
