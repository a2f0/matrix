/** The per-project capture lock. Node built-ins only, like artifacts.ts. */
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeAtomic } from "./store";

export interface LockInfo {
  readonly pid: number;
  /** The holder's process group, which its capture's children share. */
  readonly pgid?: number;
  readonly host: string;
  readonly checkout: string;
  readonly startedAt: string;
}

export function readLock(file: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockInfo;
  } catch {
    return undefined;
  }
}

/** Whether a process, or with a negative id every process of a group, still runs. */
export function alive(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the project's capture lock. The lock is written to a private file and
 * then hard-linked into place, so it never exists without its holder. A lock
 * whose holder died is never removed automatically: two recovering processes
 * could each remove the other's fresh lock, so a person removes it.
 */
export function acquireLock(file: string, info: LockInfo): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${info.pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o644 });
  try {
    linkSync(temporary, file);
    return () => {
      if (readLock(file)?.pid === info.pid) unlinkSync(file);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw heldLockError(file, info);
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * Why an existing lock refuses this capture. Only explains: every case leaves
 * the lock in place for a person, whether its holder runs or died.
 */
function heldLockError(file: string, info: LockInfo): Error {
  const held = readLock(file);
  if (!held) return new Error(`the capture lock ${file} is unreadable; remove it once no capture is running`);
  if (held.host === info.host && !alive(held.pid)) {
    // A killed holder's capture children keep its process group and may still be writing.
    // The group can also hold the shell or agent that started it, so name it for a person to inspect; never suggest killing it.
    if (held.pgid !== undefined && alive(-held.pgid)) {
      return new Error(
        `the capture lock ${file} belongs to pid ${held.pid}, which died, but its process group ${held.pgid} still has processes that may be writing screenshots; inspect them with \`ps -o pid,command -g ${held.pgid}\`, stop any leftover capture processes, then remove the lock`,
      );
    }
    return new Error(
      `the capture lock ${file} belongs to pid ${held.pid}, which is no longer running (started ${held.startedAt} in ${held.checkout}); remove it, then capture again`,
    );
  }
  return new Error(`another capture of this project is running: pid ${held.pid} on ${held.host} in ${held.checkout} since ${held.startedAt}`);
}

/** Rewrites a lock this process holds, atomically. */
export function replaceLock(file: string, info: LockInfo): void {
  if (readLock(file)?.pid !== info.pid) throw new Error(`the capture lock ${file} is no longer this process's`);
  writeAtomic(file, `${JSON.stringify(info)}\n`, 0o644);
}
