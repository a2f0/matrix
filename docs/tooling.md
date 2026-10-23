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
needs, preserve its established filename style, and keep supporting tests beside
the code they exercise.

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

Follow the [onboarding and sweep rules](../AGENTS.md#onboarding-a-repository) for
publication order, package pins, managed skills, validation, shipping scope, and
checkout cleanup.

Preserve branch exemptions and length limits, signature verification modes,
attribution restrictions, hook ownership, required CI jobs, conditional skip
rules, and release tags. A common implementation does not require identical
policy. Hook installation must preserve hooks it does not own and report drift
before a push. CI must validate explicit PR branch names without changing the
checkout merely to inspect a name.

Retain behavioral fixtures for repository-specific guarantees, and move generic
guard coverage upstream with the shared implementation. Tests for a script move
must exercise its relocated default paths as well as explicit path overrides.
