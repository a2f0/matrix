import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { type Checkout, excludeManaged, openCheckout, sourceGlobs, TEST_PATH, workflows } from "./auditCheckout";
import { type CheckoutStatus, redact } from "./checkouts";
import { typescriptGuarded } from "./cycleGuards";
import { git } from "./git";
import { checkoutPath, isGitHubSsh } from "./manifest";
import { hasLink, hasSection, headings, nonBlankLines, section } from "./markdown";
import { AGENT_TOOL, compareVersions, dependency, GEMINI_POLICY_RELEASE, object, parseObject } from "./packageJson";
import { checkRunsOnPush, type PushGateResult, runsOnEveryPush, runsOnPushTo, ungatedCalls, ungatedShippingJobs, workflowName } from "./pushGates";
import { supersededGuidance } from "./superseded";
import { plural } from "./text";

/**
 * The oldest pin the sweep rules support: 0.1.21 provides `branch create`,
 * `branch push`, `pr checks --wait`, and `repo cleanup` with local pruning, so
 * guidance no longer carries fallbacks for older pins.
 */
export const MINIMUM_AGENT_TOOL = "0.1.21";

/** Where `agent-tool permissions install` writes Gemini CLI rules, from agent-tool 0.1.78 on. */
const GEMINI_POLICY = ".gemini/policies/agent-tool.toml";

/** The harnesses a permissions manifest's scope can name, as agent-tool 0.1.78 records them. */
const PERMISSION_HARNESSES = ["claude", "codex", "gemini"];

/**
 * The Gemini policy the checkout's permissions manifest records, so `permissions check` keeps it
 * current; undefined without one, or below the release that generates it, where nothing checks it.
 */
function recordedGeminiPolicy(checkout: Checkout): string | undefined {
  if (!generatesGeminiPolicy(checkout)) return undefined;
  const recorded = object(parseObject(checkout.read(".agent-tool-permissions.json"))?.gemini)?.file;
  return recorded === GEMINI_POLICY ? GEMINI_POLICY : undefined;
}

/** Whether the checkout pins an agent-tool release that generates the Gemini policy. */
function generatesGeminiPolicy(checkout: Checkout): boolean {
  const pin = dependency(checkout.packageJson, AGENT_TOOL);
  return pin !== undefined && EXACT_VERSION.test(pin) && compareVersions(pin, GEMINI_POLICY_RELEASE) >= 0;
}

/**
 * How a permissions manifest's scope treats Gemini: no scope, as before agent-tool 0.1.78, whose
 * sync installs `all`, `all`, and a non-empty list of harnesses naming it cover it; a list without
 * it is a repository's recorded choice; any other value, which no release writes, is invalid.
 */
function geminiScope(scope: unknown): "covers" | "excludes" | "invalid" {
  if (scope === undefined || scope === "all") return "covers";
  const list: unknown[] | undefined = Array.isArray(scope) ? scope : undefined;
  if (!list || list.length === 0 || !list.every(harness => typeof harness === "string" && PERMISSION_HARNESSES.includes(harness))) return "invalid";
  return list.includes("gemini") ? "covers" : "excludes";
}

/**
 * What keeps a checkout's permissions manifest from carrying the Gemini policy its rules need. A
 * missing manifest is named on its own and an unreadable one at any pin; from the release that
 * generates it, a scope covering Gemini needs its committed, recorded policy, and an older pin
 * reaches that release through agent-tool-latest.
 */
function geminiPolicyProblem(checkout: Checkout): string | undefined {
  const file = ".agent-tool-permissions.json";
  if (!checkout.exists(file)) return undefined;
  const manifest = parseObject(checkout.read(file));
  if (!manifest) return `${file} is not a JSON object; run agent-tool permissions install --apply`;
  if (!generatesGeminiPolicy(checkout)) return undefined;
  const scope = geminiScope(manifest.scope);
  if (scope === "invalid")
    return `${file} records scope ${JSON.stringify(manifest.scope)}, which names no known harnesses; run agent-tool permissions install --apply`;
  if (scope === "covers" && (!recordedGeminiPolicy(checkout) || checkout.tracked(GEMINI_POLICY).length === 0))
    return `no committed ${GEMINI_POLICY} recorded in ${file}; run agent-tool permissions install --apply`;
  return undefined;
}

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
  /** agent-tool's `push-gate check` for a checkout directory, run with the workspace's pinned agent-tool. */
  pushGate(directory: string): PushGateResult;
  /** Where GitHub requires an up-to-date branch before merging into `branch`; only remote rules call it. */
  strictFreshness(repo: string, branch: string): string[];
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

/** Where a profile repository, whose README would be its owner's GitHub profile, keeps its Quick start. */
const PROFILE_GUIDE = "docs/development.md";

/**
 * GitHub shows the README of the repository named after a user on that user's
 * profile, so such a repository may have none, leaving the profile at
 * GitHub's default. Organizations keep theirs in `.github/profile/README.md`;
 * this treats every `<owner>/<owner>` as a user's, which fits matrix's user
 * owner.
 */
function isProfile(checkout: Checkout): boolean {
  const [owner, name] = checkout.repo.toLowerCase().split("/");
  return owner === name;
}

/** Where agent-tool's push gate lives; `push-gate check` reads only this path. */
const PUSH_GATE_HOOK = "scripts/git/hooks/pre-push";

/** The source `hooks.files` installs as `pre-push`, if any. */
function installedPushHook(checkout: Checkout): unknown {
  const files = object(checkout.agentToolJson?.hooks)?.files;
  return (Array.isArray(files) ? files : []).map(object).find(file => file?.target === "pre-push")?.source;
}

/**
 * The tracked `pre-push` Git runs from a `core.hooksPath` inside the worktree,
 * such as `.githooks/pre-push`, other than the push gate's own path. Only the
 * repository's config counts: matrix's Git calls override the setting, and a
 * path in `.git` holds installed copies, not tracked hooks.
 */
function configuredPushHook(checkout: Checkout): string | undefined {
  const configured = git(checkout.directory, ["config", "--local", "--type=path", "--get", "core.hooksPath"]);
  if (configured.status !== 0 || configured.stdout === "") return undefined;
  const real = (file: string) => (existsSync(file) ? realpathSync(file) : file);
  const directory = path.relative(real(checkout.directory), real(path.resolve(checkout.directory, configured.stdout)));
  if (directory.startsWith("..") || path.isAbsolute(directory) || directory.split(path.sep)[0] === ".git") return undefined;
  const hook = path.posix.join(directory.split(path.sep).join("/"), "pre-push");
  return hook !== PUSH_GATE_HOOK && checkout.tracked(hook).length > 0 ? hook : undefined;
}

/**
 * What files alone show is wrong with a pre-push hook, before asking
 * agent-tool, which reads only the push gate's path: `hooks.files` installing
 * an untracked source or one from elsewhere, a hook manager's hook, or one
 * that `core.hooksPath` runs from the worktree.
 */
function localPushHookProblem(checkout: Checkout): string | undefined {
  const installed = installedPushHook(checkout);
  const fix = `replace it with \`agent-tool push-gate hook\` at ${PUSH_GATE_HOOK}`;
  if (typeof installed === "string" && checkout.tracked(installed).length === 0)
    return `hooks.files installs ${installed} as pre-push, but it is not tracked; ${installed === PUSH_GATE_HOOK ? "commit the output of `agent-tool push-gate hook` there" : fix}`;
  const other =
    typeof installed === "string" && installed !== PUSH_GATE_HOOK ? installed : (checkout.tracked(".husky/pre-push")[0] ?? configuredPushHook(checkout));
  return other === undefined ? undefined : `${other} is a pre-push hook outside the push gate; ${fix}`;
}

/** Each tracked workflow file, parsed; a file YAML cannot read parses as undefined. */
function parsedWorkflows(checkout: Checkout): Array<{ file: string; workflow: unknown }> {
  return checkout.tracked(".github/workflows/*.yml", ".github/workflows/*.yaml").map(file => {
    try {
      return { file, workflow: Bun.YAML.parse(checkout.read(file) ?? "") };
    } catch {
      return { file, workflow: undefined };
    }
  });
}

/** The checks `merge.requiredChecks` in agent-tool.json requires, with the workflows that run them. */
function requiredChecks(checkout: Checkout): Array<{ name: string; workflow?: string }> {
  const checks = object(checkout.agentToolJson?.merge)?.requiredChecks;
  return (Array.isArray(checks) ? checks : []).flatMap(check => {
    if (typeof check === "string") return [{ name: check }];
    const record = object(check);
    if (typeof record?.name !== "string") return [];
    return [typeof record.workflow === "string" ? { name: record.name, workflow: record.workflow } : { name: record.name }];
  });
}

/** Whether some push to the default branch runs no job behind a required check: in its named workflow or, without one, in any workflow that has its job. */
function checkSkipped(check: { name: string; workflow?: string }, parsed: Array<{ file: string; workflow: unknown }>, branch: string): boolean {
  const runs = parsed
    .filter(({ file, workflow }) => check.workflow === undefined || workflowName(workflow, file) === check.workflow)
    .flatMap(({ workflow }) => checkRunsOnPush(workflow, check.name, branch) ?? []);
  return runs.length > 0 && !runs.includes(true);
}

/** The named required-check workflows that miss some pushes to `branch`, or a note when no workflow is named and none runs on every push. */
function workflowsMissingPushes(checkout: Checkout, parsed: Array<{ file: string; workflow: unknown }>, branch: string): string | undefined {
  const fix = "add a push trigger for it with no paths filter";
  const named = [...new Set(requiredChecks(checkout).flatMap(check => check.workflow ?? []))];
  if (named.length === 0)
    return parsed.some(({ workflow }) => runsOnEveryPush(workflow, branch)) ? undefined : `no workflow runs on every push to ${branch}; ${fix}`;
  const missing = named.filter(name => !parsed.some(({ file, workflow }) => workflowName(workflow, file) === name && runsOnEveryPush(workflow, branch)));
  if (missing.length === 0) return undefined;
  const quoted = missing.map(name => `'${name}'`).join(" and ");
  return `${quoted}, which merge.requiredChecks names, ${missing.length === 1 ? "does" : "do"} not run on every push to ${branch}; ${fix}`;
}

/** Why the workflows that run the required checks, or any workflow when none are declared, miss some pushes to the default branch. */
function defaultBranchCi(checkout: Checkout): string | undefined {
  const parsed = parsedWorkflows(checkout);
  if (parsed.length === 0) return "no GitHub Actions workflow";
  const branch = checkout.defaultBranch;
  const missing = workflowsMissingPushes(checkout, parsed, branch);
  if (missing !== undefined) return missing;
  const skipped = requiredChecks(checkout)
    .filter(check => checkSkipped(check, parsed, branch))
    .map(check => `'${check.name}'`);
  if (skipped.length === 0) return undefined;
  return `required check ${skipped.join(" and ")} ${skipped.length === 1 ? "does" : "do"} not run on every push to ${branch}; let ${skipped.length === 1 ? "its job" : "their jobs"} run on each one`;
}

/** Whether a checkout has a pre-push hook or a declared push gate, so the audit spawns `push-gate check` only where it can find something. */
function hasPushHook(checkout: Checkout): boolean {
  return (
    installedPushHook(checkout) !== undefined ||
    "pushGate" in (checkout.agentToolJson ?? {}) ||
    checkout.tracked(PUSH_GATE_HOOK, ".husky/pre-push").length > 0 ||
    configuredPushHook(checkout) !== undefined
  );
}

const OUTPUT_CAPTURE_SCRIPTS = ["agent:run", "agent:logs"];

/** What the root package.json lacks of the output-capture scripts. */
function outputCaptureScriptProblems(checkout: Checkout): string[] {
  if (checkout.packageJson === undefined) return ["no root package.json for the agent:run and agent:logs scripts"];
  return OUTPUT_CAPTURE_SCRIPTS.filter(name => typeof checkout.scripts[name] !== "string").map(name => `no ${name} script`);
}

/** What AGENTS.md lacks of a shared section that must name each of `terms`. */
function guidanceSectionProblems(guidance: string | undefined, title: string, terms: readonly string[]): string[] {
  if (guidance === undefined) return [`no AGENTS.md for the ${title} section`];
  // An AGENTS.md without sections carries the same text as a paragraph.
  const sectioned = headings(guidance).some(heading => heading.level >= 2);
  const text = sectioned ? section(guidance, title) : guidance;
  if (text === undefined) return [`AGENTS.md has no ${title} section`];
  return terms.filter(term => !text.includes(term)).map(term => `${title} guidance does not mention ${term}`);
}

const STATE_MACHINES_SKILL = "explicit-state-machines";
/** The first agent-tool release that ships the explicit-state-machines skill and its scanner. */
const STATE_MACHINES_AGENT_TOOL = "0.1.51";

/** Whether the explicit-state-machines skill ships here (the producer) or is installed as a managed skill. */
function stateMachinesSkillProblems(checkout: Checkout): string[] {
  const source = `skills/${STATE_MACHINES_SKILL}/SKILL.md`;
  if (isProducer(checkout)) return checkout.tracked(source).length > 0 ? [] : [`no tracked ${source}`];
  const files = object(parseObject(checkout.read(".agent-tool-skills.json"))?.files) ?? {};
  const installed = Object.keys(files).some(file => file.endsWith(`/${STATE_MACHINES_SKILL}/SKILL.md`) && checkout.exists(file));
  return installed
    ? []
    : [
        `the ${STATE_MACHINES_SKILL} skill is not installed; pin @a2f0/agent-tool ${STATE_MACHINES_AGENT_TOOL} or later and run agent-tool skills install --apply`,
      ];
}

/** The lockfile format matrix standardizes on, and the oldest mise release that reads it. */
const MISE_LOCK_FORMAT = 4;
const MINIMUM_MISE = "2026.11.1";
const MISE_ACTION = /^jdx\/mise-action@/;

/**
 * Specifiers that resolve outside the registry, which a minimum release age
 * does not delay: protocols, relative paths, Git over SSH, and `owner/repo`
 * GitHub shorthand.
 */
const NON_REGISTRY_SPEC = /^(?:(?:workspace|file|link|portal|git|git\+[a-z]+|github|gitlab|bitbucket|https?):|\.{0,2}\/|git@|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;

/**
 * The packages of the repository owner's npm scope that a checkout installs
 * from the registry: dependencies of every kind in the root package.json and
 * its declared workspace members, except non-registry specifiers and ranges
 * that a member of that name satisfies, which install from the workspace.
 */
function ownRegistryPackages(checkout: Checkout): string[] {
  const scope = `@${checkout.repo.split("/")[0]!.toLowerCase()}/`;
  const manifests = installedManifests(checkout);
  const members = new Map(manifests.map(manifest => [manifest?.name, manifest?.version]));
  // An alias always resolves from the registry, even to a member's name.
  const local = ({ name, spec, alias }: RegistryDependency) => {
    const version = members.get(name);
    return !alias && members.has(name) && (typeof spec !== "string" || typeof version !== "string" || Bun.semver.satisfies(version, spec));
  };
  const found = new Set(
    manifests
      .flatMap(registryDependencies)
      .filter(dependency => dependency.name.startsWith(scope) && !local(dependency))
      .map(({ name }) => name),
  );
  return [...found].sort();
}

/** A dependency as the package it installs, its specifier, and whether an npm alias names it. */
interface RegistryDependency {
  readonly name: string;
  readonly spec: unknown;
  readonly alias: boolean;
}

/**
 * The root package.json and those of the workspace members its `workspaces`
 * patterns declare, less those a `!` pattern excludes, parsed.
 */
function installedManifests(checkout: Checkout): Array<Record<string, unknown> | undefined> {
  const declared = checkout.packageJson?.workspaces;
  const listed: unknown = Array.isArray(declared) ? declared : object(declared)?.packages;
  const patterns = (Array.isArray(listed) ? listed : []).filter(pattern => typeof pattern === "string");
  const globs = (negated: boolean) =>
    patterns.filter(pattern => pattern.startsWith("!") === negated).map(pattern => new Bun.Glob(pattern.replace(/^!/, "").replace(/\/+$/, "")));
  const [included, excluded] = [globs(false), globs(true)];
  const members = checkout.tracked(":(glob)**/package.json").filter(file => {
    const directory = path.posix.dirname(file);
    return file !== "package.json" && included.some(glob => glob.match(directory)) && !excluded.some(glob => glob.match(directory));
  });
  return [checkout.packageJson, ...members.map(file => parseObject(checkout.read(file)))];
}

/**
 * The dependencies of every kind a package.json installs from the registry,
 * as the package installed and its specifier: an `npm:<name>@<range>` alias
 * installs `<name>`.
 */
function registryDependencies(manifest: Record<string, unknown> | undefined): RegistryDependency[] {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(field =>
    Object.entries(object(manifest?.[field]) ?? {})
      .map(([name, spec]) => (typeof spec === "string" && spec.startsWith("npm:") ? aliasTarget(spec.slice(4)) : { name, spec, alias: false }))
      .filter(({ spec }) => !(typeof spec === "string" && NON_REGISTRY_SPEC.test(spec))),
  );
}

/** The package and range an npm alias's `<name>@<range>` names; a bare name takes any version. */
function aliasTarget(target: string): RegistryDependency {
  const at = target.indexOf("@", 1);
  return at === -1 ? { name: target, spec: "*", alias: true } : { name: target.slice(0, at), spec: target.slice(at + 1), alias: true };
}

/** Parse TOML that should hold a table; missing or malformed TOML gives undefined. */
function parseToml(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  try {
    return object(Bun.TOML.parse(source));
  } catch {
    return undefined;
  }
}

/** The `version` input of every jdx/mise-action step in a parsed workflow or composite action. */
function miseActionVersions(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(miseActionVersions);
  const record = object(node);
  if (!record) return [];
  const version = typeof record.uses === "string" && MISE_ACTION.test(record.uses) ? object(record.with)?.version : undefined;
  return [...(version === undefined ? [] : [String(version)]), ...Object.values(record).flatMap(miseActionVersions)];
}

/** What keeps the root mise config's tools from installing out of a current-format lockfile. */
function miseLockProblems(checkout: Checkout, config: string, tools: string[]): string[] {
  if (checkout.tracked("mise.lock").length === 0) return [`no tracked mise.lock beside ${config}; run mise lock`];
  const lock = parseToml(checkout.read("mise.lock"));
  if (!lock) return ["mise.lock is missing from the working tree or is not valid TOML"];
  const found: string[] = [];
  const format = lock.lockfile_version;
  if (typeof format !== "number" || format < MISE_LOCK_FORMAT)
    found.push(`mise.lock is ${typeof format === "number" ? `format ${format}` : "unversioned"}, not format ${MISE_LOCK_FORMAT}`);
  const locked = object(lock.tools) ?? {};
  const unlocked = tools.filter(tool => !(tool in locked));
  if (unlocked.length > 0) found.push(`mise.lock has no entry for ${unlocked.join(", ")}; run mise lock`);
  return found;
}

/** Workflows and composite actions that pin a jdx/mise-action `version` too old to read the lockfile format. */
function ciMiseProblems(checkout: Checkout): string[] {
  const files = checkout.tracked(
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ":(glob).github/actions/**/action.yml",
    ":(glob).github/actions/**/action.yaml",
  );
  return files.flatMap(file => {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(checkout.read(file) ?? "");
    } catch {
      return [];
    }
    const old = new Set(
      miseActionVersions(parsed)
        .map(version => version.replace(/^v/, ""))
        .filter(version => EXACT_VERSION.test(version) && compareVersions(version, MINIMUM_MISE) < 0),
    );
    return [...old].map(version => `${file} pins mise ${version}, older than ${MINIMUM_MISE}, which reads format ${MISE_LOCK_FORMAT}`);
  });
}

const ONBOARDING = "AGENTS.md#onboarding-a-repository";

/** Hermes truncates a context file past this many characters (Unicode code points), dropping its middle. */
export const AGENTS_MD_MAX_CHARS = 20_000;

/** The literal executable in a wrapper that immediately forwards through the caller's Git root. */
function forwardedScript(source: string): string | undefined {
  const commands = source
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#") && !/^set\s+-[a-zA-Z]+(?:\s+pipefail)?(?:\s+#.*)?$/.test(line));
  const root = /^(\w+)="?\$\(git\s+rev-parse\s+--show-toplevel\)"?(?:\s*\|\|\s*exit(?:\s+\d+)?)?(?:\s+#.*)?$/.exec(commands[0] ?? "");
  if (!root) return undefined;
  const helper = /^exec\s+(?:--\s+)?("?)\$(?:\{(\w+)\}|(\w+))\/([\w./-]+)\1(?:\s|$)/.exec(commands[1] ?? "");
  if (!helper?.[4] || root[1] !== (helper[2] ?? helper[3])) return undefined;
  const target = path.posix.normalize(helper[4]);
  return /^(?:\.\.(?:\/|$)|\/)/.test(target) ? undefined : target;
}

export const RULES: readonly Rule[] = [
  {
    id: "script-relative-paths",
    summary: "Shell wrappers locate their helper from the owning checkout",
    source: "docs/tooling.md#script-locations",
    check: checkout => {
      const wrappers = checkout.tracked(":(glob)**/scripts/**/*.sh", ...excludeManaged(checkout)).filter(file => {
        if (TEST_PATH.test(file)) return false;
        const target = forwardedScript(checkout.read(file) ?? "");
        if (!target) return false;
        return checkout.tracked(`:(literal)${target}`).includes(target);
      });
      return wrappers.length ? fail(`resolve the helper from the script location in ${wrappers.join(", ")}`) : pass;
    },
  },
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
    id: "no-gemini-config",
    summary: "No GEMINI.md or Gemini CLI files in .gemini/ beyond agent-tool's recorded policy; Gemini CLI reads AGENTS.md through its user settings",
    source: ONBOARDING,
    check: checkout => {
      // Gemini Code Assist reads only the root .gemini/config.yaml and styleguide.md, to configure GitHub reviews,
      // and agent-tool's generated policy is allowed where its permissions manifest records it. Its content is
      // agent-tool permissions check's to verify, which harness-permissions requires CI to run.
      const generated = recordedGeminiPolicy(checkout);
      const files = checkout
        .tracked(":(glob)**/GEMINI.md", ":(glob)**/.gemini/**")
        .filter(file => !/^\.gemini\/(config\.yaml|styleguide\.md)$/.test(file) && file !== generated);
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
    check: checkout =>
      problems([...outputCaptureScriptProblems(checkout), ...guidanceSectionProblems(checkout.read("AGENTS.md"), "Output capture", OUTPUT_CAPTURE_SCRIPTS)]),
  },
  {
    id: "state-machines",
    summary: "A State machines section in AGENTS.md naming the explicit-state-machines skill, and the skill installed",
    source: "docs/tooling.md#state-machines",
    check: checkout =>
      problems([...guidanceSectionProblems(checkout.read("AGENTS.md"), "State machines", [STATE_MACHINES_SKILL]), ...stateMachinesSkillProblems(checkout)]),
  },
  {
    id: "readme-title",
    summary: "The README's H1 is the plain project name, with no link and no link line after it; a profile repository may have no README",
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const readme = checkout.read("README.md");
      if (readme === undefined)
        return isProfile(checkout) ? skip("a profile repository with no README leaves its profile at GitHub's default") : fail("no README.md");
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
    summary: `The README has a Quick start section; a profile repository's ${PROFILE_GUIDE} has it instead`,
    source: "AGENTS.md#readme-files",
    check: checkout => {
      const file = isProfile(checkout) ? PROFILE_GUIDE : "README.md";
      const guide = checkout.read(file);
      if (guide === undefined) return fail(`no ${file}`);
      return hasSection(guide, "Quick start") ? pass : fail(`${file} has no Quick start section`);
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
      const gemini = geminiPolicyProblem(checkout);
      if (gemini) found.push(gemini);
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
    id: "mise-lock",
    summary: `mise tools install from a format ${MISE_LOCK_FORMAT} mise.lock, and CI pins mise ${MINIMUM_MISE} or newer to read it`,
    source: "docs/dependency-upgrades.md#toolchain-lockfiles",
    check: checkout => {
      const config = checkout.tracked("mise.toml", ".mise.toml")[0];
      if (config === undefined) return skip("declares no mise tools");
      const parsed = parseToml(checkout.read(config));
      if (!parsed) return fail(`${config} is missing from the working tree or is not valid TOML`);
      const tools = Object.keys(object(parsed.tools) ?? {});
      if (tools.length === 0) return skip("declares no mise tools");
      // false turns locking off, which mise-action's --locked rejects; leaving it unset keeps a committed lock current.
      const setting = object(parsed.settings)?.lockfile === false ? [`${config} sets lockfile = false`] : [];
      return problems([...setting, ...miseLockProblems(checkout, config, tools), ...ciMiseProblems(checkout)]);
    },
  },
  {
    id: "release-age-internal",
    summary: "A minimum release age exempts the owner's own registry packages",
    source: "docs/dependency-upgrades.md#release-age",
    check: checkout => {
      // Without a minimum release age, nothing is delayed.
      const install = object(parseToml(checkout.read("bunfig.toml"))?.install);
      if (typeof install?.minimumReleaseAge !== "number" || install.minimumReleaseAge <= 0) return pass;
      const excludes = install.minimumReleaseAgeExcludes;
      const excluded = new Set(Array.isArray(excludes) ? excludes : []);
      const missing = ownRegistryPackages(checkout).filter(name => !excluded.has(name));
      return missing.length === 0
        ? pass
        : fail(`bunfig.toml's minimumReleaseAge also delays ${missing.join(", ")}; list each in [install] minimumReleaseAgeExcludes, which takes exact names`);
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
    id: "push-gate",
    summary: "A tracked pre-push hook is agent-tool's push gate, declared in agent-tool.json, with no tests, builds, or installs",
    source: "docs/tooling.md#push-gates",
    check: (checkout, context) => {
      if (!hasPushHook(checkout)) return skip("no pre-push hook");
      const local = localPushHookProblem(checkout);
      if (local !== undefined) return fail(local);
      let result: PushGateResult;
      try {
        result = context.pushGate(checkout.directory);
      } catch (error) {
        // One checkout agent-tool cannot inspect fails its own rule instead of ending the audit.
        return fail(`could not run agent-tool push-gate check: ${(error as Error).message.trim().split("\n")[0]}`);
      }
      if (result.status === "none") return skip(result.detail);
      return result.status === "conforms" ? pass : problems(result.problems);
    },
  },
  {
    id: "base-freshness",
    summary: "agent-tool.json does not require an up-to-date branch to merge",
    source: "docs/tooling.md#push-gates",
    check: checkout =>
      object(checkout.agentToolJson?.merge)?.requireStrictBaseFreshness === true ? fail("merge.requireStrictBaseFreshness is true; set it to false") : pass,
  },
  {
    id: "base-freshness-settings",
    summary: "With --remote: no classic protection or active ruleset requires an up-to-date branch to merge into the default branch",
    source: "docs/tooling.md#push-gates",
    remote: true,
    check: (checkout, context) => {
      let found: string[];
      try {
        found = context.strictFreshness(checkout.repo, checkout.defaultBranch);
      } catch (error) {
        // One unreadable repository fails its own rule instead of ending the audit.
        return fail(`could not read ${checkout.defaultBranch}'s protection: ${(error as Error).message.trim().split("\n")[0]}`);
      }
      return found.length === 0
        ? pass
        : fail(`${found.join(" and ")} require${found.length === 1 ? "s" : ""} an up-to-date branch on ${checkout.defaultBranch}`);
    },
  },
  {
    id: "default-branch-ci",
    summary: "The workflows that run the required checks (any workflow without them) run on every push to the default branch",
    source: "docs/tooling.md#push-gates",
    check: checkout => {
      const problem = defaultBranchCi(checkout);
      return problem === undefined ? pass : fail(problem);
    },
  },
  {
    id: "deploys-need-checks",
    summary: "Deploy and publish jobs that pushes to the default branch start need a required check or a job that runs tests",
    source: "docs/tooling.md#base-freshness",
    check: checkout => {
      const required = requiredChecks(checkout).map(check => check.name);
      const branch = checkout.defaultBranch;
      const workflows = parsedWorkflows(checkout);
      const byFile = new Map(workflows.map(({ file, workflow }) => [file, workflow]));
      const called = (file: string) => byFile.get(file);
      // A called workflow's jobs run in its caller's push, labelled by the calls that reach them.
      const shipping = (file: string, workflow: unknown, checks: string[], via: string, seen: Set<string>, inShippingCall: boolean): string[] => [
        ...ungatedShippingJobs(workflow, checks, branch, { called, shipping: inShippingCall }).map(job => `${via}${file} ${job}`),
        ...ungatedCalls(workflow, checks, branch, inShippingCall).flatMap(call =>
          seen.has(call.path) || !byFile.has(call.path)
            ? []
            : shipping(call.path, byFile.get(call.path), call.required, `${via}${file} ${call.job} → `, new Set([...seen, call.path]), call.shipping),
        ),
      ];
      const ungated = workflows
        .filter(({ workflow }) => runsOnPushTo(workflow, branch))
        .flatMap(({ file, workflow }) => shipping(file, workflow, required, "", new Set([file]), false));
      if (ungated.length === 0) return pass;
      const verb = ungated.length === 1 ? "starts" : "start";
      return fail(`${ungated.join(", ")} ${verb} without needing a required check or a job that runs tests`);
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
  const checkouts = repos.map(repo => auditCheckout(root, repo, rules, statusOf(repo), context));
  // Rules in the order a checkout first fails them, each listing its failing repositories in checkout order.
  const failures: Record<string, string[]> = {};
  for (const { repo, failed } of checkouts) for (const { rule } of failed) failures[rule] = [...(failures[rule] ?? []), repo];
  return {
    ok: checkouts.every(checkout => !checkout.error && checkout.failed.length === 0),
    rules: rules.map(({ id, summary, source }) => ({ id, summary, source })),
    failures,
    checkouts,
  };
}

/** One checkout's outcomes, or why it could not be audited. */
function auditCheckout(root: string, repo: string, rules: Rule[], status: CheckoutStatus, context: AuditContext): CheckoutAudit {
  const base = { repo, path: status.path, failed: [], skipped: [] };
  if (status.error) return { ...base, error: status.error };
  if (!status.present) return { ...base, error: "checkout missing; run sync" };
  const checkout = openCheckout(repo, checkoutPath(root, repo), status.defaultBranch);
  const result: CheckoutAudit = { ...base, branch: status.branch, head: status.head, failed: [], skipped: [] };
  for (const rule of rules) {
    const outcome = rule.check(checkout, context);
    if (outcome.status === "fail") result.failed.push({ rule: rule.id, detail: outcome.detail });
    else if (outcome.status === "skip") result.skipped.push({ rule: rule.id, detail: outcome.detail });
  }
  return result;
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
