import { describe, expect, it } from 'vitest'
import { lastSleepOrWake, sleptBetween, sleptSince } from '../src/slept.ts'

// What `sysctl -n kern.sleeptime kern.waketime` prints, read: the kernel's
// word on whether a run was slept through, never the clock's.

const PRINTED = [
  '{ sec = 1795697026, usec = 431050 } Thu Nov 26 13:43:46 2026',
  '{ sec = 1795715061, usec = 724712 } Thu Nov 26 18:44:21 2026',
  '',
].join('\n')
const WOKE = 1795715061724

describe('whether the machine slept', () => {
  it('is the later of the last sleep and the last wake', () => {
    expect(lastSleepOrWake(PRINTED)).toBe(WOKE)
  })

  it('is yes for a run that began before the last wake, and no for one after it', () => {
    expect(sleptSince(WOKE - 60_000, PRINTED)).toEqual({ slept: true, trouble: null })
    expect(sleptSince(WOKE + 60_000, PRINTED)).toEqual({ slept: false, trouble: null })
  })

  it('cannot be told from something that is not a time, and says what was printed', () => {
    expect(sleptSince(0, 'unknown oid')).toEqual({
      slept: null,
      trouble: 'sysctl printed no sleep or wake time: unknown oid',
    })
  })

  it("is this machine's own answer, never a throw", async () => {
    const answer = await sleptBetween(Date.now() + 60_000, Date.now() + 60_000)
    if (process.platform === 'darwin') expect(answer).toEqual({ slept: false, trouble: null })
    else expect(answer.slept).toBeNull()
  })
})
