---
name: space-cleanup
description: Free disk space safely in a repository, across a matrix workspace and its checkouts, or in this machine's developer caches, by removing only regenerable, git-ignored output after a dry run. Use when the disk is low, `bun run health` asks for space, a command fails with ENOSPC, or the user asks to clean up space; not for deleting clones, branches, or anyone's work.
---

# Space Cleanup

Free space by removing what a command can rebuild, never what a person made.
Measure first, remove the cheapest tier that frees enough, and report what
was freed from the volume's real free space, not from the estimate.

## Run it

The script lives beside this file and needs only Bun (or the pinned Bun of
the repository you are in). It is a dry run until `--apply`.

- From a matrix workspace: `bun run space [checkout...] [flags]`. With no
  names it covers the workspace and every checkout in `checkouts/`; names are
  checkout names or `owner/name`.
- From a single checkout, inside or outside a matrix, or any other
  repository: `bun <skill-dir>/scripts/space-cleanup.ts [path...] [flags]`,
  where `<skill-dir>` is this skill's directory (for example
  `~/.agents/skills/space-cleanup` or `~/.claude/skills/space-cleanup`). With
  no paths it covers only the repository holding the working directory.

Caches are always included; each other flag adds its own tier independently:

| Flag | Removes | Cost to restore |
| --- | --- | --- |
| (default) | Caches: `.turbo`, `node_modules/.cache` and `.vite`, `.next/cache`, `.wrangler/tmp`, coverage, test reports, Python caches | Next run is slower |
| `--builds` | Build output: `dist`, `build`, `out`, `.next`, `.gradle`, `.build`, Rust `target`, `*.tsbuildinfo` | The repository's build |
| `--deps` | `node_modules`, `.venv`, CocoaPods `Pods`, `vendor/bundle` | The repository's documented install |
| `--machine` | Xcode DerivedData (not its `SourcePackages` clones), `brew cleanup`, Bun and npm caches, `pnpm store prune` | Re-downloads and rebuilds |

`--json` gives agents the same report. `--include-busy` cleans repositories
other processes are working in; use it only after confirming those processes
are your own or finished.

## Procedure

1. Check the volume: `df -h .` (on macOS, `df -h /System/Volumes/Data`). Note
   how much the task needs; matrix sweeps want 50 GiB free.
2. Run the dry run with `--builds --deps --machine` to see every tier's size,
   then choose the cheapest set of tiers that frees enough. Default caches
   alone are always fine to apply.
3. Apply with only the chosen flags plus `--apply`. Read the `Free: before ->
   after` line; APFS clones and hard links mean freed space can be far less
   than the listed sizes, and Time Machine local snapshots can hold it until
   macOS thins them.
4. After `--deps`, reinstall dependencies in each cleaned repository that will
   be used next, with its documented setup, so hooks and `status` keep
   working. Deleting `node_modules` also deletes a local agent-tool, so where
   setup runs `bun run agent-tool bun install`, first bootstrap with the
   repository's pinned Bun: `bun install --frozen-lockfile`.
   After `--builds`, nothing is needed: the next build regenerates output.
5. Report the before and after free space, the tiers applied, repositories
   skipped as busy, and the `review` items from `--machine` with their sizes,
   so the user can decide about them.

## Safety rules

The script enforces these; keep them when cleaning by hand:

- Remove a repository path only when git reports it ignored, nothing under it
  is tracked (rechecked just before removal), its name is on the tier's list,
  nothing under it is a repository, `.env` file, `.secrets`, or SQLite
  database, and neither it nor any parent inside the repository is a symlink. Untracked files that are not ignored
  belong to someone: never remove them.
- Never run `git clean` (`-X` included), `rm -rf` on a whole ignored tree, or
  delete `.env*`, `.secrets`, `.wrangler/state`, local databases, or anything
  under `../matrix-secrets`.
- Skip a repository another process is working in (a dev server, a test run,
  another agent session). Idle shells and the session running the script do
  not count. When processes cannot be listed, the script stops instead of
  guessing.
- Never delete clones, worktrees, branches, stashes, Docker data, Gradle
  caches, simulator devices (unavailable ones included: they keep app data),
  or iOS DeviceSupport on your own: the `--machine`
  report lists the large ones as `review` for the user to decide.
- Package caches wait while an install runs, and DerivedData waits for Xcode.
- In a matrix workspace, cleaning ignored output does not change any
  checkout's git state, so it is not a sweep and needs no ledger; a checkout's
  `status` need not be `ready`.

## Ownership

matrix (`a2f0/matrix`) owns this skill at `skills/space-cleanup/`;
`~/.claude/skills/space-cleanup` and `~/.agents/skills/space-cleanup` link to
it in the primary matrix clone, so every repository and harness sees the same
copy. Change it there, with its tests in `src/spaceCleanup.test.ts`, rather
than copying it into a checkout.
