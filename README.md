# matrix

An agent workspace for making one change across many repositories. It keeps a
fresh clone of every managed repository under `checkouts/`, separate from the
clones you work in day to day, so one coordinating agent can sweep them all
without touching in-progress work.

```text
matrix.json          Managed repositories and discovery settings
checkouts/<name>/    One clone per repository (gitignored)
src/                 The matrix CLI: sync, status, discover
AGENTS.md            Coordinator rules for sweeps
```

## Setup

Requires Bun 1.4.2, Git, and an authenticated `gh` for discovery.

```sh
bun install --frozen-lockfile
bun run sync
bun run status
```

## Commands

| Command | Behavior |
| --- | --- |
| `bun run sync [repo...]` | Clone missing checkouts, fetch all, fast-forward clean default branches |
| `bun run status [repo...]` | Report branch, local changes, and distance from origin's default branch |
| `bun run discover [--apply]` | Compare `matrix.json` with the owner's repositories; `--apply` adds new ones |

Repositories are named as `owner/name` or by checkout name; none selects all.
Output is JSON for coordinating agents; `sync` also prints progress to stderr
and exits non-zero when any repository errors.

`sync` never resets, stashes, or deletes. For an existing checkout it verifies
that `origin` is the managed repository, fetches, and refreshes `origin/HEAD`.
It fast-forwards only when the default branch is checked out with no local
changes. A dirty checkout, another branch, a detached HEAD, or unpushed local
commits are reported as `skipped`, and a fast-forward that would overwrite
ignored local files fails instead. Git hooks and fsmonitor are disabled for
these operations; configured filter drivers such as Git LFS still run.

`status` reads local state only. A checkout is `ready` when it is on origin's
default branch at its last fetched commit with no local changes; `ahead` and
`behind` compare HEAD with that branch. Entries under `checkouts/` that the
manifest does not manage are listed as `unmanaged` and left alone.

## Managed repositories

`matrix.json` is the source of truth:

```json
{
  "schemaVersion": 1,
  "protocol": "ssh",
  "discover": { "owner": "a2f0", "visibility": "public", "exclude": ["a2f0/matrix"] },
  "repos": ["a2f0/a2f0.net", "a2f0/tearleads"]
}
```

`protocol` selects SSH or HTTPS URLs for new clones; existing checkouts may use
either. `discover` lists the owner's non-fork, unarchived repositories with the
given visibility (`public`, `private`, or `all`) and adds new ones in name
order. Managed repositories that discovery no longer finds are reported as
`notDiscovered` but stay managed, so repositories added by hand are preserved.
Remove a repository by editing `repos`; its checkout is then reported as
unmanaged until you delete it.

## Sweeps

Start a harness at the workspace root and describe the change:

> Make sure every repository's package manifests declare `"license": "UNLICENSED"`.
> Open a PR per repository; do not merge.

`AGENTS.md` defines the procedure: sync and check status, read each checkout's
own guidance, use one branch name per sweep, validate and independently review
each repository, stop at open PRs unless merging is authorized, and report a
per-repository ledger. Each repository ships under its own policy and pinned
agent-tool; matrix never overrides a repository's rules.

The shared skills come from the pinned
[agent-tool](https://github.com/a2f0/agent-tool) dependency. After changing the
pin, run `bun run agents:sync` and commit the updated skills.

## Development

```sh
bun run typecheck
bun test
bun run agents:check
```

Tests build temporary local Git remotes and make no network calls.
`bunfig.toml` limits `bun test` to `src`, so it never runs the checkouts' suites.
