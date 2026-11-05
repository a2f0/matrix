import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RULES } from "./audit";
import { openCheckout } from "./auditCheckout";
import { HELP, ROOT } from "./cli";
import { anchors, linkTargets, splitCode } from "./markdown";
import { supersededGuidance } from "./superseded";

/**
 * AGENTS.md grew fivefold in its first month, one lesson at a time, and every
 * agent reads all of it. Make room for new guidance by moving detail into docs/
 * or replacing a rule with a command `matrix audit` or agent-tool runs; raise
 * the budget only with a reason in the PR.
 */
const AGENTS_MD_WORD_BUDGET = 2_800;

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const DOCS = [
  "README.md",
  "AGENTS.md",
  ...readdirSync(path.join(ROOT, "docs"))
    .filter(file => file.endsWith(".md"))
    .sort()
    .map(file => `docs/${file}`),
];
/** Docs about matrix itself; these two describe commands in the managed repositories. */
const MATRIX_DOCS = DOCS.filter(file => !["docs/tooling.md", "docs/fastlane.md"].includes(file));
const code = (file: string) => splitCode(read(file)).code;

/** Command groups and subcommands from the installed agent-tool's usage lines. */
function agentToolCommands(): Map<string, Set<string>> {
  const result = spawnSync(path.join(ROOT, "node_modules", ".bin", "agent-tool"), ["--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const commands = new Map<string, Set<string>>();
  const word = /^[a-z][a-z-]*$/;
  const add = (group: string, sub?: string) => {
    const subs = commands.get(group) ?? new Set<string>();
    if (sub) for (const name of sub.replace(/^<(.*)>$/, "$1").split("|")) if (word.test(name)) subs.add(name);
    commands.set(group, subs);
  };
  for (const line of result.stdout.split("\n")) {
    const match = /^ {2}([a-z][a-z-]*)(.*)$/.exec(line);
    if (!match) continue;
    // Usage and description are separated by a run of spaces; alternatives by " | ".
    const [first, ...rest] = match[2]!
      .trim()
      .split(/\s{2,}/)[0]!
      .split(" | ")
      .map(segment => segment.trim().split(/\s+/));
    add(match[1]!, first![0]);
    for (const [sub, next] of rest) {
      add(match[1]!, sub);
      if (sub && word.test(sub)) add(sub, next);
    }
  }
  return commands;
}

/** Why a relative link in a doc does not resolve: a missing file or heading; empty for external links. */
function brokenLink(file: string, target: string): string[] {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return [];
  const [relative, hash] = target.split("#");
  const destination = relative ? path.normalize(path.join(path.dirname(file), relative)) : file;
  // Links outside the repository, such as the sibling secrets folder, vary by machine.
  if (destination.startsWith("..")) return [];
  if (!existsSync(path.join(ROOT, destination))) return [`${file}: ${target}`];
  if (hash && destination.endsWith(".md") && !anchors(read(destination)).has(hash)) return [`${file}: ${target} has no such heading`];
  return [];
}

interface KnownNames {
  readonly scripts: Set<string>;
  readonly actions: Set<string>;
  readonly rules: Set<string>;
}

/** Package scripts, sweep actions, and audit rules a doc's code snippet names that do not exist. */
function missingNames(file: string, snippet: string, { scripts, actions, rules }: KnownNames): string[] {
  const missing: string[] = [];
  for (const [, name, action] of snippet.matchAll(/\bbun run (?:--silent )?(?:--cwd \S+ )?([a-z][\w:-]*)(?: ([a-z]+))?/g)) {
    if (!scripts.has(name!)) missing.push(`${file}: bun run ${name}`);
    else if (name === "sweep" && action && !actions.has(action)) missing.push(`${file}: bun run sweep ${action}`);
  }
  for (const [, rule] of snippet.matchAll(/--rule[ =]([a-z-]+)/g)) if (!rules.has(rule!)) missing.push(`${file}: --rule ${rule}`);
  return missing;
}

/** agent-tool commands and subcommands a doc's code snippet names that the pinned release lacks. */
function missingAgentToolCommands(file: string, snippet: string, commands: Map<string, Set<string>>): string[] {
  const missing: string[] = [];
  for (const [, group, sub] of snippet.matchAll(/(?:^|[\s(])agent-tool(?: --(?:repo|config) \S+)* ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
    const subs = commands.get(group!);
    if (!subs) missing.push(`${file}: agent-tool ${group}`);
    else if (sub && subs.size > 0 && !subs.has(sub)) missing.push(`${file}: agent-tool ${group} ${sub}`);
  }
  return missing;
}

describe("guidance", () => {
  test("every relative link and anchor resolves", () => {
    const broken = DOCS.flatMap(file => linkTargets(read(file)).flatMap(target => brokenLink(file, target)));
    expect(broken).toEqual([]);
  });

  test("every package script, matrix command, and audit rule the docs name exists", () => {
    const known: KnownNames = {
      scripts: new Set(Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts)),
      actions: new Set([...HELP.matchAll(/^ {2}sweep ([a-z]+)/gm)].map(([, action]) => action!)),
      rules: new Set(RULES.map(rule => rule.id)),
    };
    const missing = MATRIX_DOCS.flatMap(file => code(file).flatMap(snippet => missingNames(file, snippet, known)));
    expect(missing).toEqual([]);
  });

  test("every agent-tool command the docs name exists in the pinned release", () => {
    const commands = agentToolCommands();
    const missing = DOCS.flatMap(file => code(file).flatMap(snippet => missingAgentToolCommands(file, snippet, commands)));
    expect(missing).toEqual([]);
  });

  test("docs/audit.md lists every audit rule", () => {
    const listed = [...read("docs/audit.md").matchAll(/^\| `([a-z-]+)` \|/gm)].map(([, id]) => id!);
    expect(listed.toSorted()).toEqual(RULES.map(rule => rule.id).toSorted());
  });

  test(`AGENTS.md stays within ${AGENTS_MD_WORD_BUDGET} words`, () => {
    expect(read("AGENTS.md").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(AGENTS_MD_WORD_BUDGET);
  });

  test("matrix meets the standards it audits", () => {
    const checkout = openCheckout("a2f0/matrix", ROOT);
    const context = {
      releases: () => {
        throw new Error("remote rules do not run here");
      },
    };
    const failures = RULES
      // Matrix, like agent-tool, is agent tooling, so its README describes the skills it installs.
      // origin-ssh reads this clone's remote, not committed files; CI's checkout clones over HTTPS.
      .filter(rule => !rule.remote && !["superseded-guidance", "readme-agent-free", "origin-ssh"].includes(rule.id))
      .flatMap(rule => {
        const outcome = rule.check(checkout, context);
        return outcome.status === "fail" ? [`${rule.id}: ${outcome.detail}`] : [];
      });
    // docs/audit.md names the superseded spellings it searches for.
    failures.push(...supersededGuidance(checkout, ["docs/audit.md"]));
    expect(failures).toEqual([]);
  });
});
