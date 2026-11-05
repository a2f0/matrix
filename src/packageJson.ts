/** Reading JSON objects, such as package.json and agent-tool.json, without trusting their shape. */

export const AGENT_TOOL = "@a2f0/agent-tool";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value when it is a plain JSON object, else undefined. */
export function object(value: unknown): Record<string, unknown> | undefined { return isObject(value) ? value : undefined; }

/** Parse JSON source that should hold an object; missing, malformed, or other JSON gives undefined. */
export function parseObject(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  try { return object(JSON.parse(source)); } catch { return undefined; }
}

/** The version range a package manifest declares for `name`, from devDependencies or dependencies. */
export function dependency(manifest: Record<string, unknown> | undefined, name: string): string | undefined {
  for (const field of ["devDependencies", "dependencies"]) {
    const version = object(manifest?.[field])?.[name];
    if (typeof version === "string") return version;
  }
  return undefined;
}
