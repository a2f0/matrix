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

Claude Code, Codex, and Hermes all read this file. Claude Code loads the
managed skills from `.claude/skills` and Codex from `.agents/skills`; Hermes
does not load repository skills, so in Hermes read
`.agents/skills/<name>/SKILL.md` before following a skill named here.
Delegated subagents start without this conversation, so give each one the
paths, rules, and commands it needs.

## Changing matrix itself

Use the Bun version pinned in `.mise.toml`. In agent shells, put its
`~/.local/share/mise/installs/bun/<version>/bin` first on `PATH`; do not run
`mise trust` to activate the checkout.

Validate with `bun run check`, which records typecheck, tests, and managed-skill
checks through the shared validation group. CI also validates the actual branch
name using `bun run lint:branch-name <name>`. The tests check that every link,
command, and audit rule the docs name exists, that matrix passes its own audit,
and that this file stays within its word budget; make room for new guidance by
moving detail into `docs/` or replacing a rule with a command, not by raising
the budget.
Run finite, noisy commands through
`bun run agent:run --label <name> -- <command> [args...]`, for example
`bun run agent:run --label tests -- bun test`. It keeps complete output in a
private log, preserves the exit status, and prints a compact receipt, with a
bounded excerpt of the log on failure. Read more with
`bun run agent:logs <log-path>`, raising `--tail-lines` or `--max-bytes` as
needed, or with a targeted search; inspect required warnings, timings, and
artifacts before accepting a check. Run `bun run check` directly, since it
prints its own group report (`bun run agent-tool runs list` lists earlier
ones), and keep review verdicts and structured decision output, including
matrix sync, status, and audit results, visible. Do not wrap interactive tools
or persistent servers.
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

## Checking standards

`bun run audit [repo...]` checks every checkout against the standards below
that its files can show, and `--remote` adds the latest-release check for its
agent-tool pin; [docs/audit.md](docs/audit.md) maps each rule to its standard.
When a change here adds such a standard, add its rule in the same change, or
say in the PR why files cannot show it. When agent-tool replaces a documented
command, add the old spelling to the audit's superseded patterns.

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
   Add the `agent:run` and `agent:logs` package scripts and an
   `Output capture` section in `AGENTS.md`, as
   [output capture](#output-capture) describes.
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
5. Make sure the root `.gitignore` lists `.DS_Store` as a plain pattern, so it
   matches at every depth. Every managed repository ignores macOS Finder
   metadata, so it never shows up as a local change or holds back `sync`; add
   the rule in the onboarding change when it is missing.
6. Bring its READMEs to the [README rules](#readme-files) in the onboarding
   change.
7. Run `bun run audit <name>` once those changes merge, and report any rule it
   still fails as unfinished onboarding.

## README files

READMEs are written for people. The H1 is the plain project name, never a
link. When a repository serves a public website, the first paragraph says
`This repo is available on the web at <https://host>.` with its primary
production host. A `Quick start` section goes from a fresh clone to a running
project. Material for one sub-project lives in that folder's README, linked from
the root. Instructions for coding agents, such as skills, output capture, and
review or shipping policy, belong in `AGENTS.md`, never in a README.
[docs/tooling.md](docs/tooling.md#readme-files) has the details.

## Shared tooling and repository layout

Follow [docs/tooling.md](docs/tooling.md) for shared command ownership, script
locations, and documentation structure. Put reusable Git, GitHub, hook, release,
and validation mechanics in agent-tool; keep repository-specific commands and
policy in the checkout. Update every caller when moving a script, including CI,
hooks, package scripts, tests, native build references, and repository-owned
skills. Preserve documented package-script names as the normal entrypoints.

## Output capture

Every managed repository runs noisy finite commands through agent-tool's `run`
command, which keeps full output in a private log and returns a compact
receipt, and reads logs back with `logs`. They are exposed as the `agent:run`
and `agent:logs` package scripts, and each `AGENTS.md` has an `Output capture`
section adapted from the text in
[docs/tooling.md](docs/tooling.md#output-capture), which also says what to
capture and what to keep visible. READMEs never mention it. Bring a newly
onboarded repository to it, and change the shared text there before diverging
in one repository.

## Brand images

Repositories that render icons, splash screens, favicons, or store graphics keep
their SVG sources in `assets/brand/` and declare every output in the `images`
section of `agent-tool.json`; `agent-tool images build <target>` renders them
(see agent-tool's `docs/images.md`). Do not add per-repository image scripts or
ImageMagick dependencies.

Every website serves `favicon.svg`, `favicon.ico` (16, 32, and 48 pixels), and
an opaque 180-pixel `apple-touch-icon.png` rendered from `assets/brand/logo.svg`,
linked from each page head; balebase and tearleads are the references. Render
them during dev and build, including the build a deploy runs, into a gitignored
directory or the build output, and add `agent-tool.json` and `assets/brand/**`
to cached build inputs such as Turbo's. Never commit binary images: replace a
committed raster with its SVG source and a rendered output. Export editor SVGs
as plain SVG that meets agent-tool's source rules, and have pages that display
the logo use the `assets/brand` copy instead of a duplicate. Pages that a
published package lets another site copy under a subpath either link relative
icons that the package ships rendered (dnbm) or link root-absolute icons so the
host's apply (skyline); every host serves its own icons at the root. Merging
does not put a favicon live where a repository deploys only on request; report
those deploys rather than running them.

## Store releases

Repositories that ship iOS or Android store builds follow
[docs/fastlane.md](docs/fastlane.md): fastlane in the native app directory, the
same lane and package-script names, `NATIVE_RELEASE_TIER` for a staging app,
and store secrets in `.secrets/<tier>/` under the names it lists. Bring a newly
onboarded app to it, and change it there before diverging in one repository.
Store apps also carry the app-store-readiness skill and readiness lanes that
balebase owns ([docs/fastlane.md](docs/fastlane.md#readiness)); audit a store
candidate with them and record its findings in the PR. Maestro's driver uses
port 7001 for every device, so one Maestro run drives this machine at a time,
whatever its session: check for a running `maestro` before starting one, and
boot your own simulator or emulator and name it explicitly.

## Search indexing

Repositories that serve websites follow the
[seo-optimization skill](https://github.com/a2f0/balebase/blob/main/skills/seo-optimization/SKILL.md),
which balebase owns and `~/.claude/skills` and `~/.agents/skills` link to.
Every non-production tier and internal host sends `X-Robots-Tag: noindex,
nofollow` and a robots meta tag while robots.txt still allows crawling;
production pages carry static titles, descriptions, canonical URLs, preview
images, robots.txt, and a sitemap; and Workers set `workers_dev` and
`preview_urls` to false. Bring a newly onboarded site to it, and change the
skill before diverging in one repository.

## Sweeps across checkouts

A sweep applies one requested change to many checkouts. Coordinate it from a
session started in this directory; checkouts outside a session's working
directories can make delegated agents stop for permission prompts.

1. Run `bun run sync`, then `bun run status`. Change only checkouts whose
   status is `ready`. Report the rest (local changes, another branch, diverged,
   errors) instead of resetting, stashing, or discarding their state. An
   untracked `.DS_Store` means that repository lacks the ignore rule from
   onboarding step 5: ship the rule there instead of deleting the file. A clean
   checkout left on a renamed former default branch, whose upstream is gone, may
   switch to the current default with the user's approval; keep the old local
   branch, and move aside rather than delete files it leaves untracked. Without
   named targets, a sweep covers every managed checkout where the change applies.
   Checkouts in `staleInstalls` hold an older agent-tool than they pin; tell
   their delegates to run the documented install before using any script.
   Choose the sweep branch (step 4) and open its ledger with
   `bun run sweep start <branch> --topic <text> [repo...]`; it starts ready
   checkouts as `pending` and skips the rest with the reason `status` gives.
2. Each checkout is its own repository, and this file stops at its boundary.
   Before changing a checkout, read its `AGENTS.md`, README, and the docs they
   point to, and follow them inside it: setup, hooks, validation, versioning,
   title policy, review bots, and deployment. Run Git, `gh`, package, and test
   commands from the checkout directory. Checkout-specific skills live in its
   own skill folders.
3. Inspect before editing; the same request often needs different edits per
   repository. Inventory every form of the target, not one literal spelling: a
   route can appear with shell variables in place of placeholders, and
   repository-owned skills carry copies that agent-tool does not manage. For a
   standard `bun run audit` checks, start from its failures, then still inspect
   every form. When the change does not apply or is already true, record that
   and leave the checkout untouched.
   For dependency sweeps, use the shared `update-dependencies` skill and its
   compatibility and infrastructure-preview gates. For a checkout without
   agent-tool, use the workspace's
   [plan helper](docs/dependency-upgrades.md#plan-helper-for-checkouts-without-agent-tool).
   Keep upgrade procedures, constraints, and evidence where
   [dependency maintenance](docs/dependency-upgrades.md#where-information-belongs)
   puts them: reusable procedure in the checkout's maintenance doc, run evidence
   in the PR, never an accumulating journal.
4. Use one branch name for the whole sweep in the `<type>/<topic>` form with a
   Conventional Commits type, such as `chore/<topic>`; several repositories
   reject other branch names. Create it from the synced default branch with
   `agent-tool branch create <branch> --base <default-branch> --remote origin`.
   Push the reviewed commit with
   `agent-tool branch push <reviewed-head> --remote origin`.
   These commands validate refs, avoid local upstream inheritance, and preserve
   normal hooks. Use the checkout's own pinned CLI; the audit's
   `agent-tool-pin` rule confirms every pin has these commands. Run the
   checkout's documented setup before committing so its hooks run. Agent shells
   do not activate mise's per-directory tools, so the
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
   entry.
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
   Record each repository in the ledger as its state changes with
   `bun run sweep record <branch> <repo>`: status, commits, PR, validation,
   reviewer and verdict, publish or deploy, cleanup, or the reason it was
   unchanged, skipped, blocked, or failed. Record friction as it happens: a
   step that passed only on a rerun (`--retry`), a substitute tool or reviewer
   (`--fallback`), a declined review finding (`--declined`), or a step that
   needed the user (`--manual`), each with a kebab-case cause such as
   `--retry enospc:<detail>`; [docs/sweeps.md](docs/sweeps.md) defines the
   fields. Delegates report these to the coordinator or record them with
   `bun run --cwd <workspace> sweep record`. Finish with
   `bun run sweep report <branch>`.
8. After the PRs merge, use the `reset` skill in each checkout, then run
   `bun run sync`. Its `agent-tool repo cleanup <pr> <shipped-head> --apply`
   prunes the shipped branches; verify the local feature ref is gone unless the
   request keeps it. A checkout requiring an atomic lease keeps its stronger
   cleanup procedure. Reinstall documented dependencies and hooks after
   returning to the default branch.
9. Before the final report, run `bun run sweep retro`. Give each recurring
   cause a resolution in the repository that owns it: a fix, guidance, or a
   recorded decision, shipped as its own PR or listed as a follow-up in the
   report ([docs/sweeps.md](docs/sweeps.md#retro)). Friction never justifies
   weakening a repository's policy. When a lesson becomes something matrix or
   agent-tool can check or perform, replace its prose with the command.

When the request asks for an issue to track a sweep, open it in this workspace's
repository. Each PR body references it as `Part of <owner>/<repo>#<number>`
without a closing keyword, so one repository's merge does not close the sweep.
Post each repository's ledger entry on the issue as it ships;
`bun run sweep report <branch> --markdown` renders the table.

`.ignore` lets ripgrep-based search tools see checkouts from the workspace root;
scope searches to `checkouts/<name>` when working on one repository.
