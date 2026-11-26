import path from "node:path";
import { parseArgs } from "node:util";
import { runGh } from "../../../src/gh";
import { loadManifest } from "../../../src/manifest";
import { selectDay } from "./day";
import { buildReport } from "./github";

const USAGE = `Usage: bun run merged-commits [today|yesterday|YYYY-MM-DD] [--timezone IANA]
       scripts/reports/mergedCommits.ts [today|yesterday|YYYY-MM-DD] [--timezone IANA]

Count original commits in merged PRs across matrix.json repositories, with
separate totals including this workspace. Requires an authenticated gh CLI. The default day is today in the machine's local timezone.
Prints JSON with per-PR evidence; does not change repositories or GitHub.
`;

function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { timezone: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1) throw new Error(USAGE);
  const day = selectDay(positionals[0] ?? "today", values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, new Date());
  const root = path.resolve(import.meta.dir, "../../..");
  const { repos } = loadManifest(root);
  const workspace = runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root).trim();
  console.log(JSON.stringify(buildReport(repos, workspace, day), null, 2));
}

/** Print the report for `args` and return the process exit status. */
export function run(args: string[]): number {
  try {
    main(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
