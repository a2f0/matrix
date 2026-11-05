/**
 * Heuristic signals of implicit state machines in one source file. Read-only
 * and line-based: it points a reader at files worth reading, it never decides.
 * Node built-ins only, like state-machines.ts.
 */

export type SignalKind = "flags" | "status";

export interface Signal {
  readonly kind: SignalKind;
  /** The flag names, or the status field name. */
  readonly names: string[];
  /** For status signals, the distinct string values assigned. */
  readonly values?: string[];
  /** 1-based lines where the flags are toggled or the status is assigned. */
  readonly lines: number[];
}

export interface FileReport {
  readonly path: string;
  readonly score: number;
  readonly signals: Signal[];
}

/** Source extensions the scan reads, by the comment syntax their lines use. */
const LANGUAGES: Record<string, "c" | "hash"> = {
  ".ts": "c", ".tsx": "c", ".mts": "c", ".cts": "c", ".js": "c", ".jsx": "c", ".mjs": "c", ".cjs": "c",
  ".swift": "c", ".kt": "c", ".kts": "c", ".go": "c", ".rs": "c", ".java": "c", ".dart": "c",
  ".py": "hash", ".rb": "hash", ".sh": "hash", ".bash": "hash", ".zsh": "hash",
};

/** Paths that are generated, vendored, tests, or agent skills rather than application code. */
const SKIPPED = [
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|Pods|DerivedData|\.next|\.turbo|generated|__generated__)\//,
  /(^|\/)\.(agents|claude|codex|opencode)\//,
  /(^|\/)(__tests__|__mocks__|e2e|fixtures?|test|tests)\//,
  /\.(test|spec|stories|e2e)\.[a-z]+$/,
  /_test\.(go|py)$/,
  /(^|\/)(test_[^/]*|conftest)\.py$/,
  /(Tests?|Spec)\.(swift|kt|java)$/,
  /\.d\.ts$/,
  /\.min\.[a-z]+$/,
];

export function language(file: string): "c" | "hash" | undefined {
  if (SKIPPED.some(pattern => pattern.test(file))) return undefined;
  const dot = file.lastIndexOf(".");
  return dot < 0 ? undefined : LANGUAGES[file.slice(dot).toLowerCase()];
}

/**
 * Names that read as a lifecycle or mode flag rather than a setting: `isLoading`,
 * `hasError`, `_running`, `submitting`, `show_dialog`. Settings such as
 * `darkMode` or `enabled` toggled by a user are usually independent, so a
 * bare `enabled`/`visible` does not count on its own. Nor do `cancelled` and
 * `settled`: effect cleanups and promise races set them once as guards.
 */
const FLAG = /^_*(?:(?:is|has|was|did|should|show|needs?|can)(?:[A-Z_].*)?|(?:loading|pending|running|started|starting|stopping|stopped|done|finished|complete|completed|ready|busy|saving|submitting|fetching|syncing|connecting|connected|reconnecting|initiali[sz]ed|initiali[sz]ing|cancell?ing|failed|retrying|paused|waiting|polling|uploading|downloading|refreshing|processing|in_?progress|inflight|in_?flight)(?:[A-Z_].*)?)$/;

/** Field names that hold a mode as a string. */
const STATUS = /^_*(?:status|state|phase|mode|stage|step|lifecycle|connectionState|syncState|loadState|[a-z]+(?:Status|State|Phase|Stage))$/;

function isFlag(name: string): boolean {
  return FLAG.test(name) && !/^(?:is|has|was|did|should|show|needs?|can)$/.test(name);
}

/** `setIsLoading` -> `isLoading`; `set_loading` stays as is. */
function fromSetter(name: string): string {
  return name[0].toLowerCase() + name.slice(1);
}

/** Blanks comments, which often quote code, keeping line numbers. */
export function codeLines(text: string, syntax: "c" | "hash"): string[] {
  const lines = text.split("\n");
  if (syntax === "hash") return lines.map(line => line.trimStart().startsWith("#") ? "" : line);
  // String-aware, so "/*" or "//" inside a string literal never hides code.
  // Strings are tracked per line; a template literal spanning lines is rare
  // enough in state code that a lead missed there is acceptable.
  let inBlock = false;
  return lines.map(line => {
    let out = "";
    let quote: string | undefined;
    for (let index = 0; index < line.length; index++) {
      const char = line[index], next = line[index + 1];
      if (inBlock) {
        if (char === "*" && next === "/") { inBlock = false; index++; }
        continue;
      }
      if (quote) {
        out += char;
        if (char === "\\") { out += next ?? ""; index++; } else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "/" && next === "*") { inBlock = true; index++; continue; }
      if (char === "/" && next === "/") break;
      if (char === "\"" || char === "'" || char === "`") quote = char;
      out += char;
    }
    return out;
  });
}

const BOOLEAN = String.raw`(true|false|True|False)\b`;
/** `x = true`, `this.x = false`, `self._x = True`, `x: false` (object literal), but not `==`/`===`. */
const ASSIGN = new RegExp(String.raw`(?:^|[^\w.$])(?:this\.|self\.|state\.|@)?([A-Za-z_$][\w$]*)\s*(?:=(?!=)|:)\s*` + BOOLEAN, "g");
/** `setIsOpen(true)`, `set_loading(False)`. */
const SETTER = new RegExp(String.raw`\bset_?([A-Za-z_$][\w$]*)\(\s*` + BOOLEAN, "g");
/** `const [isOpen, setIsOpen] = useState(false)` names the flag and its first value. */
const USE_STATE = /\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:React\.)?useState(?:<boolean>)?\(\s*(true|false)\s*\)/g;
/**
 * `status = "loading"`, `this.phase = 'done'`, `setStatus("error")`. Not
 * `status: "idle"`: type members and returned object literals are how an
 * explicit machine names its states, not scattered writes.
 */
const STATUS_ASSIGN = /(?:^|[^\w.$])(?:this\.|self\.|state\.|@)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*(["'`])([\w-]+)\2/g;
const STATUS_SETTER = /\bset_?([A-Za-z_$][\w$]*)\(\s*(["'`])([\w-]+)\2\s*\)/g;

/**
 * Signals in one file:
 * - `flags`: two or more lifecycle-style booleans that are each set both true
 *   and false, so their combinations encode one mode with impossible states.
 * - `status`: one string field assigned three or more distinct literal values
 *   from several places, so its transitions are scattered.
 */
export function scanText(text: string, syntax: "c" | "hash"): Signal[] {
  const flags = new Map<string, { values: Set<string>; lines: Set<number> }>();
  const statuses = new Map<string, { values: Set<string>; lines: Set<number> }>();
  const note = (map: typeof flags, name: string, value: string, line: number) => {
    const entry = map.get(name) ?? { values: new Set<string>(), lines: new Set<number>() };
    entry.values.add(value);
    entry.lines.add(line);
    map.set(name, entry);
  };
  codeLines(text, syntax).forEach((line, index) => {
    const at = index + 1;
    for (const match of line.matchAll(USE_STATE)) if (isFlag(match[1])) note(flags, match[1], match[2], at);
    for (const match of line.matchAll(ASSIGN)) if (isFlag(match[1])) note(flags, match[1], match[2].toLowerCase(), at);
    for (const match of line.matchAll(SETTER)) {
      const name = fromSetter(match[1]);
      if (isFlag(name)) note(flags, name, match[2].toLowerCase(), at);
    }
    for (const match of line.matchAll(STATUS_ASSIGN)) if (STATUS.test(match[1])) note(statuses, match[1], match[3], at);
    for (const match of line.matchAll(STATUS_SETTER)) {
      const name = fromSetter(match[1]);
      if (STATUS.test(name)) note(statuses, name, match[3], at);
    }
  });
  const signals: Signal[] = [];
  const toggled = [...flags].filter(([, entry]) => entry.values.size === 2);
  if (toggled.length >= 2) {
    signals.push({
      kind: "flags",
      names: toggled.map(([name]) => name).sort(),
      lines: [...new Set(toggled.flatMap(([, entry]) => [...entry.lines]))].sort((a, b) => a - b),
    });
  }
  for (const [name, entry] of statuses) {
    if (entry.values.size >= 3 && entry.lines.size >= 3) {
      signals.push({ kind: "status", names: [name], values: [...entry.values].sort(), lines: [...entry.lines].sort((a, b) => a - b) });
    }
  }
  return signals;
}

/** Toggled flags weigh most: each one doubles the combinations a reader must rule out. */
export function score(signals: Signal[]): number {
  return signals.reduce((total, signal) => total + (signal.kind === "flags" ? 2 * signal.names.length : signal.values!.length), 0);
}

export function scanFile(file: string, text: string): FileReport | undefined {
  const syntax = language(file);
  if (!syntax || text.length > 512 * 1024 || text.includes("\u0000")) return undefined;
  const signals = scanText(text, syntax);
  return signals.length ? { path: file, score: score(signals), signals } : undefined;
}
