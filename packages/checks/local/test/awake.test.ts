import { AWAY_AFTER_MS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { awakeAt, startAwake } from '../src/awake.ts'

// The clock is a number the test moves: a sleep here is an hour added, never
// an hour waited.

const HOUR = 3_600_000

const beats = (...at: number[]) => at.slice(1).reduce(awakeAt, startAwake(at[0] ?? 0))

describe('time awake', () => {
  it('is every gap between beats while the machine stays up', () => {
    expect(beats(0, 1_000, 2_000, 3_000)).toMatchObject({ awake: 3_000, slept: false })
  })

  it('leaves out the time the machine was away, and says it was', () => {
    // A beat a second, and a lid closed for an hour after the second one: two
    // seconds awake before it and one after, not an hour and three seconds.
    const over = beats(0, 1_000, 2_000, 2_000 + HOUR, 3_000 + HOUR)
    expect(over).toMatchObject({ awake: 3_000, slept: true })
  })

  it('counts a gap just short of being away as awake, and one at it as asleep', () => {
    expect(beats(0, AWAY_AFTER_MS - 1)).toMatchObject({ awake: AWAY_AFTER_MS - 1, slept: false })
    expect(beats(0, AWAY_AFTER_MS)).toMatchObject({ awake: 0, slept: true })
  })

  it('counts nothing for a clock that went backwards', () => {
    expect(beats(HOUR, 1_000, 2_000)).toMatchObject({ awake: 1_000, slept: false })
  })
})
