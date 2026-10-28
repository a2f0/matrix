# Dependency maintenance

Use the managed [update-dependencies skill](../.agents/skills/update-dependencies/SKILL.md)
and the [sweep rules](../AGENTS.md#sweeps-across-checkouts). Each checkout's own
guidance determines its setup, validation, release, and deployment requirements.

## Where information belongs

| Information | Destination |
| --- | --- |
| Purpose, setup, normal usage | Top-level README, with a short maintenance link |
| Reusable upgrade procedure and active compatibility constraints | Existing dependency maintenance doc; create a focused doc only when needed |
| Active override or patch | Maintenance doc: owning dependency, rationale, evidence link, and removal condition |
| Versions considered, completed migrations, audit and validation results, preview and skipped-group evidence | Upgrade PR, tied to the reviewed commit |
| Per-repository sweep progress | Final sweep ledger and the tracking issue, when explicitly requested |

Read existing maintenance docs before selecting versions. Update active constraints
in place and remove resolved entries; preserve historical evidence in the PR that
introduced or resolved them. Link the relevant PR or upstream source so a future
upgrade can recheck the decision. Date or otherwise identify audit observations;
a past result is not a fresh audit. Keep procedural agent instructions in
`AGENTS.md` and skills, with concise links to the maintenance doc.

Do not append a report for every upgrade or create an empty maintenance template.
Use an existing suitable document rather than adding a competing source of truth.
Never publish credentials, private logs, state, or plan contents in docs, PRs, or
issues. A useful report records the outcome and safe evidence, not raw secrets.

## Compatibility and deployment gates

For matrix itself, keep the Bun version in `.mise.toml` aligned with
`package.json`'s `packageManager`. CI installs the toolchain from `.mise.toml`.
`bun run audit --rule agent-tool-latest` lists the checkouts whose exact
agent-tool pin trails the latest published release.

The skill inventories package and toolchain pins, follows upstream migrations,
checks compatibility groups and resolved dependency advisories, and validates
documented publish and consumer package managers as well as lockfile owners.
It requires a non-destructive preview before infrastructure applies or
deployments, including effects from hooks and CI. Destructive, replacement, or
unverifiable upgrade groups stay pinned and are reported in the upgrade PR and
sweep ledger.

A request to perform dependency updates includes the `ship-pr` workflow through
merge and normal merge-triggered publishing or deployment. Explicit inventory-only,
local-change, or open-PR-only requests retain their narrower scope. A preview alone
does not authorize deployment, and the shipping default does not authorize a
standalone infrastructure apply or manual deployment. These scope rules do not
waive the preview gates.

## Plan helper for checkouts without agent-tool

The read-only `agent-tool dependencies check-terraform-plan <plan.json>` helper
checks saved Terraform plan JSON for unsafe or incomplete actions. A successful
check does not establish plan freshness, backend identity, or the safety of
effects outside the plan. Keep plans and state private; the skill describes the
remaining checks before any authorized apply.

Every onboarded checkout pins an agent-tool that has the helper, as
`bun run audit --rule agent-tool-pin` confirms. For a checkout that has not
adopted agent-tool yet, run the helper from this workspace:

```sh
node_modules/.bin/agent-tool --repo checkouts/<name> dependencies check-terraform-plan <absolute-plan.json>
```
