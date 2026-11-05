# Lessons

Cross-repository lessons from explicit-state-machine passes. Add one when a
pass learns something the next repository needs; keep repository-specific
findings in that repository's guidance.

- The script's `flags` signal skips `cancelled` and `settled`: effect cleanups
  and promise races set them once as guards, which is not a machine.
- Type members and returned object literals (`status: "idle"`) are how an
  explicit machine names its states, so the `status` signal counts only
  assignments and setter calls.
