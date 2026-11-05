import { spawnSync } from "node:child_process";
import { type Checkout, excludeManaged, openCheckout, sourceGlobs, TEST_PATH, workflows } from "./auditCheckout";
import { type CheckoutStatus, redact } from "./checkouts";
import { typescriptGuarded } from "./cycleGuards";
import { git } from "./git";
import { checkoutPath, isGitHubSsh } from "./manifest";
import { hasLink, hasSection, headings, nonBlankLines, section } from "./markdown";
import { AGENT_TOOL, dependency, object, parseObject } from "./packageJson";
import { supersededGuidance } from "./superseded";
import { plural } from "./text";

/**
 * The oldest pin the sweep rules support: 0.1.21 provides `branch create`,
 * `branch push`, `pr checks --wait`, and `repo cleanup` with local pruning, so
 * guidance no longer carries fallbacks for older pins.
 */
export const MINIMUM_AGENT_TOOL = "0.1.21";
/**
 * How long a pin may trail a newer agent-tool release before the remote audit
 * fails. agent-tool can release several times a day, and each pin sweep runs
 * every checkout's validation, so upgrades batch weekly instead of chasing
 * every release.
 */
export const AGENT_TOOL_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

type Outcome = { readonly status: "pass" } | { readonly status: "fail" | "skip"; readonly detail: string };

export interface AuditContext {
  /** When each published release of a package appeared, by exact version; only remote rules call it. */
  releases(name: string): Record<string, string>;
  /** The time release ages are measured against; defaults to now. */
  readonly now?: Date;
}

export interface Rule {
  readonly id: string;
  readonly summary: string;
  /** The guidance that defines the standard. */
  readonly source: string;
  /** Needs the network; runs only with --remote. */
  readonly remote?: true;
  check(checkout: Checkout, context: AuditContext): Outcome;
}

const pass: Outcome = { status: "pass" };
const fail = (detail: string): Outcome => ({ status: "fail", detail });
const skip = (detail: string): Outcome => ({ status: "skip", detail });
const problems = (list: string[]): Outcome => (list.length === 0 ? pass : fail(list.join("; ")));

/** agent-tool publishes itself; its checkout runs the source CLI instead of a pin. */
function isProducer(checkout: Checkout): boolean {
  return checkout.packageJson?.name === AGENT_TOOL;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

const OUTPUT_CAPTURE_SCRIPTS = ["agent:run", "agent:logs"];

/** What the root package.json lacks of the output-capture scripts. */
function outputCaptureScriptProblems(checkout: Checkout): string[] {
  if (checkout.packageJson === undefined) return ["no root package.json for the agent:run and agent:logs scripts"];
  return OUTPUT_CAPTURE_SCRIPTS.filter(name => typeof checkout.scripts[name] !== "string").map(name => `no ${name} script`);
}

/** What AGENTS.md lacks of the Output capture guidance. */
function outputCaptureGuidanceProblems(guidance: string | undefined): string[] {
  if (guidance === undefined) return ["no AGENTS.md for the Output capture section"];
  // An AGENTS.md without sections carries the same text as a paragraph.
  const sectioned = headings(guidance).some(heading => heading.level >= 2);
  const text = sectioned ? section(guidance, "Output capture") : guidance;
  if (text === undefined) return ["AGENTS.md has no Output capture section"];
  return OUTPUT_CAPTURE_SCRIPTS.filter(name => !text.includes(name)).map(name => `Output capture guidance does not mention ${name}`);
}

const ONBOARDING = "AGENTS.md#onboarding-a-repository";

/** Hermes truncates a context file past this many characters (Unicode code points), dropping its middle. */
export const AGENTS_MD_MAX_CHARS = 20_000;

export const RULES: readonly Rule[] = [
  {
    id: "agents-md",
    summary: "AGENTS.md holds the repository's agent guidance",
    source: ONBOARDING,
    check: checkout => {
      if (checkout.tracked("AGENTS.md").length === 0) return fail("no tracked AGENTS.md at the root");
      return checkout.read("AGENTS.md") === undefined ? fail("AGENTS.md is tracked but missing from the working tree") : pass;
    },
  },
  {
    id: "agents-md-size",
    summary: `Every AGENTS.md fits Hermes's ${AGENTS_MD_MAX_CHARS.toLocaleString("en-US")}-character context limit`,
    source: "docs/tooling.md#agent-guidance",
    check: checkout => {
      const oversized = checkout.tracked(":(glob)**/AGENTS.md").flatMap(file => {
        const chars = [...(checkout.read(file) ?? "")].length;
        return chars > AGENTS_MD_MAX_CHARS ? [`${file} has ${chars} characters`] : [];
      });
      return oversized.length === 0 ? pass : fail(`${oversized.join("; ")}; the limit is ${AGENTS_MD_MAX_CHARS}`);
    },
  },
  {
    id: "no-claude-md",
    summary: "No CLAUDE.md; Claude Code reads AGENTS.md when none exists",
    source: ONBOARDING,
    check: checkout => {
      const files = checkout.tracked(":(glob)**/CLAUDE.md");
      return files.length === 0 ? pass : fail(`tracked ${files.join(", ")}`);
    },
  },
  {
    id: "ds-store-ignored",
    summary: "The root .gitignore lists .DS_Store as a plain pattern",
    source: ONBOARDING,
    check: checkout => {
      const lines = (checkout.read(".gitignore") ?? "").split("\n").map(line => line.trim());
      return lines.includes(".DS_Store") || lines.includes("**/.DS_Store") ? pass : fail("root .gitignore does not list .DS_Store");
    },
  },
  {
    id: "agent-tool-pin",
    summary: `@a2f0/agent-tool is pinned exactly, at ${MINIMUM_AGENT_TOOL} or newer, with agent-tool.json and managed skills`,
    source: ONBOARDING,
    check: checkout => {
      if (isProducer(checkout)) return skip("publishes agent-tool and runs its source CLI");
      const found: string[] = [];
      const pin = dependency(checkout.packageJson, AGENT_TOOL);
      if (pin === undefined) found.push("package.json does not depend on @a2f0/agent-tool");
      else if (!EXACT_VERSION.test(pin)) found.push(`pin '${pin}' is not an exact version`);
      else if (compareVersions(pin, MINIMUM_AGENT_TOOL) < 0) found.push(`pins ${pin}, older than ${MINIMUM_AGENT_TOOL}`);
      if (!checkout.exists("agent-tool.json")) found.push("no agent-tool.json");
      if (!checkout.exists(".agent-tool-skills.json")) found.push("no .agent-tool-skills.json; run agent-tool skills install --apply");
      return problems(found);
    },
  },
  {
    id: "agent-tool-latest",
    summary: `The agent-tool pin has trailed newer releases for under ${AGENT_TOOL_GRACE_DAYS} days`,
    source: "docs/dependency-upgrades.md",
    remote: true,
    check: (checkout, context) => {
      if (isProducer(checkout)) return skip("publishes agent-tool");
      const pin = dependency(checkout.packageJson, AGENT_TOOL);
      if (pin === undefined) return skip("does not pin agent-tool");
      if (!EXACT_VERSION.test(pin)) return skip(`pin '${pin}' is not exact; see agent-tool-pin`);
      const releases = context.releases(AGENT_TOOL);
      if (!(pin in releases)) return fail(`pins ${pin}, which the registry has not published`);
      const newer = Object.keys(releases)
        .filter(version => EXACT_VERSION.test(version) && compareVersions(version, pin) > 0)
        .sort(compareVersions);
      if (newer.length === 0) return pass;
      const detail = `pins ${pin}; latest is ${newer.at(-1)}`;
      const undated = newer.find(version => Number.isNaN(Date.parse(releases[version]!)));
      if (undated) return fail(`${detail}; the registry gives no release time for ${undated}`);
      // Age counts from the first newer release published, which a later backport cannot reset.
      const first = newer.reduce((oldest, version) => (Date.parse(releases[version]!) < Date.parse(releases[oldest]!) ? version : oldest));
      const age = Math.floor(((context.now ?? new Date()).getTime() - Date.parse(releases[first]!)) / DAY_MS);
      const trailing = `${first} has been out ${plural(age, "day")}`;
      return age < AGENT_TOOL_GRACE_DAYS ? skip(`${detail}; ${trailing}, inside the ${AGENT_TOOL_GRACE_DAYS}-day grace`) : fail(`${detail}; ${trailing}`);
    },
  },
  {
    id: "output-capture",
    summary: "agent:run and agent:logs scripts, and an Output capture section in AGENTS.md",
    source: "AGENTS.md#output-capture",
    check: checkout => problems([...outputCaptureScriptProblems(checkout), ...outputCaptureGuidanceProblems(checkout.read("AGENTS.md"))]),
  },
  {
    id: "readme-title",
    summary: "The README's H1 is the plain project name, with no link and no link line after it",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const readme = checkout.read("README.md");
      if (readme === undefined) return fail("no README.md");
      const [first, second] = nonBlankLines(readme);
      if (!first || !/^#\s+\S/.test(first)) return fail("README.md does not start with an H1");
      if (hasLink(first, readme)) return fail(`H1 '${first}' contains a link`);
      if (second && /^(\[[^\]]*\](\([^)]*\)|\[[^\]]*\])?|<https?:[^>]*>|https?:\/\/\S+)$/.test(second) && hasLink(second, readme)) {
        return fail(`a standalone link line follows the H1: '${second}'`);
      }
      return pass;
    },
  },
  {
    id: "readme-quick-start",
    summary: "The README has a Quick start section",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const readme = checkout.read("README.md");
      if (readme === undefined) return fail("no README.md");
      return hasSection(readme, "Quick start") ? pass : fail("README.md has no Quick start section");
    },
  },
  {
    id: "readme-agent-free",
    summary: "The README carries no instructions for coding agents",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      if (isProducer(checkout)) return skip("its product is agent tooling");
      const readme = checkout.read("README.md");
      if (readme === undefined) return skip("no README.md");
      const matches = readme.match(/agent:run|agent:logs|\.(?:claude|agents)\/skills|^#+\s+Output capture/gim) ?? [];
      const mentions = [...new Set(matches.map(match => match.replace(/^#+\s+/, "")))];
      return mentions.length === 0 ? pass : fail(`README.md mentions ${mentions.join(", ")}`);
    },
  },
  {
    id: "brand-images",
    summary: "Brand images render from assets/brand/logo.svg through agent-tool.json, with no committed rasters",
    source: "AGENTS.md#brand-images",
    check: checkout => {
      if (!checkout.exists("assets/brand")) return skip("no assets/brand");
      const found: string[] = [];
      if (!checkout.exists("assets/brand/logo.svg")) found.push("no assets/brand/logo.svg");
      if (!object(checkout.agentToolJson?.images)) found.push("agent-tool.json declares no images");
      const rasters = checkout.tracked("assets/brand").filter(file => /\.(png|ico|icns|jpe?g|gif|webp|bmp|tiff?)$/i.test(file));
      if (rasters.length > 0) found.push(`committed rasters: ${rasters.join(", ")}`);
      return problems(found);
    },
  },
  {
    id: "screenshots-store",
    summary: "Screenshot captures run as `bun run screenshots` into .screenshots, ignored so it can link to the shared store",
    source: "docs/artifacts.md#repository-contract",
    check: checkout => {
      const ignore = (checkout.read(".gitignore") ?? "").split("\n").map(line => line.trim());
      const script = checkout.scripts.screenshots;
      if (typeof script !== "string" && !ignore.some(line => /^(\/|\*\*\/)?\.screenshots\/?$/.test(line))) return skip("captures no screenshots");
      const found: string[] = [];
      if (typeof script !== "string") found.push("ignores .screenshots but has no screenshots package script");
      // A trailing slash matches only a directory, so the store link would show as untracked.
      if (![".screenshots", "/.screenshots", "**/.screenshots"].some(pattern => ignore.includes(pattern)))
        found.push("the root .gitignore does not list .screenshots without a trailing slash");
      return problems(found);
    },
  },
  {
    id: "screenshots-gallery",
    summary: "A website that shows captured screenshots stages them with agent-tool's screenshots build, not a copied guard",
    source: "docs/artifacts.md#repository-contract",
    check: checkout => {
      const script = checkout.scripts.screenshots;
      const websites = checkout.tracked(":(glob)**/astro.config.*");
      if (typeof script !== "string" || websites.length === 0) return skip("no website that shows captured screenshots");
      const found: string[] = [];
      const targets = object(object(checkout.agentToolJson?.screenshots)?.targets);
      if (!targets || Object.keys(targets).length === 0) found.push("agent-tool.json declares no screenshots targets");
      // A declared target proves nothing unless some build or dev script runs it.
      const scripts = checkout.tracked(":(glob)**/package.json").flatMap(file => Object.values(object(parseObject(checkout.read(file))?.scripts) ?? {}));
      if (!scripts.some(value => typeof value === "string" && /\bagent-tool\b[^&|;]*\sscreenshots build\b/.test(value)))
        found.push("no package script runs agent-tool screenshots build");
      const copies = checkout.tracked(...sourceGlobs("**/")).filter(file => !TEST_PATH.test(file) && /\bwithSharedCapture\b/.test(checkout.read(file) ?? ""));
      if (copies.length > 0) found.push(`copies the capture guard: ${copies.join(", ")}`);
      return problems(found);
    },
  },
  {
    id: "harness-permissions",
    summary: "Generated harness permission rules, checked wherever managed skills are",
    source: "docs/tooling.md#harness-permissions",
    check: checkout => {
      if (isProducer(checkout)) return skip("runs its source CLI, which the generated rules do not name");
      const found: string[] = [];
      for (const file of [".agent-tool-permissions.json", ".claude/settings.json", ".codex/rules/agent-tool.rules"]) {
        if (!checkout.exists(file)) found.push(`no ${file}; run agent-tool permissions install --apply`);
      }
      const script = checkout.scripts["agents:check"];
      if (!(typeof script === "string" && script.includes("permissions check")) && !workflows(checkout).some(text => text.includes("permissions check"))) {
        found.push("neither the agents:check script nor a workflow runs agent-tool permissions check");
      }
      return problems(found);
    },
  },
  {
    id: "import-cycle-guard",
    summary: "TypeScript or Python sources have a merge-gating guard against import cycles, type-only imports included",
    source: "docs/tooling.md#import-cycles-and-layering",
    check: checkout => {
      const exclusions = excludeManaged(checkout);
      const typescript = checkout
        .tracked(...["ts", "tsx", "mts", "cts"].map(extension => `:(glob)**/*.${extension}`), ...exclusions)
        .some(file => !/\.d\.[cm]?ts$/.test(file));
      const python = checkout.tracked(":(glob)**/__init__.py", ...exclusions).length > 0;
      if (!typescript && !python) return skip("no TypeScript sources or Python package");
      // Each language needs a guard that can read it: Biome and dependency-cruiser cannot check Python.
      const missing: string[] = [];
      if (typescript && !typescriptGuarded(checkout))
        missing.push(
          "TypeScript has no Biome noImportCycles with ignoreTypes: false, dependency-cruiser no-circular rule, agent-tool graph check, or module-graph test",
        );
      if (python && checkout.tracked(":(glob)**/test_module_graph.py").length === 0) missing.push("the Python package has no test_module_graph.py");
      return problems(missing);
    },
  },
  {
    id: "origin-ssh",
    summary: "origin fetches and pushes over SSH",
    source: "docs/health.md#github-over-ssh",
    check: checkout => {
      const found: string[] = [];
      for (const [direction, args] of [
        ["fetch", []],
        ["push", ["--push"]],
      ] as const) {
        // get-url applies insteadOf rewrites, so these are the URLs Git actually uses; --all lists every push destination.
        const urls = git(checkout.directory, ["remote", "get-url", "--all", ...args, "origin"]);
        if (urls.status !== 0) {
          found.push(`no origin ${direction} URL`);
          continue;
        }
        for (const url of urls.stdout.split("\n").filter(Boolean)) {
          if (!isGitHubSsh(url)) found.push(`origin ${direction}es over ${redact(url)}; use git@github.com:${checkout.repo}.git`);
        }
      }
      return problems(found);
    },
  },
  {
    id: "superseded-guidance",
    summary: "Markdown outside managed skills names no command a shared command replaced",
    source: "docs/audit.md#superseded-guidance",
    check: checkout => problems(supersededGuidance(checkout)),
  },
];

interface CheckoutAudit {
  readonly repo: string;
  readonly path: string;
  readonly branch?: string | null;
  readonly head?: string;
  readonly error?: string;
  readonly failed: Array<{ rule: string; detail: string }>;
  readonly skipped: Array<{ rule: string; detail: string }>;
}

export interface Audit {
  /** True when every selected rule passed or was skipped in every present checkout. */
  readonly ok: boolean;
  readonly rules: Array<Pick<Rule, "id" | "summary" | "source">>;
  /** Failing repositories by rule. */
  readonly failures: Record<string, string[]>;
  readonly checkouts: CheckoutAudit[];
}

export function selectRules(ids: string[], remote: boolean): Rule[] {
  for (const id of ids)
    if (!RULES.some(rule => rule.id === id)) throw new Error(`Unknown audit rule '${id}'. Rules: ${RULES.map(rule => rule.id).join(", ")}.`);
  return RULES.filter(rule => (ids.length > 0 ? ids.includes(rule.id) : true) && (remote || !rule.remote || ids.includes(rule.id)));
}

/** Check each checkout's working tree against the selected rules; reads local files only unless a remote rule runs. */
export function audit(root: string, repos: string[], rules: Rule[], statusOf: (repo: string) => CheckoutStatus, context: AuditContext): Audit {
  const failures: Record<string, string[]> = {};
  const checkouts = repos.map((repo): CheckoutAudit => {
    const status = statusOf(repo);
    const base = { repo, path: status.path, failed: [], skipped: [] };
    if (status.error) return { ...base, error: status.error };
    if (!status.present) return { ...base, error: "checkout missing; run sync" };
    const checkout = openCheckout(repo, checkoutPath(root, repo));
    const result: CheckoutAudit = { ...base, branch: status.branch, head: status.head, failed: [], skipped: [] };
    for (const rule of rules) {
      const outcome = rule.check(checkout, context);
      if (outcome.status === "fail") {
        result.failed.push({ rule: rule.id, detail: outcome.detail });
        failures[rule.id] = [...(failures[rule.id] ?? []), repo];
      } else if (outcome.status === "skip") result.skipped.push({ rule: rule.id, detail: outcome.detail });
    }
    return result;
  });
  return {
    ok: checkouts.every(checkout => !checkout.error && checkout.failed.length === 0),
    rules: rules.map(({ id, summary, source }) => ({ id, summary, source })),
    failures,
    checkouts,
  };
}

/** Ask the registry through Bun, which matrix already requires, when each release of a package appeared. */
export function registryReleases(name: string): Record<string, string> {
  const result = spawnSync(process.execPath, ["info", name, "time", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const times = result.error || result.status !== 0 ? undefined : parseObject(result.stdout);
  const releases = Object.fromEntries(
    Object.entries(times ?? {}).filter((entry): entry is [string, string] => EXACT_VERSION.test(entry[0]) && typeof entry[1] === "string"),
  );
  if (Object.keys(releases).length === 0) {
    throw new Error(`Could not read ${name}'s releases from the registry: ${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status}`)}`);
  }
  return releases;
}
