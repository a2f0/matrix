#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runGh } from "../../../src/gh";
import { loadManifest } from "../../../src/manifest";
import { selectDay } from "./day.js";
import { buildReport } from "./github.js";

const USAGE = `Usage: bun run merged-commits [today|yesterday|YYYY-MM-DD] [--timezone IANA]

Count original commits in merged PRs across matrix.json repositories, with
separate totals including this workspace. Run from the matrix root with gh
authenticated. The default day is today in the machine's local timezone.
Prints JSON with per-PR evidence; does not change repositories or GitHub.
`;

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { timezone: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1) throw new Error(USAGE);
  const day = selectDay(positionals[0] ?? "today", values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, new Date());
  const { repos } = loadManifest(process.cwd());
  const workspace = runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  console.log(JSON.stringify(buildReport(repos, workspace, day), null, 2));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
