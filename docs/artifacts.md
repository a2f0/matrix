# Artifacts

Screenshots take minutes to capture and need simulators, browsers, and seeded
data, so they are captured once and shared. Every clone of a repository, the
matrix checkout and day-to-day clones alike, reads the same captures from one
folder beside this workspace, `../matrix-artifacts` (normally
`~/github/matrix-artifacts`), the way [secrets](secrets.md) live in
`../matrix-secrets`. A capture in any clone updates them all, so a deploy from
another clone publishes the newest screenshots instead of stale ones, and no
clone has to recapture before it deploys. Set `MATRIX_ARTIFACTS_DIR` to use
another location.

Brand images (icons, favicons, splash screens, store graphics) are not stored
here. `agent-tool images build` renders them from the committed
`assets/brand/*.svg` in seconds, so each clone renders its own and can never
publish another branch's icons; see [brand images](../AGENTS.md#brand-images).

## Layout

```text
matrix-artifacts/
  <project>/         Named like the repository's matrix checkout
    screenshots/     Linked as each clone's gitignored .screenshots
      capture.json   Provenance of the newest capture
      ...            The repository's own capture layout
    .capture.lock    Present while a capture runs
    superseded/      Clones' older captures moved aside by link --supersede
```

It is not a Git repository and holds no secrets. Everything in it is
regenerable by capturing again, so it needs no backup.

## Commands

The commands are the [take-screenshots skill](../skills/take-screenshots/SKILL.md)'s
script. From this workspace:

```sh
bun run artifacts status [repo...]            # link state and newest capture
bun run artifacts link [repo...] [--apply] [--supersede]   # point .screenshots at the store
bun run artifacts capture <repo> [--apply] [--allow-dirty] [-- args...]
```

From any other clone, run the same script by path:
`bun ~/.agents/skills/take-screenshots/scripts/artifacts.ts <command>`. Each
is a dry run until `--apply`; `--json` prints the report as JSON. With no
names, the workspace selects every checkout that captures screenshots, and a
clone selects itself.

- `link` creates `.screenshots` as a relative symlink to
  `<project>/screenshots`. An existing `.screenshots` directory moves into an
  empty store; when both hold captures, or `.screenshots` links elsewhere, it
  stops and reports instead of choosing. After comparing the two, `--supersede`
  moves the clone's capture to `<project>/superseded/` and links it; nothing
  is deleted. It also refuses when the root
  `.gitignore` lists `.screenshots/` with a trailing slash, which does not
  match a symlink.
- `capture` runs the repository's `screenshots` package script, forwarding
  arguments after `--`, under the project's lock, so two clones never capture into the
  store at once. It refuses a clone with local changes, which would publish
  uncommitted work, unless `--allow-dirty`, which records `dirty: true` so
  builds refuse to publish it until a clean recapture. It records the commit, branch,
  whether that commit is on origin's default branch, and the outcome.
- `status` reports each clone's link and the newest capture relative to its
  HEAD: `current`, commits `behind` or `ahead`, or `diverged`. It exits 1 when
  any selected clone is not linked.

## Provenance

`capture.json` is written before the capture starts (`running`) and again when
it ends (`complete` or `failed`), atomically:

```json
{
  "schemaVersion": 1,
  "project": "tearleads",
  "repo": "a2f0/tearleads",
  "status": "complete",
  "commit": "e2a136a8d...",
  "branch": "main",
  "dirty": false,
  "merged": true,
  "args": [],
  "checkout": "/Users/a2f0/github/tearleads",
  "host": "studio",
  "startedAt": "2026-10-30T14:00:00.000Z",
  "finishedAt": "2026-10-30T14:09:12.000Z",
  "exitCode": 0
}
```

Non-empty `args` usually means a partial capture: only those screens or
layouts changed.

## Repository contract

A repository that captures screenshots:

- exposes the capture as the root package script `screenshots`, which writes
  below `<root>/.screenshots/` in a layout the repository documents;
- lists `.screenshots` in the root `.gitignore` without a trailing slash;
- clears or replaces files inside `.screenshots`, never `.screenshots` itself,
  which would replace the link with a local directory;
- never captures as part of a build or deploy: builds read `.screenshots`, and
  a build that publishes screenshots reads `.screenshots/capture.json` before
  and after copying them, failing on a `running`, `failed`, or `dirty` capture
  or a record that changed during the copy, and printing the capture's commit;
- keeps build caches honest: a cached task that copies screenshots must hash
  them through the link, or run uncached.

`bun run audit --rule screenshots-store` checks the script and ignore pattern.
[Adding capture to a repository](../skills/take-screenshots/references/adding-capture.md)
describes the shared capture conventions.

## Rules for agents

- Capture through `artifacts capture`, never by running a repository's
  `screenshots` package script directly, so the lock and provenance stay correct.
- Before a deploy that publishes screenshots, run `artifacts status` and report
  the capture's commit; recapture only when the screens it shows changed since.
- Never copy screenshots into a repository or commit them.
