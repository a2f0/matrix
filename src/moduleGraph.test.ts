import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Guards the module layering in docs/tooling.md#import-cycles-and-layering
// for matrix itself. TypeScript 7 has no JS compiler API and
// Bun.Transpiler.scanImports drops type-only imports, so this scans import
// specifiers with a regular expression after blanking comments and template
// literals.

const ROOT = path.resolve(import.meta.dir, "..");

/** Lowest layer first; a module may import only its own layer or lower ones. */
const LAYERS: ReadonlyArray<{ name: string; files: readonly string[] }> = [
  { name: "primitives", files: ["src/git.ts", "src/manifest.ts", "src/markdown.ts", "src/options.ts"] },
  { name: "checkouts", files: ["src/checkouts.ts"] },
  { name: "commands", files: ["src/audit.ts", "src/discover.ts", "src/secrets.ts", "src/sweeps.ts"] },
  { name: "health", files: ["src/health.ts"] },
  { name: "cli", files: ["src/cli.ts"] },
  { name: "entry", files: ["src/index.ts"] },
];

const isTest = (file: string) => file.endsWith(".test.ts");

function layerOf(file: string): number {
  const index = LAYERS.findIndex(layer => layer.files.includes(file));
  if (index === -1) throw new Error(`${file} has no layer; add it to LAYERS in src/moduleGraph.test.ts.`);
  return index;
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(path.join(ROOT, directory))) return [];
  return readdirSync(path.join(ROOT, directory)).flatMap(name => {
    const relative = `${directory}/${name}`;
    if (statSync(path.join(ROOT, relative)).isDirectory()) return sourceFiles(relative);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [relative] : [];
  });
}

/**
 * Blanks comments, template-literal text, and every string that is not an import
 * specifier, keeping the code inside `${...}` interpolations, which can import too.
 */
function stripNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " "; };
  // Each entry is the brace depth of an open interpolation; template text resumes when it closes.
  const interpolations: number[] = [];
  let depth = 0;
  let i = 0;
  const skipTemplateText = () => {
    const start = i;
    while (i < source.length) {
      if (source[i] === "\\") { i += 2; continue; }
      if (source[i] === "`") { blank(start, i); i++; return; }
      if (source[i] === "$" && source[i + 1] === "{") { blank(start, i); interpolations.push(depth); depth++; i += 2; return; }
      i++;
    }
    blank(start, i);
  };
  while (i < source.length) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/") { const end = source.indexOf("\n", i); blank(i, end === -1 ? source.length : end); i = end === -1 ? source.length : end; }
    else if (char === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); const stop = end === -1 ? source.length : end + 2; blank(i, stop); i = stop; }
    else if (char === "\"" || char === "'") {
      // Only a string right after `from` or `import` is a specifier; blank the text of any other.
      const specifier = /(?:\bfrom|\bimport\s*\(?)\s*$/.test(out.slice(Math.max(0, i - 40), i).join(""));
      const start = ++i;
      while (i < source.length && source[i] !== char && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      if (!specifier) blank(start, Math.min(i, source.length));
      i++;
    }
    else if (char === "`") {
      // A substitution-free template right after `import(` is a specifier; keep it.
      const close = source.indexOf("`", i + 1);
      const literal = close === -1 ? "" : source.slice(i + 1, close);
      if (close !== -1 && !literal.includes("${") && !literal.includes("\\") && /\bimport\s*\(\s*$/.test(out.slice(Math.max(0, i - 40), i).join(""))) i = close + 1;
      else { i++; skipTemplateText(); }
    }
    else if (char === "{") { depth++; i++; }
    else if (char === "}") {
      depth--;
      i++;
      if (interpolations.at(-1) === depth) { interpolations.pop(); skipTemplateText(); }
    }
    else i++;
  }
  return out.join("");
}

const SPECIFIER = /\b(?:import|export)(?:\s+type\b)?\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function relativeImports(source: string): string[] {
  return [...stripNonCode(source).matchAll(SPECIFIER)].map(match => (match[1] ?? match[2])!).filter(specifier => specifier.startsWith("."));
}

function resolve(from: string, specifier: string): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  // TypeScript resolves `./x.js` to `x.ts`.
  return [base, base.replace(/\.[cm]?js$/, ".ts"), `${base}.ts`, `${base}/index.ts`].find(candidate => candidate.endsWith(".ts") && existsSync(path.join(ROOT, candidate)));
}

/** Each cycle once, rotated to start at its smallest module. */
function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles = new Map<string, string[]>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (file: string) => {
    const open = stack.indexOf(file);
    if (open !== -1) {
      const cycle = stack.slice(open);
      const start = cycle.indexOf(cycle.toSorted()[0]!);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      cycles.set(rotated.join(" -> "), rotated);
      return;
    }
    if (done.has(file)) return;
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    done.add(file);
  };
  for (const file of [...graph.keys()].sort()) visit(file);
  return [...cycles.values()];
}

function layerViolations(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const violations: string[] = [];
  for (const [file, targets] of graph) {
    if (isTest(file) || !file.startsWith("src/")) continue;
    for (const target of targets) {
      if (isTest(target)) violations.push(`${file} imports test-only ${target}`);
      else if (target.startsWith("src/") && layerOf(target) > layerOf(file)) {
        violations.push(`${file} (${LAYERS[layerOf(file)]!.name}) imports ${target} (${LAYERS[layerOf(target)]!.name})`);
      }
    }
  }
  return violations.sort();
}

describe("module graph", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("skills"), ...sourceFiles("scripts")];
  const graph = new Map(files.map(file => [file, new Set(relativeImports(readFileSync(path.join(ROOT, file), "utf8"))
    .map(specifier => resolve(file, specifier)).filter((target): target is string => target !== undefined))]));

  test("scans every import form, including type-only ones, and ignores comments and template literals", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      'import "./c";',
      'export * from "./d";',
      'const e = await import("./e");',
      "import {\n  f,\n  type F,\n} from './f';",
      '// import { g } from "./g";',
      '/* import { h } from "./h"; */',
      'const preload = `import { i } from "./i";`;',
      'import { j } from "node:fs";',
      'const url = "https://example.com"; import{k}from"./k";',
      'const lazy = `${(await import("./l")).name} and ${`nested ${await import("./m")}`} import "./n"`;',
      'const brace = `${ { o: 1 }.o }`; import "./p";',
      'const spaced = await import ("./q");',
      'const fixture = \'import "./r";\'; const other = "export * from \'./s\'";',
      'const literal = await import(`./t`); const dynamic = await import(`./${name}`);',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./k", "./l", "./m", "./p", "./q", "./t"]);
  });

  test("resolves extensionless, TypeScript-style .js, and index specifiers", () => {
    expect(resolve("src/cli.ts", "./audit")).toBe("src/audit.ts");
    expect(resolve("src/cli.ts", "./audit.js")).toBe("src/audit.ts");
    expect(resolve("src/cli.ts", "./missing")).toBeUndefined();
  });

  test("detects a planted cycle and a planted layer violation", () => {
    const planted = new Map([
      ["src/git.ts", new Set(["src/manifest.ts"])],
      ["src/manifest.ts", new Set(["src/git.ts", "src/health.ts"])],
      ["src/audit.ts", new Set(["src/git.test.ts"])],
    ]);
    expect(findCycles(planted)).toEqual([["src/git.ts", "src/manifest.ts"]]);
    expect(layerViolations(planted)).toEqual([
      "src/audit.ts imports test-only src/git.test.ts",
      "src/manifest.ts (primitives) imports src/health.ts (health)",
    ]);
  });

  test("has no import cycles", () => {
    expect(findCycles(graph)).toEqual([]);
  });

  test("imports only from the same or a lower layer", () => {
    expect(layerViolations(graph)).toEqual([]);
  });
});
