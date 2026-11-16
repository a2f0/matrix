# Checkout audit

`bun run audit` checks every managed checkout's files against the standards
that [AGENTS.md](../AGENTS.md) and these docs define, so drift shows up without
anyone remembering to look. It reads local files and Git, and runs the
workspace's pinned agent-tool for `push-gate check`; `--remote` adds rules that
ask the npm registry and GitHub.

```sh
bun run audit [repo...] [--rule <id>]... [--remote]
```

The JSON result lists the rules that ran, `failures` as failing repositories by
rule, and for each checkout its `branch`, `head`, `failed` and `skipped` rules
with details. `ok` is true when no checkout failed a rule or errored, and the
command exits 1 otherwise, so scripts and scheduled runs see drift. A missing
checkout, or one `status` rejects, reports `error` and runs no rules. The audit
reads whatever is checked out, local changes included, so run `bun run sync`
first and check `branch` for checkouts that are not on their default branch.

## Rules

| Rule | Checks | Defined in |
| --- | --- | --- |
| `agents-md` | A tracked root `AGENTS.md` | [Onboarding](../AGENTS.md#onboarding-a-repository) step 4 |
| `agents-md-size` | Every tracked `AGENTS.md`, at any depth, has at most 20,000 characters | [Agent guidance](tooling.md#agent-guidance) |
| `no-claude-md` | No tracked `CLAUDE.md` at any depth | [Onboarding](../AGENTS.md#onboarding-a-repository) step 4 |
| `ds-store-ignored` | The root `.gitignore` lists `.DS_Store` (or `**/.DS_Store`) | [Onboarding](../AGENTS.md#onboarding-a-repository) step 5 |
| `agent-tool-pin` | An exact `@a2f0/agent-tool` pin no older than the supported minimum, `agent-tool.json`, and `.agent-tool-skills.json`; agent-tool itself is exempt | [Onboarding](../AGENTS.md#onboarding-a-repository) steps 2 and 3 |
| `agent-tool-latest` | With `--remote`: the pin has trailed newer releases for under 7 days | [Dependency maintenance](dependency-upgrades.md) |
| `output-capture` | `agent:run` and `agent:logs` package scripts, and an `Output capture` section in `AGENTS.md` that names both, or a paragraph when it has no sections | [Output capture](tooling.md#output-capture) |
| `state-machines` | An `AGENTS.md` `State machines` section naming the `explicit-state-machines` skill, and that skill installed from agent-tool 0.1.51 (agent-tool itself ships it from `skills/`) | [State machines](tooling.md#state-machines) |
| `readme-title` | The README's first line is an H1 with no link, and no standalone link line follows it | [README files](tooling.md#readme-files) |
| `readme-quick-start` | A `Quick start` section outside code blocks | [README files](tooling.md#readme-files) |
| `readme-agent-free` | No output capture or skill paths in the README; agent-tool, whose product is agent tooling, is exempt | [README files](tooling.md#readme-files) |
| `brand-images` | With `assets/brand/`: `logo.svg`, an `images` section in `agent-tool.json`, and no committed raster there | [Brand images](../AGENTS.md#brand-images) |
| `screenshots-store` | With a `screenshots` package script or a `.screenshots` ignore rule: both, and the rule has no trailing slash, so `.screenshots` can link to the shared store | [Artifacts](artifacts.md#repository-contract) |
| `screenshots-gallery` | With a `screenshots` package script and an Astro site: a `screenshots` target in `agent-tool.json`, a package script that runs `agent-tool screenshots build`, and no copy of the capture guard (`withSharedCapture`) outside tests | [Artifacts](artifacts.md#repository-contract) |
| `harness-permissions` | `.agent-tool-permissions.json`, `.claude/settings.json`, and `.codex/rules/agent-tool.rules`, and `permissions check` in the `agents:check` script or a workflow; agent-tool itself is exempt | [Harness permissions](tooling.md#harness-permissions) |
| `import-cycle-guard` | TypeScript sources have Biome `noImportCycles` at `error` with `ignoreTypes: false`, a type-aware error-level dependency-cruiser `no-circular` rule, agent-tool `graph check` configured and run by a package script, run group, workflow step, or runner under `scripts/`, or a module-graph test; a Python package has `test_module_graph.py` | [Import cycles and layering](tooling.md#import-cycles-and-layering) |
| `mise-lock` | With tools in a root `mise.toml` or `.mise.toml`: no `lockfile = false`, a tracked `mise.lock` in format 4 or later with an entry for each declared tool, and every `jdx/mise-action` `version` pinned in a workflow or composite action at mise 2026.11.1 or later | [Toolchain lockfiles](dependency-upgrades.md#toolchain-lockfiles) |
| `origin-ssh` | `origin` fetches and pushes over SSH (`git@github.com:`, or `ssh.github.com` on port 443), after `insteadOf` rewrites | [GitHub over SSH](health.md#github-over-ssh) |
| `push-gate` | With a pre-push hook or a `pushGate` section: the hook is a tracked `scripts/git/hooks/pre-push`, not a hook manager's or one `hooks.files` installs from elsewhere, and agent-tool's `push-gate check` passes (the canonical hook, declared in `hooks.files`, with no step that runs tests or installs, even one with an `allowSlow` reason) | [Push gates](tooling.md#push-gates) |
| `base-freshness` | `agent-tool.json` does not set `merge.requireStrictBaseFreshness` | [Base freshness](tooling.md#base-freshness) |
| `base-freshness-settings` | With `--remote`: neither classic protection nor an active ruleset requires an up-to-date branch to merge into the default branch | [Base freshness](tooling.md#base-freshness) |
| `default-branch-ci` | Each workflow `merge.requiredChecks` names, or any workflow when it names none, runs on every push to the default branch: a push trigger whose branch filters include it, with no paths filter, and no required check's jobs, in its workflow or, for a check named without one, in any workflow, all skip some push there, by a workflow that does not run on every push, comparing `github.event_name`, `github.ref`, or `github.ref_name` or by needing a job that does | [Base freshness](tooling.md#base-freshness) |
| `deploys-need-checks` | A job named for deploying or publishing, in a workflow that pushes to the default branch start, runs a test runner or a `test`, `check`, `verify`, or `ci` script, where a command starts outside comments, quoted text, and line continuations, before every step that ships (one whose command, not an argument, names deploying, publishing, or a release), or needs, directly or through other jobs, a required check, a job whose id or name says test, check, verify, ci, or gate, or a job whose steps run one; a condition with a status function holds a job or step behind what precedes it only through a plain `&&` with `success()` or `needs.<job>.result == 'success'`, without `||` or negation; validation excused by `continue-on-error`, skipped by a constant-false or `failure()` condition, or in a script that is not plain commands (conditionals, `||`, substitution, `set`, or a pipe, except from `echo`, `printf`, or `cat` or under `shell: bash`), or that runs several commands under a shell that does not stop at a failure (a custom shell, or a Windows or expression runner's default) or inside an `&&` list more commands follow, does not count, nor does the name of a job whose validation, or any command, is one of those; a job or step whose `if` compares `github.event_name`, `github.ref`, or `github.ref_name` so that a push to the default branch cannot satisfy it neither ships nor validates | [Base freshness](tooling.md#base-freshness) |
| `superseded-guidance` | No tracked Markdown, outside managed skills (and agent-tool's `skills/` sources of them), names a command a shared command replaced | [Superseded guidance](#superseded-guidance) |

A rule checks the evidence a standard leaves in files. It does not prove the
whole standard: a sweep still inspects each checkout before editing it.

## Superseded guidance

When a shared command replaces a documented workaround, copies of the old
instruction linger in checkouts' guidance and repository-owned skills. The
rule searches tracked Markdown for each spelling below, skipping managed skills,
which the agent-tool pin updates:

| Pattern | Replacement |
| --- | --- |
| The REST route for review-comment replies | `agent-tool pr threads reply` |
| `git switch --no-track` | `agent-tool branch create` |
| `gh pr checks --watch` | `agent-tool pr checks --wait` |
| The legacy squashMerge action, removed in agent-tool 0.1.50 | `agent-tool pr merge <subject> <reviewed-head> <base-branch>` |
| `git push -u origin HEAD` | `agent-tool branch push <reviewed-head> --remote origin` |
| `git push ... --delete`, except a `--force-with-lease` deletion that a checkout requires | `agent-tool repo cleanup` |
| `showPushGateTimings`, the hand-written push timing log | `agent-tool runs list`, which lists each push gate's run-group report |
| `url.https://github.com/.insteadOf`, which sends GitHub SSH URLs to HTTPS and its keychain helper | SSH through `ssh.github.com:443` ([GitHub over SSH](health.md#github-over-ssh)) |

## Changing the audit

The audit is how a lesson becomes enforceable. When a change to guidance adds a
standard that a checkout's files can show, add its rule to `src/audit.ts` in the
same change, with a fixture test and a row above, and name the rule where the
guidance defines the standard; `bun run check` fails when the table and the
rules disagree, and runs every local rule against matrix itself. When agent-tool replaces a documented command,
add the old spelling to `SUPERSEDED` in `src/superseded.ts`. Once a rule enforces something guidance
explains at length, shorten the guidance to the rule.

A failure is evidence for a sweep, not authorization to change a checkout. When
a rule flags a legitimate case, narrow the rule with a test instead of working
around it in the checkout.
