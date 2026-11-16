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

/** Steps that run a test runner, or a package script named for validation, which conventionally runs the tests. */
const VALIDATION_STEP =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|verify|ci)\b|\bbun\s+test\b|\b(?:pytest|vitest|jest)\b|\b(?:cargo|go|swift|dotnet)\s+test\b|\bgradlew\b.*\btest|\bxcodebuild\b.*\btest\b|\bturbo\s+(?:run\s+)?test/;

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

/** Whether any of a job's steps runs validation. */
function validates(job: Record<string, unknown>): boolean {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps.some(step => {
    const run = object(step)?.run;
    return typeof run === "string" && VALIDATION_STEP.test(run);
  });
}

/** Whether a job that a shipping job needs is a required check or is named for validation. */
function validationJob(id: string, job: Record<string, unknown>, required: string[]): boolean {
  const name = jobName(id, job);
  return isRequiredJob(name, required) || VALIDATION_JOB.test(id) || VALIDATION_JOB.test(name);
}

/**
 * Whether shipping job `id` validates first, or needs, directly or through
 * other jobs, a required check, a job named for validation, or a job whose
 * steps validate.
 */
function waitsForChecks(jobs: Record<string, unknown>, id: string, required: string[]): boolean {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const job = object(jobs[current]);
    if (seen.has(current) || !job) continue;
    seen.add(current);
    if ((current !== id && validationJob(current, job, required)) || validates(job)) return true;
    queue.push(...(patterns(job.needs) ?? []));
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
