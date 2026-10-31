# Health report

`bun run health` is where matrix proposes its own next work. It combines
checkout `status`, the [checkout audit](audit.md), and
[sweep retro](sweeps.md#retro) into one report with suggested next steps.
`--remote` adds GitHub discovery and the audit's registry rules.

```sh
bun run sync
bun run health --remote --markdown
```

It reads and reports only, and always exits 0; `bun run audit` is the check
that fails. Suggestions come in this order: free disk space below 50 GiB on the
volume holding the checkouts, repositories where `bun run teardown` fails,
checkouts that are not ready, stale installs,
repositories to onboard or that discovery lost, failing audit rules, recurring
sweep friction without a recorded resolution, unfinished sweep entries, and
unmanaged checkout entries. JSON output has the same parts for agents;
`--markdown` is for people.

## Leftover processes

`bun run teardown [repo...]` runs agent-tool's `teardown` for the workspace and
every present checkout (or only the named ones), with the workspace's pinned
agent-tool and `--repo`. It lists processes recorded with `agent-tool proc
start` that still run, untracked processes inside a repository that listen on a
port, kept processes, and added worktrees, and exits 1 while anything remains or
an inspection fails. `--apply` stops recorded processes that were not started
with `--keep`; untracked processes and worktrees are only reported. Inside a
single checkout, `agent-tool teardown` is the same check, and the shared
`ship-pr`, `open-pr`, and `reset` skills run it before reporting work done, in
every harness.

## Freeing disk space

`bun run space` runs the [space-cleanup skill](../skills/space-cleanup/SKILL.md)'s
script over the workspace and every checkout. It is a dry run until `--apply`,
removes only git-ignored, untracked, regenerable paths in repositories no
other process is working in, and adds build output (`--builds`), installed
dependencies (`--deps`), and machine-wide developer caches (`--machine`) only
when asked. From a single checkout or any other repository, run the skill's
script directly; the skill says how. matrix owns the skill, and
`~/.claude/skills` and `~/.agents/skills` link to it in the primary clone.

A suggestion is a proposal. Acting on one is a normal change under the request
that authorizes it: a sweep for a failing rule, a lesson PR for recurring
friction, onboarding for a new repository.

## Scheduled runs

Run the report on a schedule so drift and recurring friction surface without
anyone asking. The scheduled job runs only `bun run sync` and
`bun run health --remote --markdown` from this workspace, with the pinned Bun
first on `PATH`, and delivers the Markdown. It changes nothing else: no
branches, PRs, or issues. In Hermes, a weekly `cronjob` with that instruction
delivers the report as a message. Claude Code and Codex sessions, or a plain
cron or launchd entry that mails the output, can run the same two commands.
