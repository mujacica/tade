import { type EventType, type TadeEvent, typeNow } from './events.ts'

// What the journal keeps, and what it is allowed to forget.
//
// `events.jsonl` is the truth and everything folds over all of it — spend,
// runtime, the statistics, the briefing — so what it keeps is what every one
// of those costs to read. On the machine this was written for it was 54 MB and
// 270,784 lines after eleven days, and 232,324 of those lines were a byte
// count per lane per second that nothing anywhere reads back.
//
// So the rule is one sentence: the journal keeps what only it remembers, and
// forgets the samples when there is no room for them. The rules here are pure
// — what may go, and how much of it fits — and the file work is the
// workbench's.

/**
 * The only events compaction may ever drop.
 *
 * Both are a *sample* of something that is still where it was: the bytes
 * themselves live in the lane's scrollback, and the journal holds `{bytes: N}`
 * so a chatty agent cannot bloat it. Nothing reads them back — not status, not
 * spend, not the window, which reads `lastOutputAt` off the lane record — so
 * an old one answers no question anybody can ask.
 *
 * Named by *type*, though both happen to be `trace`. Urgency says what is
 * dropped first when a subscriber falls behind, which is a different question
 * from what may be dropped from the file, and reading the first as the second
 * is silently destructive: `reflected` is `trace` too, and it is the only
 * record that a finished task was looked back over — dropped, Tade would look
 * again and spend a turn per task doing it. Everything else is worse still:
 * `commit_seen` and `check_ran` are written once precisely because `git log`
 * and a worktree's `checks.jsonl` cannot answer again later. So the list is
 * the list, and adding to it is a line somebody argues for.
 */
export const SAMPLED_TYPES: readonly EventType[] = ['output', 'input']

/** Whether a line is only a sample of something still sitting where it was. */
export function isSample(e: TadeEvent): boolean {
  return SAMPLED_TYPES.includes(typeNow(e.type))
}

/** How big the journal may get before Tade compacts it. */
export interface JournalPolicy {
  maxBytes: number
}

/**
 * How many of the sampled byte counts fit, newest first.
 *
 * The bound, and the whole of it: what cannot be dropped is taken off the
 * ceiling, and what is left is how much sampling there is room for. Newest
 * first because the newest is the only one anybody would ever look at, and
 * because it makes the answer stable — a quiet week does not evict the
 * morning's trace to make room for last month's.
 *
 * `recordBytes` alone over the ceiling gives 0, which is the honest answer:
 * every sample goes and the journal is still too big, and saying so is the
 * caller's job. It is never negative and never more than there are.
 */
export function sampledThatFit(
  recordBytes: number,
  sampled: readonly number[],
  maxBytes: number,
): number {
  let room = maxBytes - recordBytes
  let fit = 0
  for (let i = sampled.length - 1; i >= 0; i--) {
    const bytes = sampled[i] ?? 0
    if (bytes > room) break
    room -= bytes
    fit++
  }
  return fit
}
