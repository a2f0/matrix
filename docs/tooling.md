# Shared tooling and repository layout

Matrix coordinates repositories. Agent-tool owns reusable development workflow
mechanics. Each repository owns its application commands, validation scope, and
release policy. A shared command must preserve the repository's existing
requirements before replacing a local implementation.

## Command ownership

Use the exact-pinned `@a2f0/agent-tool` package for shared branch, commit, hook,
review, pull-request, release-verification, and validation-report behavior. Read
the installed version's help and reference documentation before adopting a
command. Keep policy in `agent-tool.json`; do not duplicate a shared algorithm in
a shell wrapper or edit an installed skill.

Package scripts are the stable entrypoints for people, CI, and hooks. Existing
names such as `lint:branch-name`, `hooks:install`, `check`, and `deploy:preview`
can delegate to a shared command without changing every user's workflow. A
repository wrapper is useful when it supplies application-specific arguments or
combines application steps; a wrapper that only renames a shared command belongs
in `package.json` instead.

Keep application builds, tests, affected-package selection, infrastructure
previews, and deployment commands in their repositories. Shared validation
reporting records what those commands did; it does not choose a smaller suite or
treat a cached success as evidence for a changed checkout. Keep matrix's manifest,
checkout synchronization, the [checkout audit](audit.md), the
[health report](health.md), sweep scheduling,
[sweep ledgers and retrospectives](sweeps.md), and cross-repository release
order here.

## Script locations

Group repository-owned scripts by purpose. Use only directories that the project
needs and preserve its established filename style. Keep tests where the
repository's runner and typechecker discover them; prefer colocating script tests
when those tools support it.

| Location | Contents |
| --- | --- |
| `scripts/checks/` | Repository-specific lint and policy checks |
| `scripts/git/hooks/` | Tracked hook bodies; installation is shared tooling |
| `scripts/testing/` | Test runners, browser preparation, screenshots, and test harnesses |
| `scripts/build/` | Build and packaging entrypoints |
| `scripts/release/` | Package/store release preparation and upload entrypoints |
| `scripts/deploy/` | Deployments, infrastructure command wrappers, and live verification |
| `scripts/dev/` | Local development launchers and setup helpers |
| `scripts/admin/` | Explicit operational tasks such as account administration |
| `scripts/secrets/` | Secret-management entrypoints, never secret material |
| `scripts/lib/` | Helpers genuinely shared by multiple script groups |

Domain-specific directories such as `scripts/protocol/`, `scripts/architecture/`,
or `scripts/auth/` remain useful when they describe a cohesive subsystem. Native
projects keep the [fastlane layout](fastlane.md), and Terraform modules and stacks
remain in their existing infrastructure tree. Do not relocate application source
under `scripts/` or invent empty directories to match this table.

Store build wrappers belong in `scripts/release/` alongside their upload
entrypoints; `scripts/build/` holds ordinary application and package builds.

A move includes relative root resolution, imports, generated paths, config
includes, CI, hooks, tests, package commands, native build files, and owned skills.
Search both literal paths and constructions using shell variables or path joins.
Remove obsolete helpers after all callers migrate. Avoid leaving a second copy
or a permanent compatibility wrapper for a private script path.
After moving hook sources, rerun the hook installer in each existing checkout so
Git does not retain an obsolete hooks path.

## Documentation structure

| Document | Responsibility |
| --- | --- |
| Root `README.md` | Purpose, prerequisites, setup, normal commands, and links to detailed guides |
| `AGENTS.md` | Repository-specific agent requirements: validation, review, versions, CI, and release policy |
| Existing development guide | Detailed contributor workflow, architecture constraints, and troubleshooting |
| `scripts/README.md`, where useful | Script groups and supported entrypoints; no duplicate workflow manual |
| Existing dependency maintenance guide | Reusable upgrade procedure and active constraints |
| Existing operations/deployment guide | Environments, preview/apply procedure, deployment verification, recovery |
| Agent-tool documentation and managed skills | Shared command semantics and shipping procedure |
| Pull request | Change-specific validation, review, migration, and release evidence |

Update the existing focused document instead of adding a competing source of
truth. Link to shared instructions and describe the repository's differences.
Keep operational requirements in `AGENTS.md` and linked guides rather than
maintaining parallel `CLAUDE.md` instructions. Remove obsolete commands and
resolved constraints; do not accumulate per-sweep journals in the checkout.

### README files

A root README introduces the project to someone landing on its GitHub page:

1. The H1 is the plain project name. It is never a link, and no standalone
   link line follows it.
2. The first paragraph says what the project is. When the repository serves a
   public website, it contains the sentence
   `This repo is available on the web at <https://a2f0.net>.`, with the primary
   production host as an angle-bracket autolink (markdownlint rejects bare
   URLs). Other public hosts, such as a demo, app, or dashboard, can follow it.
3. A `Quick start` section takes a fresh clone to a running project in one code
   block, typically `mise install`, the dependency install, hook installation,
   and the development entrypoint with its local URL. Every command must exist.
4. A layout or sub-project table, common commands, and links to the detailed
   guides follow as the repository needs them.

Material specific to one sub-project, such as a workspace package, a native
platform directory, or a Worker, goes in a README in that folder, linked from
the root. Package READMEs follow the same heading and first-paragraph rules.

READMEs carry no instructions for coding agents. Managed and repository-owned
skills, [output capture](#output-capture), harness notes, and review and
shipping policy belong in `AGENTS.md`. A README need not link to `AGENTS.md`. A project
whose product is agent tooling, like agent-tool, still describes that product in
its README.

## Adoption and validation

Follow the [onboarding rules](../AGENTS.md#onboarding-a-repository) and
[sweep rules](../AGENTS.md#sweeps-across-checkouts) for publication order, package
pins, managed skills, validation, shipping scope, and checkout cleanup.

Managed skill and permission checks run in a CI job that already gates merges,
so drift blocks a merge without changing repository settings. Use a check that
branch protection or a ruleset requires, or a dependency of a required
aggregate job that runs with `if: always()` and fails unless every dependency
succeeded; a plain `needs` is not enough, because GitHub accepts a skipped
required check. Several default branches have no protection or rulesets, and
there `agent-tool pr merge` is the only gate, so put the check in a job that
`merge.requiredChecks` names.

Preserve branch exemptions and length limits, signature verification modes,
attribution restrictions, hook ownership, required CI jobs, conditional skip
rules, and release tags. A common implementation does not require identical
policy. Hook installation must preserve hooks it does not own and report drift
before a push. CI must validate explicit PR branch names without changing the
checkout merely to inspect a name.

Retain behavioral fixtures for repository-specific guarantees, and move generic
guard coverage upstream with the shared implementation. Tests for a script move
must exercise its relocated default paths as well as explicit path overrides.

## Import cycles and layering

Every repository with TypeScript sources or a Python package enforces an
acyclic module graph in a check that already gates merges, counting type-only
imports, and writes its intended layering down beside its other layout
guidance. Use whichever mechanism the repository already runs: Biome's
`suspicious.noImportCycles` with `ignoreTypes: false` (the default skips
type-only imports, and most cycles found in the matrix were type-only),
dependency-cruiser's `no-circular` rule at severity `error` with
`tsPreCompilationDeps` or the `swc` parser, or, without either, agent-tool's
`graph check` with a `graph` section in `agent-tool.json` (matrix uses it),
not a new hand-written module-graph test. A Python package needs its own
`test_module_graph.py`, since none of these read Python. Express layers with
the same tool: `style/noRestrictedImports` overrides scoped to
`**/<pkg>/src/**`, dependency-cruiser rules, or the `graph` layer table. Prove a new guard fails on
a planted violation before relying on it. The audit's `import-cycle-guard` rule
checks that one of these exists.

## Shared command entrypoints

| Workflow | Shared command |
| --- | --- |
| Branch name and Git-ref validity | `agent-tool branch check [name...]` |
| Synced-base feature branch creation | `agent-tool branch create <name> --base <base> --remote origin` |
| Push exactly the reviewed commit through hooks | `agent-tool branch push <head> --remote origin` |
| Commit subjects, attribution, and signature policy | `agent-tool commits check` |
| Copied-hook installation and ownership drift | `agent-tool hooks install`, `agent-tool hooks check` |
| Current repository, PR, base, and head | `agent-tool repo context --fetch`, `agent-tool pr context` |
| Every CI entry and exact-head merge readiness | `agent-tool pr checks --wait`, `agent-tool pr preflight` |
| Review-thread replies and resolution | `agent-tool pr threads` |
| Version publication decisions and verified artifacts | `agent-tool release plan`, `agent-tool release verify` |
| Compact receipts and private logs for noisy commands | `agent-tool run`, `agent-tool logs` |
| Sequential validation receipts and durable history | `agent-tool run-group`, `agent-tool runs list` |
| Conditional CI aggregate results | `agent-tool ci gate` |
| Binary-policy checks | `agent-tool checks binaries` |
| Pinned executables and branch-protection diagnostics | `agent-tool toolchain check`, `agent-tool policy check` |
| Confirmed-merge checkout cleanup | `agent-tool repo cleanup` |

See the installed CLI help and upstream
[workflow reference](https://github.com/a2f0/agent-tool/blob/2450eb206deb0e26bb167154f5195732f11ebe7f/docs/workflows.md)
for arguments and limitations. Naming policy is explicit in `agent-tool.json`:
use each repository's accepted Conventional Commit types and long-lived branch
exemptions, and `maxLength: null` when no existing length cap applies. CI passes
its actual PR or destination branch name; detached HEAD is never evidence of a
valid name. Tag-only jobs skip branch naming checks.

The root `bun run check` group preserves the same typecheck, test, and skill-drift
checks as CI. Rich parallel test runners, application-specific deployment guards,
full commitlint rules, and stronger binary or atomic-cleanup policies remain
repository-owned when the shared command cannot represent their guarantees.

## Output capture

Output capture keeps the output of noisy commands out of an agent's context
without losing the evidence. Agent-tool's `run` command writes a command's
stdout and stderr to a private log, preserves its exit status, and prints a
one-line JSON receipt, adding a bounded excerpt of the log's tail when the
command fails. Its `logs` command reads a bounded, terminal-safe tail of a log.
The
[agent-tool reference](https://github.com/a2f0/agent-tool/blob/4f04d2f5d0b308fb5755edc984e06c3983cd3933/docs/reference.md#compact-command-output)
defines both, including excerpt limits, log permissions, and signal handling.

Every managed repository exposes them as two package scripts:

```json
"agent:run": "agent-tool run",
"agent:logs": "agent-tool logs"
```

A repository may keep an equivalent invocation it already uses, such as
`bunx --bun --no-install agent-tool run`; the script names are the contract.

Capture finite commands whose output is long and seldom useful on success:
dependency installs, builds, test suites, linters and formatters, setup
scripts, and Git commands that run hooks, such as `agent-tool branch push`.
Run these directly instead:

- Commands whose output is the decision: independent reviews,
  `versions prepare`, audits, infrastructure plans and previews, and matrix
  `sync`, `status`, `audit`, and `health`. A receipt would hide the result.
- `agent-tool run-group` checks, which capture each step themselves and print
  a compact report of per-step receipts.
- Interactive tools, programs that need a terminal, and persistent servers or
  watchers.

A zero exit status is not the whole result. Before accepting a check, inspect
the warnings, coverage, timings, and artifacts it must produce with
`agent:logs` or a targeted search of the log, rather than rereading a whole
success log. Never narrow a suite, lower coverage, or silence warnings to save
output.

Run captures from the repository root. In a workspace package directory,
`bun run` looks only at that package's scripts, so `agent:run` is not found,
and `bun run --cwd <root> agent:run` runs the command from the root instead.
Point the command at the package, as in
`bun run agent:run --label api -- bun run --cwd packages/api test`;
`agent:logs` takes the receipt's absolute log path, so it works from the root
too. Workspaces add this as a local rule after the standard text.

`bun run sync` updates sources but never installs dependencies, so a
checkout's `node_modules` can hold an older agent-tool than its pin, and its
scripts then run that older harness. `bun run status` lists those checkouts in
`staleInstalls`; run the checkout's documented install before using its
scripts.

### Agent guidance

Each repository's `AGENTS.md` has an `Output capture` section adapted from the
text below, with the repository's own commands as examples and local rules,
such as verification reports or hook receipts, after it. An `AGENTS.md`
without sections carries the same text as a paragraph. READMEs do not mention
output capture.

```markdown
## Output capture

Run Bun tests through `bun run agent-tool bun test --log [-- args...]`, and
other finite, noisy commands, such as installs, builds, linters, package
scripts, and Git commands that run hooks, through
`bun run agent:run --label <name> -- <command> [args...]`. Each keeps complete
output in a private log, preserves the exit status, and prints a compact
receipt, with a bounded excerpt of the log on failure. Read more with
`bun run agent:logs <log-path>`, raising `--tail-lines` or `--max-bytes` as
needed, or with a targeted search of the log. A zero exit does not rule out
warnings: inspect required warnings, timings, and artifacts before accepting a
check. Run reviews, version preparation, audits, infrastructure previews, and
run-group checks directly so their results stay visible, and run interactive
tools and servers directly too. Never narrow a suite or silence warnings to
reduce output.
```

Repositories that do not use Bun's test runner keep `agent:run` for their tests;
`agent-tool bun test` is what harness permission rules allow without a prompt
([harness permissions](#harness-permissions)).

## Harness permissions

Agents can work without blanket approval when routine commands run freely and
consequential ones ask. agent-tool assigns each of its commands a permission
class and generates Claude Code and Codex rules from them, as its
[permissions guide](https://github.com/a2f0/agent-tool/blob/43e8334cc4001442fb1faf6c14099dac8c1739a2/docs/permissions.md)
describes. Every managed repository that pins agent-tool:

- commits the generated `.claude/settings.json`, `.codex/rules/agent-tool.rules`,
  and `.agent-tool-permissions.json`, written by
  `agent-tool permissions install --apply`, which `agents:sync` runs after
  installing skills;
- runs `agent-tool permissions check` wherever it checks managed skills,
  usually in the `agents:check` script, so a stale rule fails CI;
- classifies, in the `permissions.executables` section of `agent-tool.json`,
  the installed CLIs its guidance tells agents to run through `bun x`:
  `local` for linters and compilers, `release` for deploy tools, `exec` for
  runners such as `tsx`.

Agents then run tests and classified executables through
`agent-tool bun test|x`, and change dependencies through
`agent-tool bun update|remove`. Adding a dependency, merges, and publishing
prompt in Codex. For Claude Code the generated rules only allow, because an
explicit `ask` rule prompts even in `bypassPermissions` mode; those classes are
left to the user's mode, and the guide's auto-mode block makes the classifier
hold them until the user asks. Package scripts are not classified, so
`bun run` and `agent:run` keep the harness default. `bun run audit --rule harness-permissions` reports
repositories that lack the files or the check.
