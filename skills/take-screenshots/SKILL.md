---
name: take-screenshots
description: Capture a repository's app screenshots once into the shared matrix-artifacts store, so every clone builds and deploys the newest captures, and check a capture's provenance before a deploy. Use when asked to take, refresh, or check screenshots, before deploying a site or store listing that shows them, or when adding screenshot capture to a repository.
---

# Take Screenshots

Screenshots are captured once, in any clone, into
`~/github/matrix-artifacts/<project>/screenshots`. Every clone of the
repository links its gitignored `.screenshots` there, so a website deploy or
store upload in another clone publishes the same, newest captures without
recapturing. Brand images are not part of this: they render from
`assets/brand/*.svg` in each clone.

## Run it

The script lives beside this file and needs only Bun. `link` and `capture` are
dry runs until `--apply`; `--json` gives agents the report.

- From a matrix workspace: `bun run artifacts <command> [checkout...]`.
- From any clone: `bun <skill-dir>/scripts/artifacts.ts <command>`, where
  `<skill-dir>` is this skill's directory (`~/.agents/skills/take-screenshots`
  or `~/.claude/skills/take-screenshots`).

| Command | Does |
| --- | --- |
| `status [repo...]` | Link state of each clone and its newest capture relative to HEAD |
| `link [repo...] [--apply]` | Point `.screenshots` at the store; moves an existing capture into an empty store |
| `capture [repo] [--apply] [--allow-dirty] [-- args...]` | Run the repository's `screenshots` package script under the project lock and record `capture.json` |

`MATRIX_ARTIFACTS_DIR` overrides the store location.

## Procedure

1. `status` first. If the clone is not `linked`, run `link`, then
   `link --apply`. A `blocked` result names what a person must decide (two
   different captures, a link that points elsewhere, a `.screenshots/` ignore
   pattern that needs its trailing slash removed in a PR).
2. Decide whether to capture. If the newest capture is `complete`, `merged`,
   and no screens changed since its commit, reuse it: that is the point of the
   store. Recapture after UI, seed data, or capture-code changes, after a
   `failed` capture, or when asked.
3. Commit first: capture refuses a dirty tree, because the shared store would
   publish uncommitted work. `--allow-dirty` is for a local-only look; recapture
   from a commit before anyone deploys.
4. Read the repository's capture docs for prerequisites (simulators, Maestro,
   Playwright browsers, seed data, mise-pinned tools). Maestro drives one
   device at a time on this machine: check for a running `maestro` first.
5. Run `capture` as a dry run, then with `--apply` through the repository's
   output capture (`bun run agent:run --label screenshots -- bun
   <skill-dir>/scripts/artifacts.ts capture --apply`). Captures take minutes;
   run them in the background and do not start a second one for the same
   project (the lock refuses it).
6. Verify the result, not just the exit code: `status` shows `complete` at your
   commit, and spot-check a few images (open them; check light and dark, each
   layout, and the expected dimensions).
7. Report the capture's commit, whether it was partial (`args`), and which
   clones see it. Before a deploy, quote `status` for the deploying clone.

## Rules

- Never run a repository's `screenshots` package script directly for a shared
  capture; the lock and `capture.json` keep clones from publishing a partial
  or concurrent capture.
- Never commit screenshots, copy them into a repository, or delete the store.
  Never remove `.screenshots` itself; capture code clears files inside it.
- Builds and deploys never capture. A build that publishes screenshots reads
  `.screenshots/capture.json` and refuses `running` or `failed` captures.

## Adding capture to a repository

Follow `references/adding-capture.md`: the package script, ignore pattern, and
output layout every repository shares, and the Playwright (web) and Maestro
(native) patterns tearleads and nc use. matrix's audit checks it with
`bun run audit --rule screenshots-store`.

## Ownership

matrix (`a2f0/matrix`) owns this skill at `skills/take-screenshots/`, with its
tests in `src/takeScreenshots.test.ts` and the store described in
`docs/artifacts.md`. `~/.claude/skills/take-screenshots` and
`~/.agents/skills/take-screenshots` link to it in the primary matrix clone.
Change it there rather than copying it into a checkout.
