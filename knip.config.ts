import type { KnipConfig } from "knip";

// knip finds the other entries itself: src/index.ts and the skill scripts
// from package.json scripts, and the test preload from bunfig.toml.
export default {
  entry: ["src/**/*.test.ts"],
  project: ["src/**/*.ts", "skills/**/*.ts"],
  // Host tools the scripts and tests run, not package dependencies.
  ignoreBinaries: ["gpg", "du", "openssl"],
  treatConfigHintsAsErrors: true,
} satisfies KnipConfig;
