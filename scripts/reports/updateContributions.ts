#!/usr/bin/env bun
// Count pre-squash commits per day across the matrix into the profile repository's
// contributions history, backfilling missed days, and render its README grid.
import { run } from "./contributions/update";

process.exitCode = run(process.argv.slice(2));
