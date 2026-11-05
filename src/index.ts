#!/usr/bin/env bun
import { main } from "./cli";
import { errorMessage } from "./text";

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`Error: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
