import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { gitOutput } from "./git";
import { gitIn, gitInit, tempDir } from "./testFixtures";

test("reads Git output larger than the default child process buffer", () => {
  const temporary = tempDir("matrix-git");
  const content = "a".repeat(3 * 1024 * 1024);
  writeFileSync(path.join(temporary, "large.txt"), content);
  gitInit(temporary);
  const blob = gitIn(temporary, "hash-object", "-w", "large.txt");
  expect(gitOutput(temporary, ["cat-file", "blob", blob])).toBe(content);
});
