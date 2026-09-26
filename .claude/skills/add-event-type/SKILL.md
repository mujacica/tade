---
name: add-event-type
description: Add a new kind of event to the journal (lane_adopted, usage, tade_opened...). Use when something happens that "what happened here?" should be able to answer later.
---

# Adding a kind of event

The journal is the only thing that remembers, so an event that is not in it is invisible forever —
and one that is in it has to be worth reading months later.

| File | What to add |
|---|---|
| `packages/core/src/events.ts` | the name in `EventType`, and its `DEFAULT_URGENCY` |
| `packages/core/src/summary.ts` | how it reads in "what has this agent been doing" |
| `packages/core/src/attention.ts` | whether it is worth interrupting a human for |
| `packages/core/src/history.ts` | only if it changes what a task *is* (waiting, state) |

`DEFAULT_URGENCY` is a `Record<EventType, Urgency>`, so the compiler will make you choose one.
Nothing else will: a type missing from `summary.ts` silently reads as nothing at all.

## Choosing the urgency

- `blocking` — a human is being waited on right now. Never dropped under backpressure, and speaks.
- `notable` — worth knowing, worth an earcon. Also the threshold at which the journal fsyncs.
- `routine` — kept for the record and read back later (`usage` is here, so spend can be summed).
- `trace` — the first thing dropped when a subscriber falls behind. Anything high-frequency.

## Rules

- **Detail is for reading back, not for reconstructing state.** Status is derived from git and the
  drivers; the journal explains *why*, and nothing should need it to work out *what*.
- **No raw lane output.** It lives in the lane's scrollback. The journal records sampled byte
  counts, so a chatty agent cannot bloat it.
- **Say what happened, not what you concluded.** `lane_exited` with a reason a human can act on
  ("the driver could not find it again") beats a boolean nobody can interpret later.
- Append after the thing happened, never before: an event for something that then failed is worse
  than no event.
- Old journals keep working. Anything reading events handles a type it has never seen by ignoring
  it, so adding one is never a migration.

## What the journal may forget

The journal keeps what only it remembers, and forgets the samples when there is no room. Everything
folds over all of `events.jsonl` — `spendFrom`, `runtimeFrom`, `statsFrom`, the briefing — so its
size is what every statistic costs to read, and 86% of it was a byte count per lane per second that
nothing anywhere reads back: 232,324 of 270,784 lines, 42 MB of 54, in eleven days.

| File | What it holds |
|---|---|
| `packages/core/src/journal.ts` | the rules, pure: `SAMPLED_TYPES`, `isSample`, `sampledThatFit` |
| `packages/workbench/src/compact.ts` | the file work: `compactJournal`, and `weighJournal` for `tade logs --size` |
| `packages/workbench/src/events.ts` | when it runs (before the file is opened for appending), and the `journal_compacted` line |
| `packages/core/src/config.ts` | `journal.max_mb`, 16 by default |

- **Only the samples may go, named by type and never by urgency.** `SAMPLED_TYPES` is `output` and
  `input` and nothing else: both are a sample of something still sitting where it was — the bytes are
  in the lane's scrollback and the line carries `{bytes: N}` — so an old one answers no question
  anybody can ask. Both happen to be `trace`, and reading urgency as the list is silently
  destructive: urgency says what is dropped when a *subscriber* falls behind, which is a different
  question. `reflected` is `trace` too, and it is the only record that a finished task was looked
  back over — dropped, Tade would look again and spend a turn per task doing it. `commit_seen` and
  `check_ran` are written once precisely because `git log` and a worktree's `checks.jsonl` cannot
  answer again. So the list is the list: nothing outside it is droppable, and adding to it is a line
  somebody argues for.
- **A journal with nothing left to drop says so rather than shrinking.** Over the ceiling with only
  records in it, compaction writes a `warning` naming what those lines are — a commit, a check, a
  turn, something you said — and deletes none of them. What it cannot bound is about a megabyte a
  day, and that is said out loud instead of met by deleting a record to hit a number. A compaction
  that dropped nothing says nothing at all: `journal_compacted` is written only when something went,
  or a line per window open is the journal growing to record that it is not growing.
- **Under the ceiling the whole check is one `stat`.** Over it, the kept lines go to a temp file,
  are fsync'd and only then renamed over the journal, so a crash anywhere before the rename leaves
  it exactly as it was. The caller holds the home lock: this rewrites the truth, and two writers
  would interleave.
- **Not a roll.** Rolling bounds the file and not the fold, and both ways out are worse: readers
  that do not follow it, so every total silently gets smaller on the day it happens — the one
  failure this codebase names as worse than no statistic at all — or readers that do, and the fold
  is exactly as long as it was.
- **The samples are cheaper at the source too.** A lane's output is summarised every
  `DEFAULT_OUTPUT_SAMPLE_MS` (`workbench/src/registry.ts`; 30s, was 1s), a thirtieth of the lines
  for the same trace. It paces nothing live — `lastOutputAt` is set on every chunk, so liveness,
  stall detection and the window's own idea of activity are unchanged.
- **The index is the one file that is always safe to delete**, and say so wherever somebody with a
  full disk will be looking: `tade logs --size`, the Journal settings group's `about`, and the top of
  `event-index.ts`. It is derived, roughly twice the journal (110 MB against 54), and rebuilt
  whenever it disagrees with the file — so `rm events.jsonl.db*` costs one rebuild on the next open.
  A compaction throws it away itself, and on `compactedAway` rather than on the sequence numbers: the
  newest line is always kept, so `maxSeq` still agrees with a file the index no longer describes.
