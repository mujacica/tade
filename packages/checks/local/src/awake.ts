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
// A gap is a suspicion, not a finding: a loaded machine fires a timer that
// late with the lid open. So the runner asks the machine (`slept.ts`) about
// each gap at the beat that saw it, and one it says it stayed up through is
// counted after all (`stayedUp`) — left out, every ninety-second stall of a
// loaded machine was time the check got for free past its limit. Where the
// machine cannot say, the gap stays left out: a closed lid is what this is for.
// `slept` is what is left: a gap nobody said was awake. A failing run is
// called slept only on the machine's own word, never on this alone.
//
// Pure: the clock is handed in, so a test sleeps the machine by moving a number.

export interface Awake {
  waking: Waking
  /** Milliseconds awake since the run started. */
  awake: number
  /** Whether any gap since was left out as the machine having been away. */
  slept: boolean
}

/** A run starting at `now`. */
export function startAwake(now: number): Awake {
  return { waking: beat(AWAKE, now), awake: 0, slept: false }
}

/**
 * One beat: the gap since the last counted as awake, unless the machine was
 * away for it — and a gap long enough to be away is awake after all when the
 * machine said it stayed up through it (`stayedUp`).
 */
export function awakeAt(was: Awake, now: number, stayedUp = false): Awake {
  const waking = beat(was.waking, now)
  if (waking.slept !== null && !stayedUp) return { waking, awake: was.awake, slept: true }
  // A clock that went backwards is not time awake either.
  const gap = Math.max(0, now - (was.waking.beat ?? now))
  return { waking, awake: was.awake + gap, slept: was.slept }
}
