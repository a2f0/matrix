import { type Checkout, sourceGlobs, TEST_FILE, TEST_PATH, workflows } from "./auditCheckout";
import { git } from "./git";
import { object, parseObject } from "./packageJson";

/** Biome's noImportCycles as an error that counts type-only imports, which the rule's default skips. */
function biomeGuardsCycles(config: string): boolean {
  // JSONC: drop comments outside strings, so a commented-out rule does not count.
  const active = config.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, quoted: string | undefined) => quoted ?? "");
  const rule = /"noImportCycles"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/.exec(active)?.[1];
  return rule !== undefined && /"level"\s*:\s*"error"/.test(rule) && /"ignoreTypes"\s*:\s*false/.test(rule);
}

/** The text of the innermost `{...}` object enclosing `index`, or undefined. */
function enclosingObject(text: string, index: number): string | undefined {
  let depth = 0;
  let start = index;
  for (; start >= 0; start--) {
    if (text[start] === "}") depth++;
    else if (text[start] === "{" && depth-- === 0) break;
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let end = start; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}" && --depth === 0) return text.slice(start, end + 1);
  }
  return undefined;
}

/**
 * A dependency-cruiser rule set (a named config or a module importing
 * dependency-cruiser) with an error-level no-circular rule that sees type-only
 * imports: those are dropped unless tsPreCompilationDeps is true or "specify",
 * or the swc parser, which keeps them, reads the sources.
 */
function cruiserGuardsCycles(file: string, text: string): boolean {
  const config = /(^|\/)(\.dependency-cruiser|dependency-cruiser\.config)\.[a-z]+$/.test(file) || /["']dependency-cruiser["']/.test(text);
  const typeAware = /tsPreCompilationDeps["']?\s*:\s*(true|["']specify["'])/.test(text) || /parser["']?\s*:\s*["']swc["']/.test(text);
  if (!config || !typeAware) return false;
  return [...text.matchAll(/["']no-circular["']/g)].some(match => {
    const rule = enclosingObject(text, match.index);
    return rule !== undefined && /severity["']?\s*:\s*["']error["']/.test(rule) && /circular["']?\s*:\s*true/.test(rule);
  });
}

/** Whether TypeScript sources have a guard against import cycles that sees type-only imports. */
export function typescriptGuarded(checkout: Checkout): boolean {
  const configs = (patterns: string[]) => checkout.tracked(...patterns).map(file => ({ file, text: checkout.read(file) ?? "" }));
  if (configs([":(glob)**/biome.json", ":(glob)**/biome.jsonc"]).some(({ text }) => biomeGuardsCycles(text))) return true;
  // dependency-cruiser rules can live in any module the check imports (a2f0.net keeps them in a policy file).
  const cruiser = git(checkout.directory, [
    "grep",
    "-l",
    "-z",
    "-I",
    "-F",
    "-e",
    "no-circular",
    "--",
    "*.ts",
    "*.mts",
    "*.cts",
    "*.js",
    "*.cjs",
    "*.mjs",
    "*.json",
  ]);
  if (cruiser.status !== 0 && cruiser.status !== 1) throw new Error(`git grep failed in ${checkout.repo}: ${cruiser.stderr}`);
  const candidates = cruiser.stdout.split("\0").filter(file => file && !TEST_PATH.test(file));
  if (candidates.some(file => cruiserGuardsCycles(file, checkout.read(file) ?? ""))) return true;
  if (agentToolGraphChecked(checkout)) return true;
  return checkout.tracked(":(glob)**/moduleGraph.test.ts", ":(glob)**/module-graph.test.ts").length > 0;
}

/** Whether a run-group command array (any `command` field) runs `graph check`. */
function commandRunsGraphCheck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(commandRunsGraphCheck);
  const record = object(value);
  if (!record) return false;
  const command = record.command;
  if (Array.isArray(command) && command.some((part, index) => part === "graph" && command[index + 1] === "check")) return true;
  return Object.values(record).some(commandRunsGraphCheck);
}

/**
 * agent-tool's shared check: a `graph` section in agent-tool.json, run as
 * `graph check` by a package script, a run group's command, a workflow step,
 * or a runner script under scripts/. Generated permission rules name the command too, so they never count.
 */
function agentToolGraphChecked(checkout: Checkout): boolean {
  const graph = object(checkout.agentToolJson?.graph);
  if (!Array.isArray(graph?.include) || graph.include.length === 0) return false;
  const runsIt = (text: string) => /\bgraph\s+check\b/.test(text);
  if (Object.values(checkout.scripts).some(script => typeof script === "string" && runsIt(script))) return true;
  if (workflows(checkout).some(text => text.split("\n").some(line => /^\s*(-\s*)?run:/.test(line) && runsIt(line)))) return true;
  if (checkout.tracked(":(glob)scripts/**/*.json").some(file => commandRunsGraphCheck(parseObject(checkout.read(file))))) return true;
  // A repository's own runner script passing the arguments (skyline's scripts/testing/check.ts).
  return checkout
    .tracked(...sourceGlobs("scripts/**/"))
    .filter(file => !TEST_FILE.test(file))
    .some(file => /["'`]graph["'`]\s*,\s*["'`]check["'`]/.test(checkout.read(file) ?? ""));
}
