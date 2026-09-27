// What SCHEDULES shows of a watch's trouble, and nothing about what a watch is.
//
// Its own file, beside `queue-view.ts` and for the same reasons: three others
// need the words — the section that draws the warning, the wire that hushes one,
// and the wire that drops it again when a look works — and the reasoning below
// is about when a warning may stop being drawn rather than about any of those
// three.
//
// Pure, and structural: anything with a `hushed` list satisfies it, so this
// imports nothing of the window's and the window keeps one place where state
// lives.

/** Whatever carries the warnings somebody has read: `AppState` does. */
export interface Hushes {
  /** `<schedule id>\u0000<reason>` for each. */
  hushed: string[]
}

/** One watch's trouble, as `hushed` keys it: the schedule it is, and why it could not look. */
function hushKey(id: string, problem: string): string {
  return `${id}\u0000${problem}`
}

/**
 * Whether this failure is one somebody has read and hushed.
 *
 * The failure itself stays derived: SCHEDULES reads the last look, so a watch
 * that starts looking again goes quiet with nothing pressed, and one bad hour on
 * Tuesday never puts a warning beside a watch that has been fine since. What
 * this hushes is the *sentence* on its row — never the `!` on its mark, and
 * never the heading's count of what is not looking, because a broken watch a
 * person cannot see is what drawing the section at all is for.
 *
 * Keyed by the reason and not by the look. A watch failing the same way every
 * ten minutes is the complaint, and a key per look would answer it with ten
 * minutes of quiet. A different reason is different news and says so; so is the
 * same one after a look that worked, which is what `unhush` is for. Nothing here
 * is written to the layout: a window that has just opened has not looked yet, and
 * its first look either fails and says so or works and leaves nothing to hush.
 */
export function wasHushed(state: Hushes, id: string, problem: string): boolean {
  return state.hushed.includes(hushKey(id, problem))
}

/** Hush one watch's trouble: this failure, for as long as it is this failure. */
export function hush<S extends Hushes>(state: S, id: string, problem: string): S {
  const key = hushKey(id, problem)
  return state.hushed.includes(key) ? state : { ...state, hushed: [...state.hushed, key] }
}

/**
 * A look that worked, so whatever was hushed about this watch is news again:
 * trouble that comes back after it was over is trouble somebody has to hear
 * about, even where it comes back wearing the same words.
 */
export function unhush<S extends Hushes>(state: S, id: string): S {
  const kept = state.hushed.filter((key) => !key.startsWith(`${id}\u0000`))
  return kept.length === state.hushed.length ? state : { ...state, hushed: kept }
}
