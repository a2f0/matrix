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
 * which conventionally runs the tests. A runner's arguments stay within its
 * own command. A `ci` script needs `run`, since
 * `npm ci` and its kin install dependencies.
 */
const VALIDATION_STEP =
  /\b(?:bun|npm|pnpm|yarn)[ \t]+(?:run[ \t]+)?(?:test|check|verify)\b|\b(?:bun|npm|pnpm|yarn)[ \t]+run[ \t]+ci\b|\bbun[ \t]+test\b|\b(?:pytest|vitest|jest)\b|\b(?:cargo|go|swift|dotnet)[ \t]+test\b|\bgradlew\b[^;&|\n]*\b(?:test|check|test\w*UnitTest|connected\w*AndroidTest)\b|\bxcodebuild\b[^;&|\n]*\btest\b|\bturbo[ \t]+(?:run[ \t]+)?test\b/;

/**
 * A validation command where a command starts: at the script's start or after
 * a newline, `;`, or `&&`, past `NAME=value` assignments, with an optional
 * `npx`/`bunx` or path prefix. Group 1 is the command.
 */
const VALIDATION_COMMAND = new RegExp(String.raw`(?:^|[;\n]|&&)[ \t]*(?:\w+=\S*[ \t]+)*((?:(?:npx|bunx)[ \t]+)?(?:\S*/)?(?:${VALIDATION_STEP.source}))`, "d");

/**
 * A step's script, trimmed, with each line continuation (a backslash ending a
 * line) joined into one line as the shell reads it, keeping every other
 * character where it was.
 */
function script(step: Record<string, unknown>): string {
  return typeof step.run === "string" ? step.run.trim().replace(/\\\r?\n/g, text => " ".repeat(text.length)) : "";
}

/** A script with quoted text and comments blanked out, keeping every other character where it was. */
function executable(run: string): string {
  const blank = (text: string) => " ".repeat(text.length);
  return run.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, blank).replace(/(^|[ \t])#.*$/gm, (text, lead: string) => lead + blank(text.slice(lead.length)));
}

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

/** Characters outside plain commands: pipes, `||`, background `&`, grouping, substitution, negation, and redirection. */
const SHELL_SYNTAX = /[|&`()!{}<>]/;

/** Shell keywords and builtins that change control flow or error handling, where a command starts. */
const SHELL_CONTROL = /(?:^|;)\s*(?:if|then|else|elif|fi|while|until|do|done|case|esac|for|select|function|trap|exit|return|eval|exec|source|set)(?=[\s;]|$)/m;

/**
 * Whether a script is plain commands, separated by newlines, `;`, or `&&`, so
 * its exit status follows its commands'. Anything else (conditionals, loops,
 * `||`, pipes, substitution, `set`) could keep a failure from failing the step,
 * and a file cannot show which, so such a script validates nothing.
 * Workflow expressions and `${NAME}` variables are plain words.
 */
function plainScript(run: string): boolean {
  const text = run
    .replace(/\$\{\{[\s\S]*?\}\}/g, "x")
    .replace(/\$\{\w+\}/g, "x")
    .replace(/&&/g, ";");
  return !SHELL_SYNTAX.test(text) && !SHELL_CONTROL.test(text);
}

/** Whether a step's resolved shell stops at the first failed command: GitHub's default bash and sh run with `-e`. */
function stopsOnError(step: Record<string, unknown>): boolean {
  return step.shell === undefined || step.shell === "bash" || step.shell === "sh";
}

/** Where a step's script runs a validation command, outside comments and quoted text, or -1, whether or not it can fail the step. */
function namedValidationAt(step: Record<string, unknown>): number {
  if (typeof step.run !== "string") return -1;
  return VALIDATION_COMMAND.exec(executable(script(step)))?.indices?.[1]?.[0] ?? -1;
}

/**
 * Where a step's command runs validation whose failure fails the step, or -1.
 * A plain script of one command fails its step in any shell; with more, the
 * shell must stop at the first failure, and the validation must not sit in an
 * `&&` list that more commands follow, since `-e` ignores failures there.
 */
function validationAt(step: Record<string, unknown>): number {
  const at = namedValidationAt(step);
  const run = script(step);
  if (at === -1 || !blocking(step) || !plainScript(run)) return -1;
  if (!/[;\n]|&&/.test(run)) return at;
  if (!stopsOnError(step)) return -1;
  return run.includes("&&") && /[;\n]/.test(run.slice(at)) ? -1 : at;
}

/** Words that name deploying or publishing. */
const SHIPPING_WORD = /deploy|publish|release/i;

/** Commands that never ship, whatever their arguments name, such as `cd packages/release`. */
const NEUTRAL_COMMANDS = new Set([
  "cd",
  "echo",
  "printf",
  "mkdir",
  "ls",
  "cat",
  "export",
  "test",
  "[",
  "pushd",
  "popd",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "tar",
  "grep",
  "find",
]);

/** Words that run the command after them. */
const WRAPPERS = new Set(["npx", "bunx", "sudo", "exec", "time", "env"]);

/** Package managers whose `run`, `x`, `exec`, or `dlx` names the command or script after it. */
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn", "deno"]);

/**
 * Whether one command deploys or publishes, by the first words that name what
 * it runs, past assignments, wrappers, options, and a package manager's
 * `run`: `npm publish`, `wrangler deploy`, `bun run deploy`, or a release
 * script, but not `cargo build --release` or `echo Preparing release`.
 */
function namesShipping(command: string): boolean {
  let words = command.trim().split(/\s+/);
  while (words.length > 0 && (/^\w+=/.test(words[0]!) || WRAPPERS.has(words[0]!))) words = words.slice(1);
  if (words.length === 0 || NEUTRAL_COMMANDS.has(words[0]!)) return false;
  // Options can come before a subcommand (`npm --prefix web publish`), so read the first non-option words.
  const plain = words.filter(word => !word.startsWith("-"));
  const named = RUNNERS.has(plain[0]!) ? plain.slice(1).filter(word => !["run", "x", "exec", "dlx"].includes(word)) : plain;
  return named.slice(0, 4).some(word => SHIPPING_WORD.test(word));
}

/** Where a script's first shipping command starts, outside comments and quoted text, or -1. */
function shippingCommandAt(run: string): number {
  for (const command of executable(run).matchAll(/[^;\n|&]+/g)) if (namesShipping(command[0])) return command.index;
  return -1;
}

/** Action inputs that hold a command, such as wrangler-action's `command`. */
const COMMAND_INPUT = /^(?:command|commands|script|run|cmd|args)$/i;

/** Where a step deploys or publishes: a shipping command in its script, or anywhere when its action or a command input names one. */
function shippingAt(step: Record<string, unknown>): number {
  if (typeof step.run === "string") return shippingCommandAt(script(step));
  const inputs = Object.entries(object(step.with) ?? {}).flatMap(([key, value]) => (COMMAND_INPUT.test(key) && typeof value === "string" ? [value] : []));
  return (typeof step.uses === "string" && SHIPPING_WORD.test(step.uses)) || inputs.some(namesShipping) ? 0 : -1;
}

/** Whether a needed job's steps run validation that fails it; the shipping job waits for the whole job to succeed. */
function validates(job: Record<string, unknown>): boolean {
  return steps(job).some(step => validationAt(step) !== -1);
}

/**
 * Whether a shipping job validates before every step that deploys or
 * publishes: in an earlier step, when that step's condition still requires
 * earlier steps to succeed, or earlier in the same step. With no step
 * recognizably shipping, any validation in the job counts.
 */
function validatesBeforeShipping(job: Record<string, unknown>): boolean {
  let validated = false;
  let shipped = false;
  // A step that cannot run on this push neither ships nor validates, so a job whose shipping steps all cannot ships nothing.
  const runnable = steps(job).filter(step => step.if !== false);
  if (runnable.length < steps(job).length && !runnable.some(step => shippingAt(step) !== -1) && steps(job).some(step => shippingAt(step) !== -1)) return true;
  for (const step of runnable) {
    const validation = validationAt(step);
    const shipping = shippingAt(step);
    if (shipping !== -1 && !shipsAfter(validated, step, validation, shipping)) return false;
    shipped ||= shipping !== -1;
    validated ||= validation !== -1;
  }
  return shipped || validated;
}

/** Whether a shipping step ships only after validation: an earlier step's, which its condition waits for, or its own, earlier in its command. */
function shipsAfter(validated: boolean, step: Record<string, unknown>, validation: number, shipping: number): boolean {
  return (validated && successRequired(step.if) === "all") || (validation !== -1 && validation < shipping);
}

/**
 * Whether a job that a shipping job needs validates: it runs validation that
 * can fail it, or, running none that cannot, is a required check or is named
 * for validation; and `continue-on-error` does not excuse its failure.
 */
function validatingNeed(id: string, job: Record<string, unknown>, required: string[]): boolean {
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) return false;
  if (validates(job)) return true;
  // A job whose validation cannot fail it validates nothing, whatever its name.
  if (steps(job).some(step => namedValidationAt(step) !== -1)) return false;
  const name = jobName(id, job);
  return isRequiredJob(name, required) || VALIDATION_JOB.test(id) || VALIDATION_JOB.test(name);
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
  const queue = successNeeds(shipping);
  while (queue.length > 0) {
    const current = queue.pop()!;
    const job = object(jobs[current]);
    if (seen.has(current) || !job) continue;
    seen.add(current);
    if (validatingNeed(current, job, required)) return true;
    queue.push(...successNeeds(job));
  }
  return false;
}

/** A `defaults.run.shell` setting. */
function defaultShell(scope: Record<string, unknown> | undefined): unknown {
  return object(object(scope?.defaults)?.run)?.shell;
}

/** One `&&` term comparing the event or ref to a literal: field, operator, value. */
const CONTEXT_TERM = /^\(*\s*github\.(event_name|ref|ref_name)\s*(==|!=)\s*'([^']*)'\s*\)*$/;

/** Whether one `&&` term is false on a push to `branch`: a constant false, or a context comparison the push fails. */
function falseOnPush(term: string, branch: string): boolean {
  if (NEVER.test(term.replace(/^[\s(]*|[\s)]*$/g, ""))) return true;
  const match = CONTEXT_TERM.exec(term.trim());
  if (!match) return false;
  const [, field, operator, value] = match;
  const actual = field === "event_name" ? "push" : field === "ref" ? `refs/heads/${branch}` : branch;
  // GitHub compares strings without regard to case.
  const equal = value!.toLowerCase() === actual.toLowerCase();
  return operator === "==" ? !equal : equal;
}

/** A position in a condition being read, and the branch the push targets. */
interface Cursor {
  readonly text: string;
  readonly branch: string;
  at: number;
}

/** Consume `token` after any spaces, if it comes next. */
function accept(cursor: Cursor, token: string): boolean {
  while (/\s/.test(cursor.text[cursor.at] ?? "")) cursor.at++;
  if (!cursor.text.startsWith(token, cursor.at)) return false;
  cursor.at += token.length;
  return true;
}

/** `a || b`: false on the push only when every alternative is. */
function readOr(cursor: Cursor): boolean {
  let never = readAnd(cursor);
  while (accept(cursor, "||")) never = readAnd(cursor) && never;
  return never;
}

/** `a && b`: false on the push when any term is. */
function readAnd(cursor: Cursor): boolean {
  let never = readUnary(cursor);
  while (accept(cursor, "&&")) never = readUnary(cursor) || never;
  return never;
}

/** A negation, which could invert anything and so is never read as false, a group, or a comparison. */
function readUnary(cursor: Cursor): boolean {
  if (accept(cursor, "!")) {
    readUnary(cursor);
    return false;
  }
  if (accept(cursor, "(")) {
    const never = readOr(cursor);
    accept(cursor, ")");
    return never;
  }
  return falseOnPush(readTerm(cursor), cursor.branch);
}

/** Whether a term ends at `at`: an `&&`, `||`, or closing parenthesis outside the term's own calls. */
function termEnds(text: string, at: number, depth: number): boolean {
  return depth === 0 && (text[at] === ")" || text.startsWith("&&", at) || text.startsWith("||", at));
}

/** Where the character after `at` lands: past a quoted string that opens there, or the next character. */
function nextAt(text: string, at: number): number {
  if (text[at] !== "'") return at + 1;
  const close = text.indexOf("'", at + 1);
  return close === -1 ? text.length : close + 1;
}

/** One comparison or call, up to the next `&&`, `||`, or closing parenthesis outside its own calls and quoted text. */
function readTerm(cursor: Cursor): string {
  const { text } = cursor;
  const start = cursor.at;
  let depth = 0;
  while (cursor.at < text.length && !termEnds(text, cursor.at, depth)) {
    if (text[cursor.at] === "(") depth++;
    if (text[cursor.at] === ")") depth--;
    cursor.at = nextAt(text, cursor.at);
  }
  return text.slice(start, cursor.at);
}

/**
 * Whether a condition cannot hold on a push to `branch`, the only run this
 * audit reads. It is parsed with GitHub's `||`, `&&`, `!`, and parentheses: a
 * constant false, such as `${{ false }}`, or a comparison of
 * `github.event_name`, `github.ref`, or `github.ref_name` to a value the push
 * does not have, is false; any other term, and any negation, might hold.
 */
function neverOnPush(condition: unknown, branch: string): boolean {
  if (condition === false || condition === 0) return true;
  if (typeof condition !== "string") return false;
  const cursor: Cursor = { text: condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"), branch, at: 0 };
  const never = readOr(cursor);
  // Text the reader could not consume leaves the condition unread.
  return !accept(cursor, ")") && cursor.text.slice(cursor.at).trim() === "" && never;
}

/**
 * The jobs a push to `branch` skips: those whose `if` that push cannot
 * satisfy, and, as GitHub skips a job whose needs were skipped, those whose
 * condition requires the success of a skipped job.
 */
function skippedOnPush(jobs: Record<string, unknown>, branch: string): Set<string> {
  const skipped = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    const job = object(jobs[id]);
    if (skipped.has(id)) return true;
    if (!job || visiting.has(id)) return false;
    visiting.add(id);
    const skip = neverOnPush(job.if, branch) || successNeeds(job).some(visit);
    if (skip) skipped.add(id);
    return skip;
  };
  for (const id of Object.keys(jobs)) visit(id);
  return skipped;
}

/** The needs whose success a job's condition requires; the job does not run when one is skipped. */
function successNeeds(job: Record<string, unknown>): string[] {
  const needs = patterns(job.needs) ?? [];
  const required = successRequired(job.if);
  return required === "all" ? needs : needs.filter(need => required.has(need));
}

/**
 * Whether a push to `branch` runs a job behind required check `check` in a
 * parsed workflow: undefined when no job there matches it (a reusable
 * workflow's check cannot be judged here), false when the workflow does not
 * run on every such push or every matching job is skipped there, by its own
 * condition or a skipped job it needs.
 */
export function checkRunsOnPush(workflow: unknown, check: string, branch: string): boolean | undefined {
  const jobs = object(object(workflow)?.jobs) ?? {};
  const matching = Object.keys(jobs).filter(id => isRequiredJob(jobName(id, object(jobs[id]) ?? {}), [check]));
  if (matching.length === 0) return undefined;
  if (!runsOnEveryPush(workflow, branch)) return false;
  const skipped = skippedOnPush(jobs, branch);
  return matching.some(id => !skipped.has(id));
}

/** A job or step, with an `if` that cannot hold on a push to `branch` written as `false`. */
function onPush(item: Record<string, unknown>, branch: string): Record<string, unknown> {
  return neverOnPush(item.if, branch) ? { ...item, if: false } : item;
}

/**
 * A workflow's jobs as a push to `branch` runs them: conditions that cannot
 * hold there written as `false`, and each step's effective shell written on it: its own,
 * its job's or workflow's `defaults.run.shell`, or `pwsh`, GitHub's default
 * on a Windows runner, which does not stop at a failed command. A runner given
 * by an expression, such as `${{ matrix.os }}`, may be Windows, so its default
 * shell is `unresolved` and treated the same way.
 */
function pushedJobs(workflow: Record<string, unknown> | undefined, branch: string): Record<string, unknown> {
  const jobs = object(workflow?.jobs) ?? {};
  return Object.fromEntries(
    Object.entries(jobs).map(([id, value]) => {
      const job = object(value);
      if (!job) return [id, value];
      const runner = JSON.stringify(job["runs-on"] ?? "");
      const fallback = /windows/i.test(runner) ? "pwsh" : runner.includes("${{") ? "unresolved" : undefined;
      const shell = defaultShell(job) ?? defaultShell(workflow) ?? fallback;
      const resolved = steps(job).map(step => onPush(step.shell === undefined && shell !== undefined ? { ...step, shell } : step, branch));
      return [id, { ...onPush(job, branch), steps: resolved }];
    }),
  );
}

/**
 * Deploy and publish jobs that a push to `branch` can start without waiting
 * for validation, named as `id` or `id (name)`. Names and commands are all a
 * workflow shows, so this catches a shipping job that waits for nothing, not
 * one that waits for a job running too little.
 */
export function ungatedShippingJobs(workflow: unknown, required: string[], branch = "main"): string[] {
  const jobs = pushedJobs(object(workflow), branch);
  return Object.entries(jobs).flatMap(([id, value]) => {
    const job = object(value) ?? {};
    const name = jobName(id, job);
    if (job.if === false || !SHIPPING_JOB.test(`${id} ${name}`) || waitsForChecks(jobs, id, required)) return [];
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
