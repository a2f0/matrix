/** A capture's provenance record, `capture.json` in the shared directory. Node built-ins only, like artifacts.ts. */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { git, gitValue } from "./git";
import { writeAtomic } from "./store";

/** Provenance of the newest capture, inside the shared directory. */
export const RECORD = "capture.json";

export interface CaptureRecord {
  readonly schemaVersion: 1;
  readonly project: string;
  /** owner/name from origin, when it is a GitHub remote. */
  readonly repo?: string;
  readonly status: "running" | "complete" | "failed" | "incomplete";
  readonly commit: string;
  readonly branch: string | null;
  /** The working tree had changes the commit does not hold. */
  readonly dirty: boolean;
  /** HEAD was reachable from origin's default branch; null when that is unknown. */
  readonly merged: boolean | null;
  /** Arguments passed to the capture; non-empty usually means a partial capture. */
  readonly args: string[];
  /**
   * For a partial capture, the capture whose other images it kept. A partial
   * capture over a dirty or unfinished one stays dirty or `incomplete`, so
   * only a full, clean capture clears them.
   */
  readonly over?: { readonly commit: string; readonly status: CaptureRecord["status"]; readonly dirty: boolean };
  readonly checkout: string;
  readonly host: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number | null;
}

const STATUSES = new Set(["running", "complete", "failed", "incomplete"]);

/** Whether a parsed record has every field a decision reads, with the right type. */
export function validRecord(value: unknown): value is CaptureRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const over = record.over as Record<string, unknown> | undefined;
  return (
    record.schemaVersion === 1 &&
    typeof record.status === "string" &&
    STATUSES.has(record.status) &&
    typeof record.commit === "string" &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(record.commit) &&
    typeof record.dirty === "boolean" &&
    (record.merged === null || typeof record.merged === "boolean") &&
    Array.isArray(record.args) &&
    record.args.every(arg => typeof arg === "string") &&
    (record.repo === undefined || typeof record.repo === "string") &&
    typeof record.project === "string" &&
    (over === undefined ||
      (typeof over === "object" &&
        over !== null &&
        typeof over.commit === "string" &&
        typeof over.status === "string" &&
        STATUSES.has(over.status) &&
        typeof over.dirty === "boolean"))
  );
}

/** The newest capture's record; a missing or malformed one reads as no record, which is never complete. */
export function readRecord(store: string): CaptureRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(store, RECORD), "utf8"));
    return validRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Replace the record atomically, so a reader never sees half a file. */
export function writeRecord(store: string, record: CaptureRecord): void {
  mkdirSync(store, { recursive: true });
  writeAtomic(path.join(store, RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

/** Where a capture's commit sits relative to a repository's HEAD. */
export function relation(root: string, commit: string): { relation: "current" | "behind" | "ahead" | "diverged" | "unknown"; commits?: number } {
  const head = gitValue(root, "rev-parse", "HEAD");
  if (!head) return { relation: "unknown" };
  if (commit === head) return { relation: "current" };
  if (git(root, "cat-file", "-e", `${commit}^{commit}`).status !== 0) return { relation: "unknown" };
  const count = (range: string) => Number(gitValue(root, "rev-list", "--count", range) ?? NaN);
  if (git(root, "merge-base", "--is-ancestor", commit, head).status === 0) return { relation: "behind", commits: count(`${commit}..${head}`) };
  if (git(root, "merge-base", "--is-ancestor", head, commit).status === 0) return { relation: "ahead", commits: count(`${head}..${commit}`) };
  return { relation: "diverged" };
}
