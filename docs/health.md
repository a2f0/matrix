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
volume holding the checkouts, checkouts that are not ready, stale installs,
repositories to onboard or that discovery lost, failing audit rules, recurring
sweep friction without a recorded resolution, unfinished sweep entries, and
unmanaged checkout entries. JSON output has the same parts for agents;
`--markdown` is for people.

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
