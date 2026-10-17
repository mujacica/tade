import type { EventType } from './events.ts'

// What a name in the journal means now, for names Tade wrote once and no longer
// writes. Beside `events.ts` rather than in it because it is a different
// question — not what Tade writes, but what it can still read.

/**
 * Names events were written under before the project was renamed. Tade never
 * writes one — it only reads them, because events.jsonl is append-only and is
 * the truth: a journal from before the rename still says when the window
 * opened and closed, and a reader that does not know the old word silently
 * loses those facts. That is not hypothetical — it is how runs from days
 * earlier stayed open and went on counting to now: nothing closed them,
 * because the closings were called something else, and a week of runtime
 * landed in a morning's total.
 *
 * An alias read rather than another `EventType`: what Tade writes stays one
 * list nobody can add an old name back to, and what it can read is the longer
 * one. Filters are widened for the same reason — asking for `tade_opened`
 * asks about window openings, whatever they were called when they happened.
 */
export const RENAMED_TYPES = {
  wilco_opened: 'tade_opened',
  wilco_closing: 'tade_closing',
} as const satisfies Record<string, EventType>

/** A name in the journal that Tade no longer writes. */
export type LegacyEventType = keyof typeof RENAMED_TYPES

/** Anything a reader may ask for: what is written now, and what once was. */
export type ReadableEventType = EventType | LegacyEventType

/** What a name in the journal means now. Anything current is itself. */
export function typeNow(type: string): EventType {
  return (RENAMED_TYPES as Record<string, EventType>)[type] ?? (type as EventType)
}

/**
 * Every name in the journal that reads as one of these types — for a filter
 * that matches on the stored word, like the index's `type IN (...)`.
 */
export function typeNames(types: readonly ReadableEventType[]): string[] {
  const wanted = new Set(types.map(typeNow))
  const names = new Set<string>(types)
  for (const [was, now] of Object.entries(RENAMED_TYPES)) if (wanted.has(now)) names.add(was)
  return [...names]
}
