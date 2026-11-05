# Lessons

Cross-repository lessons from explicit-state-machine passes. Add one when a
pass learns something the next repository needs; keep repository-specific
findings in that repository's guidance.

- The script's `flags` signal skips `cancelled` and `settled`: effect cleanups
  and promise races set them once as guards, which is not a machine.
- Type members and returned object literals (`status: "idle"`) are how an
  explicit machine names its states, so the `status` signal counts only
  assignments and setter calls.
- The first sweep (16 repositories) found real machines the scanner missed:
  React refs (`busy.current`), `#private` fields, in-place writes to nested
  objects (`record.steps[i].status`), lifecycle booleans not named `is*`
  (`booting`, `paging`), extensionless and Expect scripts, and nullable values
  paired with flags. The first five are now signals; read for the last by hand.
- A ref mirroring a state (`isSubmitting` with `isSubmittingRef`) now shows as
  two flags; it is worth reading, since the pair can disagree.
- Server status columns where every write is a conditional update naming the
  state it leaves were already explicit in balebase and devopsrockstars; the
  scanner still lists them, and the skill now says to leave them.
- Repositories with no runtime state (seed data, one-shot CLIs, dotfiles)
  closed as `unchanged` within minutes; let them, and record what was read.
- Converting found real bugs: a step that stayed `running` forever after its
  runner failed to start, a gallery acting on a detached render, a bootstrap
  gate blocked forever when prerequisites vanished mid-run, two menus closing
  on one press, duplicate stop logs on a second focus loss.
