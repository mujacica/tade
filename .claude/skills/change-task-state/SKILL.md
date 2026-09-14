---
name: change-task-state
description: Change how Wilco derives a task's state (queued/working/blocked/review/merged/failed/parked) — adding a rule, a new probe signal, or a threshold. Use when status reports the wrong state for some situation.
---

# Changing task-state derivation

State is derived by one pure function, `deriveState(bundle)` in
`packages/core/src/state.ts`. Nothing else decides state.

## Rules of the road

- Keep it pure: no I/O, no `Date.now()` (use `bundle.now`), no async, no mutation of the input.
- Rules are evaluated **top to bottom, first match wins**. The order encodes priority:
  merged → parked → worktree missing → pending permission → looping failures →
  live agent (running / idle) → dead agent → no agent.
- Every returned state carries a short `reason`. Status output and the orchestrator read it aloud,
  so keep it under ~40 characters and concrete ("wants approval: npm i stripe@15").
- `blocked` means "waiting on a human". `review` means "finished, needs eyes" and requires
  commits ahead **and** a clean tree **and** tests not failing. Don't blur these.
- **A task sharing the checkout (`bundle.shared`) goes through `deriveShared`**, which never reads
  the files or commits: they are every agent's. Its state is its agent's alone — a rule about dirty
  files or commits belongs in `deriveState` only.

## Steps

1. Write the failing case(s) first in `packages/core/test/state.test.ts`. The file is one
   table (`cases`); add a row with a descriptive `name`, the probe inputs, `want`, and a `reason`
   regex. Include the ugly neighbours of your case (dirty + green tests, dead + dirty, stale adopted).
2. If the rule needs a new input, add the field to `ProbeBundle` (and, if it comes from a probe,
   to the relevant schema in `packages/core/src/model.ts`). Default it in the test helper so the
   existing rows are untouched.
3. Change `deriveState`. Put the rule at the right priority, not at the end by default.
4. Tunables go in `Thresholds`, never as inline literals.
5. `pnpm test packages/core/test/state.test.ts`, then `pnpm check`.
6. If the meaning of a state changed, say it where it is read: the `reason` strings and the brief.
