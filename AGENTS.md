# Repository guidance

This repository is a workspace for making one change across many repositories.
`matrix.json` lists the managed repositories, and `bun run sync` clones each
into `checkouts/<name>`. `checkouts/` is gitignored; never commit its contents
here.

Resolve GitHub identity with `gh repo view --json nameWithOwner` from the
directory you are working in, never from a folder name. Work on feature
branches, use conventional commits, and preserve unrelated edits. Do not
force-push or add attribution footers. Do not create GitHub issues without an
explicit request.

## Changing matrix itself

Use the Bun version pinned in `.mise.toml`. In agent shells, put its
`~/.local/share/mise/installs/bun/<version>/bin` first on `PATH`; do not run
`mise trust` to activate the checkout.

Validate with `bun run check`, which records typecheck, tests, and managed-skill
checks through the shared validation group. CI also validates the actual branch
name using `bun run lint:branch-name <name>`.
Capture noisy finite commands with the pinned harness, for example
`bun run agent:run --label tests -- bun test`. It preserves exit status and full
private logs while returning a compact receipt and a bounded failure excerpt.
Use `bun run agent-tool logs <log-path>` or a targeted search for more evidence;
inspect required warnings, timings, and artifacts before accepting a check.
Keep review verdicts and structured decision output, including matrix sync/status
results, visible. Do not wrap interactive tools or persistent servers.
Ship with the installed `ship-pr` skill; title and required CI policy is in
`agent-tool.json`. After updating the agent-tool pin, run `bun run agents:sync`
and commit the lockfile, skills, and `.agent-tool-skills.json` together. Do not
edit managed skills. When handling review feedback, reply in its original review
thread with
`agent-tool pr threads reply <comment-id> --body-file <reply-file>`
and resolve only fully addressed findings.

## Secrets

Secrets live in `../matrix-secrets/<project>/{staging,prod,ci}`, linked from each
clone's gitignored `.secrets`; `docs/secrets.md` describes the layout, backups,
and CI deployment. Never read, print, log, or commit secret values; names are
fine. Change that folder only on request, and back it up first.

## Onboarding a repository

1. Add it with `bun run discover --apply`, or by editing `repos`, and ship that
   manifest change here. Then run `bun run sync <name>` and `bun run status`.
2. Adopting agent-tool in a checkout is a change to that repository: read its
   guidance and ship it there. Pin `@a2f0/agent-tool` exactly, run
   `agent-tool skills install --apply`, and run `agent-tool skills check` in a
   CI job that already gates merges, so skill drift blocks them without
   changing repository settings. Use a check that branch protection or a
   ruleset requires, or a dependency of a required aggregate job that runs
   with `if: always()` and fails unless every dependency succeeded; a plain
   `needs` is not enough, because GitHub accepts a skipped required check.
   Several default branches have no protection or rulesets, and there
   `agent-tool pr merge` is the only gate, so put the check in a job that
   `merge.requiredChecks` names. Do not add protection while onboarding.
3. Write `agent-tool.json` from the repository's real workflow and job names
   and its existing title rules. Read merge rules from both classic branch
   protection (`gh api repos/{owner}/{repo}/branches/{branch}/protection`) and
   the branch's active ruleset rules
   (`gh api repos/{owner}/{repo}/rules/branches/{branch}`); the ruleset list
   also returns inactive rulesets and those targeting other branches.
   `merge.requireStrictBaseFreshness` recognizes only rulesets; leave it false
   where protection is classic.
4. Keep guidance in `AGENTS.md` alone; managed repositories have no
   `CLAUDE.md`. Codex and OpenCode read it, and so does Claude Code when no
   `CLAUDE.md` exists: its `instructionFiles` setting defaults to
   `claude-md-or-agents-md` (verified with 2.1.292). Reviewers may still ask to
   restore a `CLAUDE.md` import; cite that default and decline the finding.
   Run the checkout's own hooks and linters over the installed skills before
   committing; managed skills cannot be edited, so exclude their directories
   from a linter that rejects them.

## Shared tooling and repository layout

Follow [docs/tooling.md](docs/tooling.md) for shared command ownership, script
locations, and documentation structure. Put reusable Git, GitHub, hook, release,
and validation mechanics in agent-tool; keep repository-specific commands and
policy in the checkout. Update every caller when moving a script, including CI,
hooks, package scripts, tests, native build references, and repository-owned
skills. Preserve documented package-script names as the normal entrypoints.

## Brand images

Repositories that render icons, splash screens, favicons, or store graphics keep
their SVG sources in `assets/brand/` and declare every output in the `images`
section of `agent-tool.json`; `agent-tool images build <target>` renders them
(see agent-tool's `docs/images.md`). Do not add per-repository image scripts or
ImageMagick dependencies.

## Store releases

Repositories that ship iOS or Android store builds follow
[docs/fastlane.md](docs/fastlane.md): fastlane in the native app directory, the
same lane and package-script names, `NATIVE_RELEASE_TIER` for a staging app,
and store secrets in `.secrets/<tier>/` under the names it lists. Bring a newly
onboarded app to it, and change it there before diverging in one repository.

## Sweeps across checkouts

A sweep applies one requested change to many checkouts. Coordinate it from a
session started in this directory; checkouts outside a session's working
directories can make delegated agents stop for permission prompts.

1. Run `bun run sync`, then `bun run status`. Change only checkouts whose
   status is `ready`. Report the rest (local changes, another branch, diverged,
   errors) instead of resetting, stashing, or discarding their state. Without
   named targets, a sweep covers every managed checkout where the change applies.
2. Each checkout is its own repository, and this file stops at its boundary.
   Before changing a checkout, read its `AGENTS.md`, README, and the docs they
   point to, and follow them inside it: setup, hooks, validation, versioning,
   title policy, review bots, and deployment. Run Git, `gh`, package, and test
   commands from the checkout directory. Checkout-specific skills live in its
   own skill folders.
3. Inspect before editing; the same request often needs different edits per
   repository. Inventory every form of the target, not one literal spelling: a
   route can appear with shell variables in place of placeholders, and
   repository-owned skills carry copies that agent-tool does not manage. When
   the change does not apply or is already true, record that and leave the
   checkout untouched.
   For dependency sweeps, use the shared `update-dependencies` skill and its
   compatibility and infrastructure-preview gates. For checkouts with an older
   pin or no local agent-tool, use the workspace's plan helper described in README.
   Keep top-level READMEs focused on purpose, setup, and normal usage. Put reusable
   upgrade procedures and active constraints in the checkout's existing dependency
   maintenance doc, linked briefly from README and AGENTS.md; create a focused doc
   only when there is durable content. Reconcile constraints in place and remove
   resolved entries. Put run-specific inventories, audits, validation, previews,
   and skipped-group evidence in the upgrade PR and any requested sweep issue,
   not an accumulating repository journal. See `docs/dependency-upgrades.md`.
4. Use one branch name for the whole sweep in the `<type>/<topic>` form with a
   Conventional Commits type, such as `chore/<topic>`; several repositories
   reject other branch names. Create it from the synced default branch with
   `agent-tool branch create <branch> --base <default-branch> --remote origin`.
   Push the reviewed commit with
   `agent-tool branch push <reviewed-head> --remote origin`.
   These commands validate refs, avoid local upstream inheritance, and preserve
   normal hooks. Use the checkout's own pinned CLI; older checkouts may still
   need `git switch --no-track -c` and `git push -u origin HEAD`. Run the checkout's documented setup before committing so its
   hooks run. Agent shells do not activate mise's per-directory tools, so the
   default Bun, Node, or Terraform can differ from a checkout's pins; put the
   pinned versions under `~/.local/share/mise/installs` first on `PATH` instead
   of running `mise trust`. Commit only the sweep's change.
5. Ship each checkout independently with the `ship-pr` workflow. Use the
   checkout's own pinned agent-tool and `agent-tool.json`, or, when it has none,
   `node_modules/.bin/agent-tool --repo checkouts/<name>` from this workspace.
   Every checkout needs its own validation and independent review. When a
   checkout's change needs a release that another checkout in the sweep will
   publish, ship them in order: merge the producer, confirm its publish run and
   the registry's version, then start that consumer against the exact version,
   with the producer's API and migration notes in its brief. If the producer's
   publish fails after it merges, the consumer pins the first release that does
   publish, once its tarball is confirmed to contain the change. Changes that do
   not depend on a new release still ship in parallel. Use
   `agent-tool pr checks --wait --head <reviewed-head>` to wait for every check
   entry. For older pins, `gh pr checks --watch` can exit successfully before
   checks appear; wait for all push and pull-request entries to finish.
6. A request to perform dependency updates includes `update-dependencies` and
   `ship-pr` through merge and the repository's normal merge-triggered publishing
   or deployment, unless the user requests a narrower stopping point. Other
   sweeps stop once each PR is open unless the request authorizes merging.
   When a sweep merges, follow each repository's CI, merge, and
   deployment policy; some merges deploy sites or publish packages. npm can take
   several minutes to list a version after its publish workflow succeeds, so
   poll before reporting a failed publish. Never weaken a repository's policy to
   make a sweep uniform. A consumer that needs an unmerged producer release
   waits and is reported as blocked; never pin it to an unpublished build.
7. When the harness supports subagents, delegate one checkout per subagent with
   its checkout path and these rules; do not edit a delegated checkout yourself.
   Run at most four at a time: concurrent validation suites saturate the machine
   and cause timing failures.
   Keep a ledger per repository: branch, commit, validation, review verdict, PR,
   merge, publish or deploy, or the reason it was skipped or failed. Finish with
   that ledger.
8. After the PRs merge, use the `reset` skill in each checkout, then run
   `bun run sync`. The shared `agent-tool repo cleanup <pr> <shipped-head> --apply`
   verifies merge ancestry and branch identities before cleanup; keep-branch
   preserves the feature refs. Its REST deletion avoids full pre-push gates but
   cannot atomically bind deletion to an expected SHA. A checkout requiring an
   atomic lease must retain its stronger cleanup procedure. Reinstall documented
   dependencies and hooks after returning to the default branch.
   With older pins, use that checkout's reset skill, verify the remote branch still
   matches the shipped head, and delete it with
   `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/{branch}`.
   `git push --delete` would rerun pre-push hooks, often the full validation gate;
   keep a checkout's stronger atomic-lease requirement when it has one.

When the request asks for an issue to track a sweep, open it in this workspace's
repository. Each PR body references it as `Part of <owner>/<repo>#<number>`
without a closing keyword, so one repository's merge does not close the sweep.
Post each repository's ledger entry on the issue as it ships.

`.ignore` lets ripgrep-based search tools see checkouts from the workspace root;
scope searches to `checkouts/<name>` when working on one repository.
