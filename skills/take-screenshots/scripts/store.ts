/** The shared store's layout, and the file primitives every part of it writes with. Node built-ins only, like artifacts.ts. */
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The link every clone carries, and the directory its capture writes. */
export const LINK = ".screenshots";

/** Held for the length of one capture, beside the shared directory. */
export const LOCK = ".capture.lock";

export interface Target {
  readonly name: string;
  readonly root: string;
  readonly project: string;
  readonly repo?: string;
  /** GitHub confirmed `repo`; false when it came from origin's URL alone. */
  readonly verified?: boolean;
  /** origin's URL name when GitHub reported another (a rename or other casing). */
  readonly alias?: string;
  /** --project chose the namespace; nothing may substitute another. */
  readonly explicit?: boolean;
  /** GitHub's node id for `repo`, which survives renames and transfers. */
  readonly id?: string;
}

export function storeDir(target: Target, artifacts: string): string {
  return path.join(artifacts, target.project, "screenshots");
}

export function lexists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces a file through a private, hidden temporary file beside it, so a
 * reader never sees half a file and concurrent writers never share one.
 */
export function writeAtomic(file: string, text: string, mode?: number): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  writeFileSync(temporary, text, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
  renameSync(temporary, file);
}
