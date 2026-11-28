import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  kernelSlept,
  lastSleepOrWake,
  readSuspended,
  SUSPEND_NOISE_MS,
  type Suspended,
  sleepMarks,
  sleptBetween,
  sleptSince,
  suspendedOf,
  suspendedSlept,
} from '../src/slept.ts'

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
    const at = Date.now() + 60_000
    sleptBetween.mark?.(at)
    const answer = await sleptBetween(at, at)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(answer).toEqual({ slept: false, trouble: null })
    } else expect(answer.slept).toBeNull()
  })

  it('is not asked anywhere but macOS, and says which platform it was', async () => {
    expect(await kernelSlept('win32')(0, 1)).toEqual({
      slept: null,
      trouble: 'win32 is not asked when it slept, only macOS and Linux are',
    })
  })

  it('cannot be told from a sysctl that is missing or failed, and says which', async () => {
    // Real programs in sysctl's place: one that is not there, and one that
    // exits 1 having printed nothing.
    expect(await kernelSlept('darwin', 'tade-no-such-sysctl')(0, 1)).toEqual({
      slept: null,
      trouble: 'there is no sysctl on this machine',
    })
    expect(await kernelSlept('darwin', 'false')(0, 1)).toEqual({
      slept: null,
      trouble: 'sysctl failed: exit 1',
    })
  })
})

// Linux keeps no time of its last sleep, only how long it has slept in all:
// `/proc/uptime` less the monotonic clock, marked at every beat.

describe('whether a Linux machine slept', () => {
  it('is suspended for the uptime less the monotonic clock either side of reading it', () => {
    // 5000.12 s up, 4000 s on the monotonic clock: 1000.12 s suspended, and up
    // to 10 ms more, since /proc/uptime prints hundredths.
    expect(suspendedOf('5000.12 19000.50\n', 4_000_000, 4_000_002)).toEqual({ ms: 1_000_124 })
  })

  it('cannot be read from something that is not an uptime, or a read too slow to place', () => {
    expect(suspendedOf('', 0, 1)).toEqual({ trouble: '/proc/uptime printed no uptime: ' })
    expect(suspendedOf('5000.12 1.00\n', 0, SUSPEND_NOISE_MS)).toEqual({
      trouble: `reading /proc/uptime took ${SUSPEND_NOISE_MS} ms`,
    })
  })

  it('is yes when the total grew past the noise since the beat asked from, and no when it did not', () => {
    // A gap ninety seconds long either way: a lid closed for it, or a loaded
    // machine's late timer, which moves both clocks alike.
    const marks = sleepMarks()
    marks.mark(1_000, { ms: 500 })
    marks.mark(2_000, { ms: 500 + SUSPEND_NOISE_MS })
    expect(marks.since(2_000, { ms: 500 + 30 })).toEqual({ slept: false, trouble: null })
    expect(marks.since(2_000, { ms: 90_500 })).toEqual({ slept: true, trouble: null })
  })

  it('does not count a sleep from before the moment asked from', () => {
    const marks = sleepMarks()
    marks.mark(1_000, { ms: 0 })
    marks.mark(2_000, { ms: 90_000 })
    marks.mark(3_000, { ms: 90_010 })
    expect(marks.since(1_500, { ms: 90_010 })).toEqual({ slept: true, trouble: null })
    expect(marks.since(3_000, { ms: 90_010 })).toEqual({ slept: false, trouble: null })
  })

  it('cannot be told without a reading at or before the moment, or past a failed one', () => {
    const marks = sleepMarks()
    expect(marks.since(1_000, { ms: 0 })).toEqual({
      slept: null,
      trouble: 'the suspended time was not read when the run began',
    })
    marks.mark(1_000, { ms: 0 })
    marks.mark(2_000, { trouble: 'gone' })
    marks.mark(3_000, { ms: 0 })
    expect(marks.since(2_500, { ms: 0 })).toEqual({ slept: null, trouble: 'gone' })
    expect(marks.since(3_000, { trouble: 'late' })).toEqual({ slept: null, trouble: 'late' })
  })

  it('reads the suspended total from what the uptime file says, and why where it cannot', () => {
    // An uptime far past any monotonic clock here, so the total is plainly
    // that uptime less this process's clock — read from a file on any platform.
    const dir = tmp('tade-slept-')
    const file = join(dir, 'uptime')
    writeFileSync(file, '9000000.00 1.00\n')
    const read = readSuspended(file)
    if (!('ms' in read)) throw new Error(`no reading: ${read.trouble}`)
    const clock = Number(process.hrtime.bigint()) / 1e6
    expect(read.ms).toBeGreaterThan(9_000_000_000 - clock - 1_000)
    expect(read.ms).toBeLessThanOrEqual(9_000_000_000 - clock + 1_000)
    const gone = readSuspended(join(dir, 'missing'))
    expect('trouble' in gone && gone.trouble).toMatch(/^\/proc\/uptime could not be read: ENOENT/)
  })

  it('answers from the total marked at the beat asked from and the total now', async () => {
    let now: Suspended = { ms: 1_000 }
    const asleep = suspendedSlept(() => now)
    asleep.mark?.(5_000)
    expect(await asleep(5_000, 6_000)).toEqual({ slept: false, trouble: null })
    now = { ms: 91_000 }
    expect(await asleep(5_000, 96_000)).toEqual({ slept: true, trouble: null })
    now = { trouble: '/proc/uptime could not be read: EACCES' }
    expect(await asleep(5_000, 97_000)).toEqual({
      slept: null,
      trouble: '/proc/uptime could not be read: EACCES',
    })
  })
})
