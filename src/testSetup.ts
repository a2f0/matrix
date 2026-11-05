// Preloaded by `bun test` (bunfig.toml). Tests run against Git's defaults, as
// in CI: a developer's global or system config (URL rewrites, credential
// helpers, signing) must not change what Git reports to the code under test.
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTempDirs } from "./testFixtures";

const directory = mkdtempSync(path.join(tmpdir(), "matrix-test-git-"));
const global = path.join(directory, "gitconfig");
writeFileSync(global, "");
process.env.GIT_CONFIG_GLOBAL = global;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

// A hook in the preload runs after every test in every file; one registered by
// testFixtures itself would run only in the first file that imported it.
afterEach(removeTempDirs);
