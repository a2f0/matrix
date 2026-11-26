#!/usr/bin/env bun
// Count the original commits behind PRs merged across the matrix on one day.
// The report lives with the merged-commits skill; see skills/merged-commits/SKILL.md.
import { run } from "../../skills/merged-commits/scripts/count";

process.exitCode = run(process.argv.slice(2));
