# Checkout audit

`bun run audit` checks every managed checkout's files against the standards
that [AGENTS.md](../AGENTS.md) and these docs define, so drift shows up without
anyone remembering to look. It reads local files and Git only; `--remote` adds
rules that ask the npm registry.

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
| `no-claude-md` | No tracked `CLAUDE.md` at any depth | [Onboarding](../AGENTS.md#onboarding-a-repository) step 4 |
| `ds-store-ignored` | The root `.gitignore` lists `.DS_Store` (or `**/.DS_Store`) | [Onboarding](../AGENTS.md#onboarding-a-repository) step 5 |
| `agent-tool-pin` | An exact `@a2f0/agent-tool` pin no older than the supported minimum, `agent-tool.json`, and `.agent-tool-skills.json`; agent-tool itself is exempt | [Onboarding](../AGENTS.md#onboarding-a-repository) steps 2 and 3 |
| `agent-tool-latest` | With `--remote`: the pin is the latest published release | [Dependency maintenance](dependency-upgrades.md) |
| `output-capture` | `agent:run` and `agent:logs` package scripts, and an `Output capture` section in `AGENTS.md` that names both, or a paragraph when it has no sections | [Output capture](tooling.md#output-capture) |
| `readme-title` | The README's first line is an H1 with no link, and no standalone link line follows it | [README files](tooling.md#readme-files) |
| `readme-quick-start` | A `Quick start` section outside code blocks | [README files](tooling.md#readme-files) |
| `readme-agent-free` | No output capture or skill paths in the README; agent-tool, whose product is agent tooling, is exempt | [README files](tooling.md#readme-files) |
| `brand-images` | With `assets/brand/`: `logo.svg`, an `images` section in `agent-tool.json`, and no committed raster there | [Brand images](../AGENTS.md#brand-images) |
| `superseded-guidance` | No tracked Markdown, outside managed skills, names a command a shared command replaced | [Superseded guidance](#superseded-guidance) |

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
| `git push -u origin HEAD` | `agent-tool branch push <reviewed-head> --remote origin` |
| `git push ... --delete`, except a `--force-with-lease` deletion that a checkout requires | `agent-tool repo cleanup` |

## Changing the audit

The audit is how a lesson becomes enforceable. When a change to guidance adds a
standard that a checkout's files can show, add its rule to `src/audit.ts` in the
same change, with a fixture test and a row above, and name the rule where the
guidance defines the standard; `bun run check` fails when the table and the
rules disagree, and runs every local rule against matrix itself. When agent-tool replaces a documented command,
add the old spelling to `SUPERSEDED`. Once a rule enforces something guidance
explains at length, shorten the guidance to the rule.

A failure is evidence for a sweep, not authorization to change a checkout. When
a rule flags a legitimate case, narrow the rule with a test instead of working
around it in the checkout.
