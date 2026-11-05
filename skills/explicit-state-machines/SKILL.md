---
name: explicit-state-machines
description: Find implicit state machines in a repository, or across a matrix workspace and its checkouts, and refactor them into explicit ones (a closed set of states, typed events, one pure transition function) without changing behavior. Use when the user asks to "find all of the implicit state machines", to replace tangled boolean flags or scattered status writes, or to dogfood this pass across checkouts; not for adding a state-machine library or redesigning features.
---

# Explicit State Machines

An implicit state machine is code that moves through modes (idle, loading,
failed, done) without naming them: several booleans that are only valid in
some combinations, a status string written from many places, nullable fields
whose presence means "we are in phase X", or effects that chain off each other
to advance a process. Bugs live in the combinations nobody named:
`isLoading && error`, a retry that fires after `done`, a dialog both open and
submitting twice.

An explicit machine names every state once, carries each state's data only in
that state, and changes state only through one function of `(state, event)`.
The pass finds the implicit ones, converts those where the conversion removes
impossible states or scattered transitions, and proves behavior did not change.

## Find candidates

`scripts/state-machines.ts` beside this file ranks tracked source files by two
signals: lifecycle booleans toggled together (`isLoading`, `hasError`,
`_running`, `busy.current`, `this.#rendered`), and status-like fields assigned
three or more string values from three or more places (`step.status = ...`).
It reads extensionless scripts by their shebang, is read-only, and needs only
Bun.

- From a matrix workspace: `bun run state-machines [checkout...]`. With no
  names it covers the workspace and every checkout.
- From any repository, including a checkout:
  `bun <skill-dir>/scripts/state-machines.ts [path...]`, where `<skill-dir>` is
  `~/.agents/skills/explicit-state-machines` or
  `~/.claude/skills/explicit-state-machines`.
- `--limit N` (default 25 per repository, 0 for all), `--min-score N`
  (default 3), `--json` for agents.

The script finds leads, not verdicts, and it misses whole families. Also read
for these by hand, starting from the places state lives (stores, providers,
hooks, workers, sync loops, connection handlers, upload and checkout flows,
wizards, CLI subcommands that resume):

- `loading`/`error`/`data` held as separate fields, or a nullable `error`
  beside a non-null `data`; any nullable value paired with a boolean or a
  second nullable (`nowPlaying` with `interruptedNoise`, `reservation` with
  `editing`). The scanner sees booleans only.
- State split between a context and per-component state that an effect
  re-syncs, and "already handled" dedupe fields that quietly mean "confirmed
  started".
- Fields that are set together and cleared together (`startedAt`, `jobId`,
  `abortController`) and so encode "running".
- `useEffect` chains where one effect sets state that triggers the next.
- Retry, polling, and reconnect loops guarded by counters and flags.
- Status columns or enums whose transitions are enforced nowhere (any writer
  may set any value), in the database or in API handlers.
- Shell, Python, or Expect scripts that track progress with several
  variables.

## Decide what to convert

Convert a candidate only when at least one holds:

1. Two or more of its variables can hold a combination that is meaningless
   (`isLoading && isError`, `data` set while `status === "failed"`).
2. Its transitions are written in several places, so no single place says
   which moves are legal.
3. A bug or missing guard follows from either (an event handled in a state
   where it must be ignored). Fix the bug in the same change, with a test that
   fails before it, and say so in the PR.

Leave it alone when the flags are independent (a theme toggle and a sidebar
toggle are a product of two machines, not one), when there is a single
boolean, when a status is only read (an API response's field mirrored into
UI), when it already is a discriminated union with one writer, or when the
module is about to be deleted. Also leave alone:

- Status columns where every write is a conditional update naming the state
  it leaves (`UPDATE ... WHERE status = $from`), backed by a `CHECK`
  constraint: that is already an explicit machine. A transition trigger only
  restates it and breaks fixtures that simulate races by setting states.
- Monotone flags with one writer each that move one way and are read only
  by cleanup (lock held, applying, committed), and append-only accumulators.
- Static records checked by one validator, and before/after comparisons that
  validate rather than track progress.
- Effect and promise guards (`cancelled`, `mounted`) on their own.

Record each one you leave and why, so the next pass does not reread it.

## Convert

Follow `references/patterns.md` for the language at hand. In every language:

1. List the states and the data each one carries; list the events. Write the
   transition table before the code, and keep it in the PR body.
2. Model states as a closed type: a TypeScript discriminated union on a
   `status` (or the repository's existing tag name), a Swift enum with
   associated values, a Kotlin sealed interface, a Python `Enum` or tagged
   dataclasses, a Go typed constant with a transition function.
3. Write one pure `transition(state, event)` (a reducer). Make the switch
   exhaustive (`never` check, `assertNever`, `@unique` enums, sealed `when`).
   Say explicitly what an event does in a state where it does not apply:
   ignore it (return the same state) or throw in development; never fall
   through silently.
4. Keep every guard the old code had. A `cancelled` flag or an unmount check
   that drops a stale response must become a request tag carried by the
   state and its events (only the current request may finish), never a bare
   "is it loading?" check, which accepts `start(A) -> reset -> start(B) ->
   succeed(A)`. Test that sequence. A cleaned-up effect's callbacks (its own
   abort's rejection included) must not dispatch either; see `patterns.md`.
5. Move side effects out of the transition: effects run on entering a state
   (a worker loop that switches on it, or an effect keyed on the state's whole
   identity: `status` plus its request tag), not inside the reducer. An
   effect keyed on `status` alone misses `loading(A) -> loading(B)` and never
   starts B; test a replacement request.
6. Keep call sites small: derive old booleans from the state
   (`const isLoading = state.status === "loading"`) where many readers use
   them, rather than rewriting every consumer in the same change.
7. Derive old booleans so they stay stable across intermediate states: an
   effect keyed on `editing` must not refire when a replacement passes
   through `reserving`. Keep effects tied to an event, not a state (resuming
   audio on a press), in the handler.
8. Use no new dependency. Use a state-machine library (XState, Robot) only if
   the repository already depends on it.
9. Test the transition table directly: every legal transition, a sample of
   ignored events per state, and the impossible combinations that the old
   code allowed. Keep the existing behavior tests passing unchanged; a test
   that must change shows a behavior change, which belongs in its own PR.
   Run the new behavior tests against the old file (`git show <base>:<file>`
   into a copy kept aside) to prove the refactor changed nothing and that a
   bug's regression test fails before its fix. For output that is printed or
   saved as JSON, assert key order too.
10. Check every new guard against existing listeners: a guard that only acts
    in `ready` breaks a listener reacting to an event fired mid-render.

## Ship

- Work on a `refactor/<topic>` branch (`fix/<topic>` when the change fixes a
  bug) and ship with the repository's `ship-pr` skill: its validation, its
  independent review, its merge policy.
- One PR per repository per pass, unless the diff passes about 600 lines or
  spans unrelated areas; then one PR per area, each independently valid. In
  large repositories plan one PR per machine: formatted transition tables
  and their tests grow fast.
- The PR body lists each converted machine (file, states, events, the
  impossible combinations removed, any bug fixed) and each candidate left
  alone with its reason.
- Repository-specific findings (where machines cluster, conventions such as
  the tag name or reducer location) go in that repository's agent guidance.
  Cross-repository lessons go in `references/lessons.md` here, by PR to matrix.

## Across a matrix workspace

A pass over many checkouts is a sweep: follow matrix's `AGENTS.md` sweep
rules (sync, status, ledger, one delegate per checkout, `ship-pr` each). Run
`bun run state-machines --json` first, attach each checkout's slice to its
delegate's brief, and remind delegates to read beyond the script's list.
Repositories whose push hook or ship policy runs a full browser, simulator,
or package gate need a heavy slot to ship: a delegate without one prepares a
reviewed commit or open PR and hands off to a finisher that holds one.

## Ownership

matrix (`a2f0/matrix`) owns this skill at `skills/explicit-state-machines/`;
`~/.claude/skills/explicit-state-machines` and
`~/.agents/skills/explicit-state-machines` link to the primary matrix clone.
Change it there, with its tests in `src/explicitStateMachines.test.ts`, rather
than copying it into a checkout.
