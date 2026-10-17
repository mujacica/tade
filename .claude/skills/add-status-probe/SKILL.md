---
name: add-status-probe
description: Add a new signal to `tade status` (e.g. test results, context usage, CI state) or change an existing probe (git, processes, adoption, liveness). Use when status needs information it doesn't collect yet.
---

# Adding or changing a status probe

`tade status` = probes (I/O, in `packages/status`) → `ProbeBundle` → `deriveState` (pure, in
`packages/core/src/state.ts`). `collectStatus` in `packages/status/src/status.ts` wires them.

## Invariants

- **Status is a query, not a memory.** Nothing derived is ever persisted, and no answer is kept
  because it is *recent*. What is kept is kept because it is still *current*: `newProbeGate`
  (`src/gate.ts`) hands back a worktree's last snapshot while the `stat` of `.git/index`,
  `.git/HEAD` and the worktree — and the commit the base is on — all read exactly as they did when
  it was made. That is the same rule as "a failed look degrades to the last scan that could", asked
  one question earlier, which is why it is allowed at all. Three things it must keep being:
  **owned by whoever polls** (the window makes one; a one-shot `tade status` is given none, and so
  pays in full), **never in front of a failed look** (only a snapshot is kept, so what is wrong with
  a worktree is said again every beat), and **bounded in time** — a `stat` cannot see an edit in
  place to a file git already tracks, so a reuse has a ceiling (`REUSE_MS`) or a window left open
  would report a worktree clean for as long as you watched it. `TranscriptReads`
  (`src/adoption.ts`) is held beside it, owned the same way: a transcript is not opened while its
  own inode, size and mtime read the same — a write always moves the file's own mtime, so it needs
  no ceiling — and one that only grew is read on from its last whole line, provided the bytes
  before that are still there.
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
- **A probe that spawns runs in the bounded pool and is counted.** `collectStatus` fans the git
  probes out through `pooled` (`src/pool.ts`) at `GIT_POOL` at a time — bounded, because forty
  `fork`s at once on a loaded machine are worse than forty in a row — and `gitLoad()` is the
  instrument the probe test holds that to (`test/scan.probe.test.ts`: spawns and how many at once,
  never a stretch of wall clock). Work out an answer from output already in hand rather than
  spawning for it: `ahead`/`behind` come off `git status --branch` where the upstream is the base,
  and contained-in-the-base is `ahead === 0` rather than another `merge-base`. The same goes for
  whoever reads status: what the window needs of output status already has is carried in the answer
  as data (each dirty path's own `XY` in `GitSnapshot.xy`), never spawned for again beside it.
- **Anything the pool runs must not throw**, because one rejection takes the whole fan-out with it
  and `collectStatus`'s last-resort catch answers with an empty world — thirteen tasks reported as
  none. `probeOf` catches for exactly this reason.

- **A window's look happens in a child process, not in the window.** `Live` and `tade_status` ask
  one `StatusCollector` (`src/collector.ts`; registry `src/collectors.ts`; both implementations held
  to `test/conformance.ts`), and the window's is `child` (`src/forked.ts`): the fork storm, the
  porcelain parsing and the transcript scan — measured at 140 MB of garbage a beat against one
  laptop's transcripts (`scripts/look-cost.ts --adopt`) before `TranscriptReads` — are the
  child's, and so are the gate and the reads. So **whatever a probe is
  given must cross a pipe as plain data** (`StatusAsk`): a function in `StatusOptions` is for tests
  and one-shots only, and anything only the window holds goes as data read just before the ask, the
  way its lanes go as a `LivenessTable` (`livenessTableFrom`). A look that could not be had —
  past its deadline, a child that died, an answer that is not one — is `unknown` with why, never an
  empty world, and the window keeps the last look that could. The child dies with the window when
  its channel closes, and one that keeps dying is waited on (`restartWait`), never forked per beat.

- **An answer that is a function of commit ids is kept by them, with no ceiling.** The conflict
  forecast (`src/conflicts.ts`) keeps each `git merge-tree` by the two commits it merged, in the
  collector's `Held` beside the gate, and asks at most `MERGES_PER_LOOK` new ones a beat — the rest
  come on the next. The heads come off the gated git look, so nothing new is stat'ed for it. What the
  window alone knows (which files each agent wrote) crosses on the liveness table as data (`wrote`).
- **Another machine's branches are merged in the mirror, never in the checkout.** Where one
  repository is a project here and on a remote, the window's links fetch that machine's branches
  into `<home>/projects/<p>/mirror.git` (`src/mirror.ts`: a bare repository borrowing the checkout's
  objects as alternates, a namespace per machine) and hand the live ones to every look as data
  (`StatusAsk.elsewhere`, core's `elsewhere.ts`); `forecastConflicts` merges each local live branch
  with each of them **there**, in the same budget and the same keep by commit pair, as an
  `elsewhere` conflict. Only a head the mirror holds is handed over (`liveThere`), so no merge asks
  git about an object it has not got. A fetch git finds a hole under — the checkout gc'd an object a
  mirror's branch leaned on — makes the mirror again from nothing, once (`whole`), because it is
  derived and safe to delete. `test/mirror.test.ts` holds the checkout's refs, config and objects
  byte-identical across a fetch and a merge.
- **A probe that costs a spawn every beat is asked for, and held by whoever asks.** Which ports
  each lane listens on (`src/ports.ts`, `lsof` plus `ps`) is `StatusOptions.ports` /
  `StatusAsk.ports`: `tade status` asks once, and the window asks every beat while `PortsHeld` (in
  the collector's `Held`, beside the gate) answers from the last look for `PORTS_MS` — `lsof` is a
  tenth of a second on a busy laptop. Absent is "not asked or could not look", never `[]`. What is
  drawn of them is `devServerPorts` (core): a link per page a dev server serves.

## Steps

1. Add the fact's schema to `packages/core/src/model.ts` (e.g. a field on `GitSnapshot` or
   `AgentSignal`, or a new top-level signal).
2. Implement the probe in `packages/status/src/<name>.ts`, exported from `src/index.ts`. Make
   external dependencies injectable through `StatusOptions` (see `processes`) so tests control them,
   and anything the window must supply a field of `StatusAsk`, as data.
3. Test it against **real** inputs: `test/fixtures/mkrepo.ts` for git (never mock git), checked-in
   fixtures for file formats.
4. Feed it into `ProbeBundle` in `collectStatus`, then follow the `change-task-state` skill if it
   changes derivation.
5. Add a never-throws case to `packages/status/test/status.test.ts` (missing tool, bad data).
6. `pnpm check`.
