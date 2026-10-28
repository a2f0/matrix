# matrix

An agent workspace for making one change across many repositories. It keeps a
fresh clone of every managed repository under `checkouts/`, separate from the
clones you work in day to day, so one coordinating agent can sweep them all
without touching in-progress work.

```text
matrix.json          Managed repositories and discovery settings
checkouts/<name>/    One clone per repository (gitignored)
src/                 The matrix CLI: sync, status, discover, audit, deploy-secrets, sweep
scripts/secrets/     Backup entrypoint for ../matrix-secrets
AGENTS.md            Coordinator rules for sweeps
```

## Quick start

Requires Bun 1.4.2 or newer, Git, and an authenticated `gh` for discovery.
[mise](https://mise.jdx.dev/) installs the development Bun version pinned in
`.mise.toml`; CI uses the same pin.

```sh
mise install
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
| `bun run audit [repo...] [--rule <id>]... [--remote]` | Check checkouts against the shared standards; `--remote` also compares agent-tool pins with the latest release |
| `bun run secrets:backup [dir] [--password-file f \| --no-password]` | Archive `../matrix-secrets`, GPG-encrypted unless `--no-password` |
| `bun run secrets:deploy [repo...] [--apply]` | Compare each repository's `ci/` secrets and variables with GitHub Actions; `--apply` sets them |
| `bun run sweep <start\|record\|report\|list\|retro>` | Record a sweep's per-repository ledger and group its friction across sweeps |

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
`behind` compare HEAD with that branch. Checkouts must be standalone, full
clones: symlinks, worktrees, and linked Git directories are rejected, and any
assume-unchanged or skip-worktree entry (including a sparse checkout) counts as
a local change that needs attention. Entries under `checkouts/` that the
manifest does not manage are listed as `unmanaged` and left alone.
For a checkout that pins `@a2f0/agent-tool`, `agentTool` compares the pin with
the version in its `node_modules`, and `staleInstalls` lists those that differ;
reinstall that checkout's dependencies, which `sync` never does.

`audit` checks each checkout's files against the standards the matrix shares:
agent guidance, ignore rules, agent-tool adoption, output capture, README
structure, brand images, and stale copies of commands that agent-tool replaced.
It reports failing repositories by rule and never changes a checkout; see
[checkout audit](docs/audit.md).

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
order. `--apply` rewrites `matrix.json` as two-space JSON with one array entry
per line; keep the file in that form so an applied change shows only the added
repositories. Managed repositories that discovery no longer finds are reported
as `notDiscovered` but stay managed, so repositories added by hand are
preserved.
Remove a repository by editing `repos`; its checkout is then reported as
unmanaged until you delete it. `AGENTS.md` describes onboarding a repository,
including adopting agent-tool in one that lacks it.

## Secrets

Secrets for every managed repository live in `../matrix-secrets`, one namespace
per repository with `staging/`, `prod/`, and `ci/` folders. Each clone links its
gitignored `.secrets` there. Backups and GitHub Actions values are managed from
this workspace; see [docs/secrets.md](docs/secrets.md). Terraform state lives
in one Cloudflare R2 bucket per repository; see
[docs/terraform-state.md](docs/terraform-state.md).

## Sweeps

Start a harness at the workspace root, so every checkout is inside its working
directory, and describe the change:

> Make sure every repository's package manifests declare `"license": "UNLICENSED"`.
> Open a PR per repository; do not merge.

`AGENTS.md` defines the procedure: sync and check status, read each checkout's
own guidance, use one `<type>/<topic>` branch per sweep, delegate at most four
repositories at a time, validate and independently review each repository,
publish a package release before the repositories whose change needs it, and
report a per-repository ledger, on a tracking issue when one is requested. Each
repository ships under its own policy and pinned agent-tool; matrix never
overrides a repository's rules.

`bun run sweep` keeps that ledger in Git's common directory, never committed,
along with the friction each repository hit: retries, fallbacks, declined
review findings, and steps that needed a person. `bun run sweep retro` groups
friction across sweeps, so a cause that recurs becomes a fix or a lesson
instead of a surprise next time. See [sweep ledgers](docs/sweeps.md).

Dependency sweeps follow the shared `update-dependencies` skill and the
[dependency maintenance guide](docs/dependency-upgrades.md). They ship through
merge and normal merge-triggered releases unless you ask for a narrower stopping
point. Upgrade evidence goes in PRs; reusable procedures and active constraints
live in each repository's maintenance docs.

The shared skills come from the exact-pinned
[`@a2f0/agent-tool`](https://www.npmjs.com/package/@a2f0/agent-tool) package,
which installs matching copies for Claude in `.claude/skills` and Codex in
`.agents/skills`; OpenCode discovers `.agents/skills` too.

[Tooling and layout](docs/tooling.md) defines shared command ownership, script
locations, and documentation structure across the matrix. Repository-specific
validation and release requirements remain in each checkout's guidance.

## Development

```sh
bun run check
```

`bun run check` runs the typecheck, tests, and managed-skill checks that CI
runs. Tests build temporary local Git remotes and make no network calls.
`bunfig.toml` limits `bun test` to `src`, so it never runs the checkouts' suites.
