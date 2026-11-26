# CI lessons

Cross-repository findings from CI passes, newest first. Each names the
repository and PR it came from; recheck before relying on one.

## A catch-all job can hide the whole critical path

tearleads (a2f0/tearleads, baseline 2026-11-26) ran its long suites in their own
sharded jobs, but the job holding "the remaining package tests" finished last
in 60 of 80 runs at a median of 18.6 minutes. `ci timings --job` showed why: one
package's end-to-end suite ran 1158 s of serial files inside it, while every
sharded job finished in under 9 minutes. Look inside the slowest job before
adding shards elsewhere.

## Version bumps defeat path filters and task caches

The same repository bumps every changed package's version and refreshes its
lockfile in every pull request. Its path classifier treated any lockfile change
as touching everything, so lanes meant to run only for native or
infrastructure changes ran in 72 to 74 of 80 runs, and a browser suite whose
inputs included every package manifest executed in 95% of runs. When a lane
that should be rare has a high `overThresholdShare`, look for a file that every
pull request rewrites.

## Tool defaults leave runner cores idle

On 4-vCPU runners, Playwright's CI default of half the cores ran 282 tests on 2
workers, and the TLC model checker ran each model with `-workers 1`, two models
at a time. Read the effective parallelism of every long step before buying
bigger runners.
