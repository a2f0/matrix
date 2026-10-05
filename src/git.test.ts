import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitOutput } from "./git";

let temporary: string;
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

test("reads Git output larger than the default child process buffer", () => {
  temporary = mkdtempSync(path.join(tmpdir(), "matrix-git-"));
  const content = "a".repeat(3 * 1024 * 1024);
  writeFileSync(path.join(temporary, "large.txt"), content);
  execFileSync("git", ["init", "-q"], { cwd: temporary });
  const blob = execFileSync("git", ["hash-object", "-w", "large.txt"], { cwd: temporary, encoding: "utf8" }).trim();
  expect(gitOutput(temporary, ["cat-file", "blob", blob])).toBe(content);
});
