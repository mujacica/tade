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
