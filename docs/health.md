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
ways Git or gh can leave SSH for GitHub ([below](#github-over-ssh)),
checkouts that are not ready, stale installs,
repositories to onboard or that discovery lost, failing audit rules, recurring
sweep friction without a recorded resolution, unfinished sweep entries, and
unmanaged checkout entries. JSON output has the same parts for agents;
`--markdown` is for people.

## GitHub over SSH

Agents reach GitHub only over SSH. An HTTPS URL sends Git to its credential
helper, and on macOS the helper that Xcode's system gitconfig sets
(`osxkeychain`) can wait on a keychain prompt that a background agent never
answers ([#61](https://github.com/a2f0/matrix/issues/61)). When port 22 times
out, retry SSH; never rewrite GitHub URLs to HTTPS. The machine setup makes a
blocked port 22 irrelevant:

- Git runs SSH with a Git-only config that sends `github.com` to
  `ssh.github.com` on port 443, with GitHub's host keys pinned, and an empty
  `credential.https://github.com.helper` clears inherited helpers. The
  [dotfiles](https://github.com/a2f0/dotfiles) gitconfig and its Ansible
  playbook provide both.
- `gh config set git_protocol ssh`, and the same with `--host github.com`,
  whose per-host value overrides the global one, so `gh repo clone` and
  `gh pr checkout` use SSH.
- Every checkout's `origin` fetches and pushes over SSH, which the `origin-ssh`
  audit rule checks.

Health inspects the first two without connecting: gh's protocol for
`github.com`, the credential helpers Git would ask for `https://github.com`,
and where Git's configured SSH command resolves `github.com` (`ssh -G`). Each
gap becomes a suggestion right after disk space and leftover processes, and
JSON output reports the findings under `git`. The audit's superseded-guidance
rule flags guidance that still rewrites GitHub URLs to HTTPS.

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
