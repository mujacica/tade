---
name: add-status-probe
description: Add a new signal to `tade status` (e.g. test results, context usage, CI state) or change an existing probe (git, processes, adoption, liveness). Use when status needs information it doesn't collect yet.
---

# Adding or changing a status probe

`tade status` = probes (I/O, in `packages/status`) → `ProbeBundle` → `deriveState` (pure, in
`packages/core/src/state.ts`). `collectStatus` in `packages/status/src/status.ts` wires them.

## Invariants

- **Status is a query, not a memory.** Probes run fresh on every call. No caching beyond a few
  seconds, and never persist derived state.
- **Never throw.** A probe returns `{ ..., warnings: string[] }`; failure means a partial result
  (`null` fields) plus a warning that names the project/task. `collectStatus` has a last-resort
  catch, but reaching it is a bug.
- **A probe that could not look is not a probe that found nothing**, and the difference is the
  whole value of the warning. Tell the three cases apart and say which (`problemWith` in
  `src/processes.ts`): not installed, failed with what it said, and ran out of time. Budget the
  wait like a **spawn on a loaded machine** — four agents running a suite in one checkout is the
  machine this runs on, and a budget picked from how long the program takes alone reports a busy
  machine as a missing program. Where an empty answer would be read as an absence, degrade to the
  last one that could be made rather than to nothing, kept to what is still provably true. Keep
  the sentence **stable**: the window shows the same warning twice as once, so a count or an age
  in it is a new line every poll.
- **Git**: call `git()` from `packages/status/src/git.ts` (sets `GIT_OPTIONAL_LOCKS=0` so probes never take
  the index lock from under an agent). Use porcelain / `-z` formats and parse NUL-delimited output.
- **No network by default in tests.** Anything that hits the network (like `gh`) is behind an option
  that tests turn off.
- **Deterministic output.** Sort every list. `--json` runs on an unchanged machine must be
  byte-identical (the idempotence test in `packages/status/test/status.test.ts` guards this).
- Probes gather facts; they don't decide state. If you catch yourself writing
  `if (...) state = 'blocked'` in a probe, the rule belongs in `deriveState`.

## Steps

1. Add the fact's schema to `packages/core/src/model.ts` (e.g. a field on `GitSnapshot` or
   `AgentSignal`, or a new top-level signal).
2. Implement the probe in `packages/status/src/<name>.ts`, exported from `src/index.ts`. Make
   external dependencies injectable through `StatusOptions` (see `processes`) so tests control them.
3. Test it against **real** inputs: `test/fixtures/mkrepo.ts` for git (never mock git), checked-in
   fixtures for file formats.
4. Feed it into `ProbeBundle` in `collectStatus`, then follow the `change-task-state` skill if it
   changes derivation.
5. Add a never-throws case to `packages/status/test/status.test.ts` (missing tool, bad data).
6. `pnpm check`.
