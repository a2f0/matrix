---
name: merged-commits
description: Count the original commits in pull requests merged across the matrix on a calendar day, and compare squash versus non-squash totals. Use for questions such as how many commits we would have merged today or yesterday without squashing; not for changing merge policy or merging PRs.
---

# Merged commits

Use the matrix workspace and its pinned Bun. The JavaScript helper reads
`matrix.json`, resolves the workspace identity with `gh repo view`, and queries
GitHub through the authenticated `gh` CLI. No clones, sync, checkout changes,
or GitHub writes are needed. Do not print authentication tokens.

## Run

From the matrix root:

```sh
bun run merged-commits today
bun run merged-commits yesterday --timezone America/New_York
bun run merged-commits 2026-11-05 --timezone America/New_York
```

`today` is the default. Use the user's timezone when stated; otherwise keep
the machine's local timezone and name it in the answer. Calendar-day matching
handles DST without assuming 24-hour days. Dates after the local current day,
invalid dates, and unknown timezones fail. The report captures an `asOf`
instant before querying and excludes later merges; today's count is partial.

The helper is `scripts/count.js` beside this skill. Run it under Bun, not Node:
it reuses matrix's TypeScript manifest and GitHub primitives. Keep its JSON
visible, since these numbers are the requested result, not a noisy check.

## Interpret

- `managed` covers exactly the repositories currently in `matrix.json`, even
  for historical dates; it does not reconstruct an older manifest.
- `includingWorkspace` additionally counts this workspace, without counting it
  twice if it is already managed. `repositories` contains per-repository counts
  and each PR's URL, merge time, and original commit count.
- `originalCommits` counts distinct original commit OIDs **within each
  repository**, including branch merge commits already in the PRs. This is the
  main answer to “without squash.”
- `commitOccurrences` sums the per-PR counts. `duplicateCommitOccurrences` is
  the difference from unique commits, for overlapping or stacked PRs. Disclose
  a nonzero difference instead of presenting the sum as unique history.
- `squashCommits` is one commit per merged PR. `withMergeCommits` adds one new
  merge commit per PR to `originalCommits`. These are hypothetical comparisons,
  not detection of the actual merge method or a simulation of rewritten Git
  history. Rebase merges and fast-forwards have different semantics.
- `existingMergeCommits` describes merge commits already included in the
  original count; do not add them again. Commits authored before the requested
  day still count when their PR merged during that day. Direct pushes do not.

The helper reads merged PRs directly, not GitHub's search index. It paginates
by update time until no older page can contain the day, rescans updates since
`asOf` to recover PRs that moved ahead of its cursor, then fetches every selected
PR's commits with pagination. A failed API call or incomplete commit list fails
the entire report: never turn missing repositories into zeroes. An incomplete
list reports the received and expected counts; it may reflect an API limit,
so do not assume rerunning will fix it.
This is a read-time view, not an atomic historical snapshot; if GitHub reports
changing commit lists, rerun rather than report a partial total.

## Answer

Lead with the managed original-commit count and merged-PR count. State the
calendar date, timezone, and cutoff for a partial day. A compact table can show
managed and workspace-inclusive scopes, with columns for squash commits,
original commits, and original commits plus one merge commit per PR. Explain
duplicates when present. Do not describe hypothetical squash counts as proof
of how the PRs actually merged.

## Ownership

Matrix owns this skill and its JavaScript helpers; regression tests live in
`src/mergedCommits.test.ts`. omp discovers `skills/` through the project config.
Other harnesses can follow the link in `AGENTS.md`; no global install is needed.
