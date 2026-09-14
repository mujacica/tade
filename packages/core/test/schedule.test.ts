import { describe, expect, it } from 'vitest'
import {
  describeWhen,
  dueNow,
  momentOf,
  ON_TIME_MS,
  runsOf,
  scheduleEnded,
  type When,
  wallClock,
  whenProblem,
} from '../src/schedule.ts'

const at = (iso: string) => Date.parse(iso)
const iso = (moments: number[]) => moments.map((moment) => new Date(moment).toISOString())
const FAR = at('2030-01-01T00:00:00Z')

describe('when a schedule runs', () => {
  it('runs every so often, the first time one interval after it was made', () => {
    const made = at('2026-09-15T12:00:00Z')
    expect(iso(runsOf({ every: '2h' }, made, made - 1, FAR, 3))).toEqual([
      '2026-09-15T14:00:00.000Z',
      '2026-09-15T16:00:00.000Z',
      '2026-09-15T18:00:00.000Z',
    ])
    // Asked later, it counts on from where it was made, not from when it was asked.
    expect(iso(runsOf({ every: '90m' }, made, at('2026-09-15T15:10:00Z'), FAR, 1))).toEqual([
      '2026-09-15T16:30:00.000Z',
    ])
  })

  it('runs at times of day, on the days it says, in its own time zone', () => {
    const made = at('2026-09-14T10:00:00Z') // a Monday
    const daily: When = { every: 'day', times: ['09:00', '13:00', '17:00'], tz: 'UTC' }
    expect(iso(runsOf(daily, made, made, FAR, 4))).toEqual([
      '2026-09-14T13:00:00.000Z',
      '2026-09-14T17:00:00.000Z',
      '2026-09-15T09:00:00.000Z',
      '2026-09-15T13:00:00.000Z',
    ])
    const weekly: When = {
      every: 'week',
      on: ['mon', 'thu'],
      times: ['09:00'],
      tz: 'Europe/Sarajevo',
    }
    // Nine in the morning in Sarajevo is seven in UTC in summer.
    expect(iso(runsOf(weekly, made, made, FAR, 3))).toEqual([
      '2026-09-17T07:00:00.000Z',
      '2026-09-21T07:00:00.000Z',
      '2026-09-24T07:00:00.000Z',
    ])
    const weekdays: When = { every: 'weekday', times: ['08:30'], tz: 'UTC' }
    expect(
      iso(runsOf(weekdays, at('2026-09-18T12:00:00Z'), at('2026-09-18T12:00:00Z'), FAR, 2)),
    ).toEqual(['2026-09-21T08:30:00.000Z', '2026-09-22T08:30:00.000Z'])
    const monthly: When = { every: 'month', on: [1, 15], times: ['08:00'], tz: 'UTC' }
    expect(iso(runsOf(monthly, made, made, FAR, 3))).toEqual([
      '2026-09-15T08:00:00.000Z',
      '2026-10-01T08:00:00.000Z',
      '2026-10-15T08:00:00.000Z',
    ])
  })

  it('keeps nine o’clock at nine o’clock across a change of the clocks', () => {
    const made = at('2026-10-23T12:00:00Z')
    const daily: When = { every: 'day', times: ['09:00'], tz: 'Europe/Sarajevo' }
    // Summer time ends on the 25th: the same nine o'clock is an hour later in UTC.
    expect(iso(runsOf(daily, made, made, FAR, 3))).toEqual([
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ])
    expect(
      wallClock(momentOf('Europe/Sarajevo', 2026, 10, 25, 9, 0), 'Europe/Sarajevo'),
    ).toMatchObject({
      hour: 9,
      minute: 0,
    })
  })

  it('runs by cron, with cron’s own rule for days', () => {
    const made = at('2026-09-14T00:00:00Z')
    // Weekdays at nine.
    expect(
      iso(runsOf({ cron: '0 9 * * 1-5', tz: 'UTC' }, made, at('2026-09-18T10:00:00Z'), FAR, 2)),
    ).toEqual(['2026-09-21T09:00:00.000Z', '2026-09-22T09:00:00.000Z'])
    // Every fifteen minutes in one hour.
    expect(iso(runsOf({ cron: '*/15 14 * * *', tz: 'UTC' }, made, made, FAR, 5))).toEqual([
      '2026-09-14T14:00:00.000Z',
      '2026-09-14T14:15:00.000Z',
      '2026-09-14T14:30:00.000Z',
      '2026-09-14T14:45:00.000Z',
      '2026-09-15T14:00:00.000Z',
    ])
  })

  it('runs once at a moment, and stops after a count or an end', () => {
    const made = at('2026-09-15T12:00:00Z')
    expect(iso(runsOf({ at: '2026-09-15T18:00:00Z' }, made, made, FAR, 5))).toEqual([
      '2026-09-15T18:00:00.000Z',
    ])
    expect(
      runsOf({ every: '1h', until: '2026-09-15T14:30:00Z' }, made, made, FAR, 10),
    ).toHaveLength(2)
    expect(
      scheduleEnded(
        { when: { at: '2026-09-15T18:00:00Z' }, created: '2026-09-15T12:00:00Z' },
        at('2026-09-15T18:00:00Z'),
        1,
        at('2026-09-15T18:01:00Z'),
      ),
    ).toBe(true)
    expect(
      scheduleEnded(
        { when: { every: '1h', count: 3 }, created: '2026-09-15T12:00:00Z' },
        null,
        3,
        made,
      ),
    ).toBe(true)
    expect(
      scheduleEnded({ when: { every: '1h' }, created: '2026-09-15T12:00:00Z' }, null, 0, made),
    ).toBe(false)
  })

  it('refuses a rule it could not keep, with what is wrong', () => {
    expect(whenProblem({ every: '1h' })).toBeNull()
    expect(whenProblem({})).toBe('say when with exactly one of at, every or cron')
    expect(whenProblem({ every: 'fortnight' })).toMatch(/is neither a length/)
    expect(whenProblem({ every: 'day', times: ['25:00'] })).toMatch(/not a time of day/)
    expect(whenProblem({ cron: '0 9 * *' })).toMatch(/is not a cron rule/)
    expect(whenProblem({ every: '1d', tz: 'Mars/Olympus' })).toMatch(/is not a time zone/)
  })
})

describe('whether a schedule is due', () => {
  const schedule = (when: When, missed: 'once' | 'skip' = 'once') => ({
    when,
    missed,
    created: '2026-09-15T08:00:00Z',
  })

  it('runs on time, once for its latest moment', () => {
    const hourly = schedule({ every: '1h' })
    expect(dueNow(hourly, null, 0, at('2026-09-15T08:30:00Z'))).toBeNull()
    expect(dueNow(hourly, null, 0, at('2026-09-15T09:00:30Z'))).toEqual({
      run: true,
      due: at('2026-09-15T09:00:00Z'),
      missed: 0,
    })
    // Having run for nine, nothing is due again until ten.
    expect(dueNow(hourly, at('2026-09-15T09:00:00Z'), 1, at('2026-09-15T09:30:00Z'))).toBeNull()
  })

  it('catches up once for what it missed while Wilco was closed, or skips it', () => {
    const now = at('2026-09-15T13:20:00Z')
    expect(dueNow(schedule({ every: '1h' }), at('2026-09-15T09:00:00Z'), 1, now)).toEqual({
      run: true,
      due: at('2026-09-15T13:00:00Z'),
      missed: 4,
    })
    expect(dueNow(schedule({ every: '1h' }, 'skip'), at('2026-09-15T09:00:00Z'), 1, now)).toEqual({
      run: false,
      due: at('2026-09-15T13:00:00Z'),
      missed: 4,
    })
    // Opened a minute after it came due: on time, with the ones before it missed.
    expect(
      dueNow(
        schedule({ every: '1h' }, 'skip'),
        at('2026-09-15T09:00:00Z'),
        1,
        at('2026-09-15T13:00:00Z') + ON_TIME_MS - 1,
      ),
    ).toMatchObject({
      run: true,
      missed: 3,
    })
  })

  it('stops once it has run as many times as it said', () => {
    expect(
      dueNow(
        schedule({ every: '1h', count: 2 }),
        at('2026-09-15T10:00:00Z'),
        2,
        at('2026-09-15T11:00:00Z'),
      ),
    ).toBeNull()
  })
})

describe('when a schedule runs, in words', () => {
  const clock = (moment: number) => new Date(moment).toISOString().slice(0, 16).replace('T', ' ')

  it('says every rule the way a person would', () => {
    expect(describeWhen({ every: '1h' }, clock)).toBe('every hour')
    expect(describeWhen({ every: '90m' }, clock)).toBe('every 90 minutes')
    expect(describeWhen({ every: '2d' }, clock)).toBe('every 2 days')
    expect(describeWhen({ every: 'day', times: ['09:00', '13:00', '17:00'] }, clock)).toBe(
      'every day at 09:00, 13:00 and 17:00',
    )
    expect(describeWhen({ every: 'weekday', times: ['08:30'] }, clock)).toBe(
      'every weekday at 08:30',
    )
    expect(describeWhen({ every: 'week', on: ['mon', 'thu'], times: ['09:00'] }, clock)).toBe(
      'every Monday and Thursday at 09:00',
    )
    expect(describeWhen({ every: 'month', on: [1, 22], times: ['08:00'] }, clock)).toBe(
      'on the 1st and 22nd of every month at 08:00',
    )
    expect(describeWhen({ at: '2026-09-15T18:00:00Z' }, clock)).toBe('once, 2026-09-15 18:00')
    expect(describeWhen({ every: '1h', count: 5 }, clock)).toBe('every hour, 5 times')
    expect(describeWhen({ cron: '0 9 * * 1-5' }, clock)).toBe('on cron 0 9 * * 1-5')
  })
})
