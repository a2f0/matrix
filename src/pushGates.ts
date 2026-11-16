import { type Gh, runGh } from "./gh";
import { object } from "./packageJson";

/**
 * Push gates and base freshness (docs/tooling.md#push-gates). Pushes run only
 * quick checks, CI is the authority, and no default branch requires an
 * up-to-date branch to merge, so a red default branch is repaired as shipping
 * starts. CI on every push to the default branch is what makes it visible.
 */

/** Branch filters as GitHub reads them: one pattern or a list, `!` negating a later match. */
function patterns(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
}

/**
 * A GitHub filter pattern as a regular expression, following GitHub's filter
 * pattern cheat sheet: `*` stays within one path segment, `**` crosses them,
 * `?` and `+` make the preceding character optional or repeatable, and `[...]`
 * is a character class. A `?` or `+` with nothing to apply to is literal.
 */
function filterPattern(filter: string): RegExp {
  const tokens = filter.match(FILTER_TOKENS) ?? [];
  return new RegExp(`^${tokens.map((token, index) => filterToken(token, tokens[index - 1])).join("")}$`);
}

/** Wildcards, character classes, and single characters, in order. */
const FILTER_TOKENS = /\*\*|\*|\[[^\]]+\]|./gs;

/** One filter token as regular-expression source; `previous` decides whether a `?` or `+` has a character to apply to. */
function filterToken(token: string, previous: string | undefined): string {
  if (token === "**") return ".*";
  if (token === "*") return "[^/]*";
  const quantifiable = previous !== undefined && !["*", "**", "?", "+"].includes(previous);
  if ((token === "?" || token === "+") && quantifiable) return token;
  if (token.length > 2 && token.startsWith("[")) return `[${token.slice(1, -1).replace(/[\\\]^]/g, "\\$&")}]`;
  return token.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Whether GitHub branch filters match `branch`; the last matching pattern decides, so a later `!pattern` excludes what an earlier one included. */
export function filterMatches(filters: string[], branch: string): boolean {
  let matched = false;
  for (const filter of filters) {
    const negated = filter.startsWith("!");
    if (filterPattern(negated ? filter.slice(1) : filter).test(branch)) matched = !negated;
  }
  return matched;
}

/** The workflow's `on` value; YAML 1.1 parsers read the bare key as `true`. */
function triggers(workflow: Record<string, unknown>): unknown {
  return "on" in workflow ? workflow.on : workflow.true;
}

/**
 * Whether a parsed workflow runs on every push to `branch`: a push trigger
 * whose branch filters include it and that has no path filter, which would
 * leave pushes touching other files without a run.
 */
export function runsOnEveryPush(workflow: unknown, branch: string): boolean {
  const push = pushTrigger(workflow);
  return push !== undefined && pushFiltersAllow(push, branch);
}

/** The workflow's push trigger, `{}` when it has no filters, or undefined when pushes do not run it. */
function pushTrigger(workflow: unknown): Record<string, unknown> | undefined {
  const record = object(workflow);
  if (!record) return undefined;
  const on = triggers(record);
  if (on === "push" || (Array.isArray(on) && on.includes("push"))) return {};
  const events = object(on);
  return events && "push" in events ? (object(events.push) ?? {}) : undefined;
}

/** Whether a push trigger's filters let every push to `branch` through. */
function pushFiltersAllow(push: Record<string, unknown>, branch: string): boolean {
  return !("paths" in push || "paths-ignore" in push) && branchesAllow(push, branch);
}

/** Whether pushes to `branch` can start a parsed workflow at all, whatever its path filters. */
export function runsOnPushTo(workflow: unknown, branch: string): boolean {
  const push = pushTrigger(workflow);
  return push !== undefined && branchesAllow(push, branch);
}

/** Whether a push trigger's branch and tag filters admit pushes to `branch`. */
function branchesAllow(push: Record<string, unknown>, branch: string): boolean {
  const branches = patterns(push.branches);
  const ignored = patterns(push["branches-ignore"]);
  // A tag filter alone limits the trigger to tags.
  if (branches === undefined && ignored === undefined && ("tags" in push || "tags-ignore" in push)) return false;
  if (branches !== undefined) return filterMatches(branches, branch);
  if (ignored !== undefined) return !filterMatches(ignored, branch);
  return true;
}

/** A workflow's name as GitHub and `merge.requiredChecks` give it: its `name`, or its path without one. */
export function workflowName(workflow: unknown, file: string): string {
  const name = object(workflow)?.name;
  return typeof name === "string" ? name : file;
}

/** Jobs that deploy or publish, by their id or name. */
const SHIPPING_JOB = /deploy|publish/i;

/**
 * Steps that run a test runner, or a package script named for validation,
 * which conventionally runs the tests. A `ci` script needs `run`, since
 * `npm ci` and its kin install dependencies.
 */
const VALIDATION_STEP =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|verify)\b|\b(?:bun|npm|pnpm|yarn)\s+run\s+ci\b|\bbun\s+test\b|\b(?:pytest|vitest|jest)\b|\b(?:cargo|go|swift|dotnet)\s+test\b|\bgradlew\b.*\btest|\bxcodebuild\b.*\btest\b|\bturbo\s+(?:run\s+)?test/;

/** Jobs named for validation, such as `test`, `CI gate`, or `wait for CI`. */
const VALIDATION_JOB = /\b(?:tests?|checks?|verify|ci|gate)\b/i;

/** The name GitHub shows for a job's check: its `name`, or its id. */
function jobName(id: string, job: Record<string, unknown>): string {
  return typeof job.name === "string" ? job.name : id;
}

/**
 * Whether a job's check is one of `required`. A matrix job's check adds
 * ` (<values>)` and a reusable workflow's adds ` / <job>`; a name holding an
 * expression matches on the text before it.
 */
function isRequiredJob(name: string, required: string[]): boolean {
  const fixed = name.split("${{")[0]!.trim();
  const exact = !name.includes("${{");
  return required.some(check =>
    exact ? check === fixed || check.startsWith(`${fixed} (`) || check.startsWith(`${fixed} / `) : fixed !== "" && check.startsWith(fixed),
  );
}

/** A job's steps as objects. */
function steps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) return [];
  return job.steps.map(object).filter(step => step !== undefined);
}

/** A step condition that never holds: a constant false. */
const NEVER = /^\s*(?:\$\{\{\s*)?(?:false|0|''|"")(?:\s*\}\})?\s*$/;

/** Conditions that run a step only after an earlier one failed or the run was cancelled. */
const ONLY_AFTER_FAILURE = /\b(?:failure|cancelled)\(\s*\)|!\s*(?:success|always)\(\s*\)/;

/**
 * Whether a step fails its job when its work fails: no `continue-on-error`
 * other than false, and no `if` that keeps it from running on a passing run,
 * a constant false, `failure()`, `cancelled()`, `!success()`, or `!always()`.
 * Other conditions cannot be evaluated from the file, so they are trusted: a
 * test step that shares the publish step's condition, as release workflows
 * do, still gates it.
 */
function blocking(step: Record<string, unknown>): boolean {
  const excused = step["continue-on-error"] !== undefined && step["continue-on-error"] !== false;
  const condition = step.if;
  const text = typeof condition === "string" ? condition.replace(/!\s*(?:failure|cancelled)\(\s*\)/g, "") : "";
  return !excused && condition !== false && !NEVER.test(text) && !ONLY_AFTER_FAILURE.test(text);
}

/** Where a blocking step's command runs validation, or -1. */
function validationAt(step: Record<string, unknown>): number {
  return blocking(step) && typeof step.run === "string" ? step.run.search(VALIDATION_STEP) : -1;
}

/** Text in a step that deploys or publishes: its command, action, or inputs. */
const SHIPPING_STEP = /deploy|publish|release/i;

/** Where a step deploys or publishes: in its command, or anywhere when an action or its inputs do. */
function shippingAt(step: Record<string, unknown>): number {
  const run = typeof step.run === "string" ? step.run.search(SHIPPING_STEP) : -1;
  if (run !== -1) return run;
  return SHIPPING_STEP.test(JSON.stringify([step.uses ?? null, step.with ?? null])) ? 0 : -1;
}

/** Whether a needed job's steps run validation that fails it; the shipping job waits for the whole job to succeed. */
function validates(job: Record<string, unknown>): boolean {
  return steps(job).some(step => validationAt(step) !== -1);
}

/**
 * Whether a shipping job validates before it deploys or publishes: in an
 * earlier step, when the shipping step's condition still requires earlier
 * steps to succeed, or earlier in the step that ships.
 */
function validatesBeforeShipping(job: Record<string, unknown>): boolean {
  let validated = false;
  for (const step of steps(job)) {
    const validation = validationAt(step);
    const shipping = shippingAt(step);
    if (shipping === -1) validated ||= validation !== -1;
    else return (validated && successRequired(step.if) === "all") || (validation !== -1 && validation < shipping);
  }
  return validated;
}

/**
 * Whether a job that a shipping job needs validates: it is a required check,
 * is named for validation, or runs validation, and its failure is not
 * excused by `continue-on-error`.
 */
function validatingNeed(id: string, job: Record<string, unknown>, required: string[]): boolean {
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) return false;
  const name = jobName(id, job);
  return isRequiredJob(name, required) || VALIDATION_JOB.test(id) || VALIDATION_JOB.test(name) || validates(job);
}

/** Status functions; a condition with none implicitly requires everything before it to succeed. */
const STATUS_FUNCTION = /\b(?:success|failure|always|cancelled)\(\s*\)/;

/** One `&&` term that requires a needed job to have succeeded, capturing the job. */
const NEEDS_SUCCESS = /^\(*\s*needs\.([\w-]+)\.result\s*==\s*['"]success['"]\s*\)*$/;

/**
 * What a job or step condition requires to have succeeded first, following
 * GitHub: without a status function it implicitly requires everything
 * (`"all"`). With one, only a plain `&&` of terms is read, where a
 * `success()` term requires everything and a `needs.<job>.result ==
 * 'success'` term requires that job; an `||` or a negation other than `!=`,
 * `!cancelled()`, and `!failure()` could invert or bypass a term, so such a
 * condition requires nothing.
 */
function successRequired(condition: unknown): "all" | Set<string> {
  if (typeof condition !== "string" || !STATUS_FUNCTION.test(condition)) return "all";
  const plain = condition.replace(/^\s*\$\{\{|\}\}\s*$/g, "").replace(/!\s*(?:failure|cancelled)\(\s*\)/g, "true");
  if (plain.includes("||") || /!(?!=)/.test(plain)) return new Set();
  const terms = plain.split("&&").map(term => term.trim());
  if (terms.some(term => /^\(*\s*success\(\s*\)\s*\)*$/.test(term))) return "all";
  return new Set(terms.flatMap(term => NEEDS_SUCCESS.exec(term)?.[1] ?? []));
}

/** The jobs whose success a job waits for, as its condition allows. */
function gatingNeeds(job: Record<string, unknown>): string[] {
  const needs = patterns(job.needs) ?? [];
  const required = successRequired(job.if);
  return required === "all" ? needs : needs.filter(need => required.has(need));
}

/**
 * Whether shipping job `id` validates before it ships, or needs, directly or
 * through other jobs, a required check, a job named for validation, or a job
 * whose steps validate. A job that can run after a need fails does not pass
 * that need's validation on.
 */
function waitsForChecks(jobs: Record<string, unknown>, id: string, required: string[]): boolean {
  const shipping = object(jobs[id]);
  if (!shipping) return false;
  if (validatesBeforeShipping(shipping)) return true;
  const seen = new Set<string>([id]);
  const queue = gatingNeeds(shipping);
  while (queue.length > 0) {
    const current = queue.pop()!;
    const job = object(jobs[current]);
    if (seen.has(current) || !job) continue;
    seen.add(current);
    if (validatingNeed(current, job, required)) return true;
    queue.push(...gatingNeeds(job));
  }
  return false;
}

/**
 * Deploy and publish jobs in a parsed workflow that start without waiting for
 * validation, named as `id` or `id (name)`. Names and commands are all a
 * workflow shows, so this catches a shipping job that waits for nothing, not
 * one that waits for a job running too little.
 */
export function ungatedShippingJobs(workflow: unknown, required: string[]): string[] {
  const jobs = object(object(workflow)?.jobs) ?? {};
  return Object.entries(jobs).flatMap(([id, value]) => {
    const name = jobName(id, object(value) ?? {});
    if (!SHIPPING_JOB.test(`${id} ${name}`) || waitsForChecks(jobs, id, required)) return [];
    return [name === id ? id : `${id} (${name})`];
  });
}

/** What `agent-tool push-gate check` reports for a checkout, reduced to what the audit needs. */
export type PushGateResult =
  | { readonly status: "none"; readonly detail: string }
  | { readonly status: "conforms" }
  | { readonly status: "fails"; readonly problems: string[] };

/** Whether classic branch protection requires strict status checks; an unprotected branch has none. */
function classicStrict(repo: string, branch: string, gh: Gh): boolean {
  let protection: Record<string, unknown> | undefined;
  try {
    protection = object(JSON.parse(gh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`])));
  } catch (error) {
    // gh exits 1 with "Branch not protected" (HTTP 404) when no classic rule exists.
    if (!/404|not protected|Not Found/i.test((error as Error).message)) throw error;
  }
  return object(protection?.required_status_checks)?.strict === true;
}

/**
 * Where GitHub makes `branch` of `repo` require an up-to-date branch before
 * merging: classic protection's strict status checks, and each active
 * ruleset rule with a strict required-status-check policy.
 */
export function strictFreshness(repo: string, branch: string, gh: Gh = runGh): string[] {
  const found = classicStrict(repo, branch, gh) ? ["classic branch protection"] : [];
  const rules = JSON.parse(gh(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`])) as unknown;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const record = object(rule);
    if (record?.type !== "required_status_checks") continue;
    if (object(record.parameters)?.strict_required_status_checks_policy === true) found.push(`ruleset ${String(record.ruleset_id)}`);
  }
  return [...new Set(found)];
}
