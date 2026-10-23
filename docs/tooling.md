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
checkout synchronization, sweep scheduling, and cross-repository release order
here.

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

## Adoption and validation

Follow the [onboarding rules](../AGENTS.md#onboarding-a-repository) and
[sweep rules](../AGENTS.md#sweeps-across-checkouts) for publication order, package
pins, managed skills, validation, shipping scope, and checkout cleanup.

Preserve branch exemptions and length limits, signature verification modes,
attribution restrictions, hook ownership, required CI jobs, conditional skip
rules, and release tags. A common implementation does not require identical
policy. Hook installation must preserve hooks it does not own and report drift
before a push. CI must validate explicit PR branch names without changing the
checkout merely to inspect a name.

Retain behavioral fixtures for repository-specific guarantees, and move generic
guard coverage upstream with the shared implementation. Tests for a script move
must exercise its relocated default paths as well as explicit path overrides.

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
| Sequential validation receipts and durable history | `agent-tool run-group`, `agent-tool runs list` |
| Conditional CI aggregate results | `agent-tool ci gate` |
| Binary-policy checks | `agent-tool checks binaries` |
| Pinned executables and branch-protection diagnostics | `agent-tool toolchain check`, `agent-tool policy check` |
| Confirmed-merge checkout cleanup | `agent-tool repo cleanup` |

See the installed CLI help and upstream
[workflow reference](https://github.com/a2f0/agent-tool/blob/main/docs/workflows.md)
for arguments and limitations. Naming policy is explicit in `agent-tool.json`:
use each repository's accepted Conventional Commit types and long-lived branch
exemptions, and `maxLength: null` when no existing length cap applies. CI passes
its actual PR or destination branch name; detached HEAD is never evidence of a
valid name. Tag-only jobs skip branch naming checks.

The root `bun run check` group preserves the same typecheck, test, and skill-drift
checks as CI. Rich parallel test runners, application-specific deployment guards,
full commitlint rules, and stronger binary or atomic-cleanup policies remain
repository-owned when the shared command cannot represent their guarantees.
