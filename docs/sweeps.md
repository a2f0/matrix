# Sweep ledgers

`bun run sweep` records what happened in each repository during a sweep and
the friction met along the way, and `sweep retro` groups that friction across
sweeps so recurring causes become lessons instead of being rediscovered. The
[sweep rules](../AGENTS.md#sweeps-across-checkouts) say when to call each
command.

```sh
bun run sweep start chore/topic --topic "Describe the change" [repo...]
bun run sweep record chore/topic dnbm --status open --head <oid> --pr <url>
bun run sweep record chore/topic dnbm --status merged --merge <oid> \
  --reviewer codex --verdict CLEAN --retry enospc:"bun install ran out of space"
bun run sweep report chore/topic [--markdown]
bun run sweep list
bun run sweep retro [branch...] [--last 5] [--min-repos 2] [--min-sweeps 2]
```

## Storage

A ledger lives in Git's common directory, at
`.git/matrix/sweeps/<url-encoded branch>/`, beside agent-tool's run receipts:
`sweep.json` holds the branch, topic, tracking issue, start time, and
repositories, and `repos/<checkout>/` holds one repository's updates. Files are
private to the user and never committed, since run-specific evidence belongs in
PRs and tracking issues rather than a repository journal. Each `record` adds a
new update file and never rewrites one, so the coordinator and parallel
delegates can record at once without losing each other's changes; an entry is
its updates replayed in time order.

`sweep start` refuses a branch that already has a ledger, and a start that
fails leaves nothing behind, so a corrected retry succeeds. It records every
selected repository, all of them by default: a ready checkout starts `pending`
at its current commit, and any other is `skipped` with the reason `status`
gives, such as `on branch feat/x` or `checkout missing; run sync`. A checkout
whose installed agent-tool differs from its pin gets a note to reinstall.

## Entries

| Option | Records |
| --- | --- |
| `--status` | `pending`, `skipped`, `unchanged`, `in-progress`, `open`, `merged`, `blocked`, or `failed` |
| `--reason` | Why it was skipped, unchanged, blocked, or failed; a new status without a reason clears the old one |
| `--base`, `--head`, `--merge` | Full commit IDs: the pinned base, the reviewed head, and the merge commit |
| `--pr` | The pull request URL |
| `--validation`, `--deploy`, `--cleanup` | Short outcomes, such as `check passed: 164 tests` or `merged; deployed` |
| `--reviewer`, `--verdict` | The independent reviewer and its final `BLOCKER`, `MAJOR`, `MINOR`, `SUGGESTION`, or `CLEAN` |
| `--note` | Anything else worth keeping; repeatable |

`unchanged` means the change did not apply or was already true. `open` is the
final status when a request stops at open PRs. `report` lists repositories
still `pending`, `in-progress`, or `blocked` as `remaining`.

Record only what a PR or tracking issue could show: never secret values,
private log contents, Terraform state, or plan output.

## Friction

Friction is anything that made a repository take longer than the procedure
says. Record each occurrence as an event with a kind and a cause:

| Option | Use when |
| --- | --- |
| `--retry` | A step passed only on a rerun: a flaky suite, `ENOSPC`, CI that registered late |
| `--fallback` | A documented tool, reviewer, or command failed or was missing, and a substitute was used |
| `--declined` | A review finding was declined as a settled decision |
| `--manual` | The user, or a step outside the procedure, was needed |

The value is a kebab-case cause, optionally followed by a colon and a detail:
`--retry browser-timing:"ct browser suite timed out once"`. Name the cause, not
where it happened, and reuse causes from earlier ledgers (`sweep retro` lists
them) so retro can group them: `enospc`, `browser-timing`,
`reviewer-unavailable`, `restore-claude-md`.

## Retro

`sweep retro` reads the newest five ledgers, or the branches you name, and
reports:

- `recurring`: causes seen in at least two repositories or two sweeps, with
  every repository, sweep, and detail;
- `isolated`: causes seen once;
- `reviews`: verdict and reviewer counts;
- `unfinished`: entries still pending, in progress, blocked, or open.

Every recurring cause needs a resolution in the repository that owns it, under
the [command ownership](tooling.md#command-ownership) rules:

| Kind | Usual resolution |
| --- | --- |
| `retry` | Fix the cause in the checkout, such as a flaky test or resource limit, or document the limit in its guidance |
| `fallback` | Fix or add the command in agent-tool or matrix, or document the fallback where the procedure lives |
| `declined` | Record the decision in the guidance that reviewers read, so the finding stops recurring |
| `manual` | Automate the step, or document it as a decision the request must make |

Ship each resolution as its own PR, or list it as a follow-up in the sweep's
final report. Retro output is evidence, not authorization: it never permits a
change outside the request, and friction is never a reason to weaken a
repository's policy.

A lesson usually starts as a sentence in guidance. Once matrix or agent-tool
can check or perform it, replace the sentence with the command, so guidance
stays short enough for every agent to follow.

## Tracking issues

`sweep report <branch> --markdown` renders the ledger as a table with each
repository's status, PR, review, detail, and friction. Post it on the tracking
issue, when the request asked for one, as repositories ship.
