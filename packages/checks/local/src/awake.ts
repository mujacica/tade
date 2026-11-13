import { AWAKE, beat, type Waking } from '@tade/core'

// A check's time limit, counted in the time the machine was awake.
//
// A timer here counts a closed lid as time: on this laptop a twenty-minute
// suite with the lid shut fifteen minutes in was killed at the first dark wake
// five minutes later, recorded `timed out`, and the red batch named whoever's
// commits it covered. No clock Node offers stops in a sleep on every platform,
// so the runner beats instead and folds the beats here: a gap past
// `AWAY_AFTER_MS` is the machine having been away (`beat`, the same rule the
// window wakes agents by), and counts as nothing; every other gap is awake.
//
// Pure: the clock is handed in, so a test sleeps the machine by moving a number.

export interface Awake {
  waking: Waking
  /** Milliseconds awake since the run started. */
  awake: number
  /** Whether the machine was away at any point since. */
  slept: boolean
}

/** A run starting at `now`. */
export function startAwake(now: number): Awake {
  return { waking: beat(AWAKE, now), awake: 0, slept: false }
}

/** One beat: the gap since the last counted as awake, unless the machine was away for it. */
export function awakeAt(was: Awake, now: number): Awake {
  const waking = beat(was.waking, now)
  if (waking.slept !== null) return { waking, awake: was.awake, slept: true }
  // A clock that went backwards is not time awake either.
  const gap = Math.max(0, now - (was.waking.beat ?? now))
  return { waking, awake: was.awake + gap, slept: was.slept }
}
