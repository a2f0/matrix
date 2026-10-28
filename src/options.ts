/** How a command-line flag takes input: a flag alone, one value, or a value per repetition. */
export type FlagKind = "boolean" | "value" | "list";

export interface Parsed {
  readonly positional: string[];
  readonly values: Record<string, string>;
  readonly lists: Record<string, string[]>;
  readonly booleans: Set<string>;
}

/** Parse `--name value`, `--name=value`, and bare flags; anything else is positional. */
export function parseOptions(args: string[], spec: Record<string, FlagKind>, command: string): Parsed {
  const parsed: Parsed = { positional: [], values: {}, lists: {}, booleans: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown ${command} option '${arg}'.`);
      parsed.positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const kind = spec[name];
    if (kind === undefined) throw new Error(`Unknown ${command} option '--${name}'.`);
    if (kind === "boolean") {
      if (equals !== -1) throw new Error(`${command} option '--${name}' takes no value.`);
      parsed.booleans.add(name);
      continue;
    }
    const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
    // A following option means the value was left out; `--name=--text` passes text that starts with dashes.
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new Error(`${command} option '--${name}' needs a value; use --${name}=<value> for one that starts with --.`);
    }
    if (kind === "list") (parsed.lists[name] ??= []).push(value);
    else if (name in parsed.values) throw new Error(`${command} option '--${name}' was given twice.`);
    else parsed.values[name] = value;
  }
  return parsed;
}

/** A positive integer option, or the default when absent. */
export function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--${name} must be a positive integer.`);
  return Number(value);
}
