#!/usr/bin/env bun
import { main } from "./cli";

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
