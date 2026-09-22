import { describe, expect, it } from 'vitest'
import { FRAME_MS, LOOK_FLOOR_MS, LOOK_SOON_MS, lookWait } from '../src/pace.ts'

// How long the window waits before looking again. Two halves, and each is the
// other's failure: wait too long and a keystroke is not on screen when you
// look for it; wait no time at all and the loop takes the machine.

describe('waiting before the next look', () => {
  it('waits only the short wait when the last look was a while ago', () => {
    // What typing goes through: nothing has happened for a moment, so the
    // whole of the short wait is left to run and no more.
    expect(lookWait(LOOK_FLOOR_MS)).toBe(LOOK_SOON_MS)
    expect(lookWait(1_000)).toBe(LOOK_SOON_MS)
  })

  it('waits out the floor when a lane has just been looked at', () => {
    // What a printing agent goes through: asked again immediately, it waits
    // for the floor rather than going round again now.
    expect(lookWait(0)).toBe(LOOK_FLOOR_MS)
    expect(lookWait(10)).toBe(LOOK_FLOOR_MS - 10)
  })

  it('never waits longer than the floor, or less than the short wait', () => {
    for (let since = -50; since <= 500; since++) {
      const wait = lookWait(since)
      expect(wait).toBeGreaterThanOrEqual(LOOK_SOON_MS)
      expect(wait).toBeLessThanOrEqual(LOOK_FLOOR_MS)
    }
  })

  it('looks oftener than the beat, and not so often nobody could read it', () => {
    // The floor is a ceiling on the rate: both directions here, so a number
    // changed on its own has to be argued with in both.
    expect(LOOK_FLOOR_MS).toBeLessThan(FRAME_MS)
    expect(1_000 / LOOK_FLOOR_MS).toBeLessThan(35)
    expect(1_000 / LOOK_FLOOR_MS).toBeGreaterThan(1_000 / FRAME_MS)
  })
})
