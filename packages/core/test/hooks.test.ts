import {
  type Bell,
  bellDue,
  bellSaid,
  bellStands,
  bellWhen,
  doorbellRings,
  dueNow,
  HOOK_SECRETS,
  HOOK_SOURCES,
  type HookAddress,
  INTAKE_SOURCES,
  rungFrom,
  type WatchDoorbell,
} from '@tade/core'
import { describe, expect, it } from 'vitest'

// The doorbell's rules (REMOTE-TADE §6.1): which schedule one delivery rings,
// what its line says when it is read back, and how the poll beside a watch
// slows while deliveries arrive — and never counts what a doorbell made
// unnecessary as runs missed while Tade was closed.

const GITHUB: WatchDoorbell = { source: 'github', events: ['issues', 'issue_comment'] }
const SLACK: WatchDoorbell = { source: 'slack', events: ['app_mention'], input: 'channel' }

const at = (over: Partial<HookAddress> = {}): HookAddress => ({
  source: 'github',
  event: 'issues',
  where: 'github.com/acme/app',
  ...over,
})

describe('which schedule a delivery rings', () => {
  const repo = { input: {}, repository: 'github.com/acme/app' }

  it('rings a watch on the repository it named, for a kind it said can change its look', () => {
    expect(doorbellRings(GITHUB, at(), repo)).toBe(true)
    expect(doorbellRings(GITHUB, at({ event: 'issue_comment' }), repo)).toBe(true)
    // Another repository, another kind, another source: none of them.
    expect(doorbellRings(GITHUB, at({ where: 'github.com/acme/other' }), repo)).toBe(false)
    expect(doorbellRings(GITHUB, at({ event: 'push' }), repo)).toBe(false)
    expect(doorbellRings(GITHUB, at({ source: 'linear' }), repo)).toBe(false)
  })

  it('rings for a ping whatever the kinds, because that is the hook saying it is there', () => {
    expect(doorbellRings(GITHUB, at({ event: 'ping' }), repo)).toBe(true)
  })

  it('reads a repository, a channel and a team as one thing however they are spelt', () => {
    expect(doorbellRings(GITHUB, at({ where: 'GitHub.com/Acme/App' }), repo)).toBe(true)
    const channel = { input: { channel: 'c0abcdef' }, repository: null }
    expect(
      doorbellRings(
        SLACK,
        at({ source: 'slack', event: 'app_mention', where: 'C0ABCDEF' }),
        channel,
      ),
    ).toBe(true)
    expect(
      doorbellRings(
        SLACK,
        at({ source: 'slack', event: 'app_mention', where: 'C0OTHER' }),
        channel,
      ),
    ).toBe(false)
  })

  it('rings a schedule whose project could not say its repository only for a delivery that named none', () => {
    // Git did not answer in time, or there is no remote: one delivery about a
    // repository is not taken to be about this one.
    expect(doorbellRings(GITHUB, at(), { input: {}, repository: null })).toBe(false)
    expect(
      doorbellRings(SLACK, at({ source: 'slack', event: 'app_mention' }), {
        input: {},
        repository: null,
      }),
    ).toBe(false)
  })

  it('rings every schedule of its kind for a delivery that named nowhere', () => {
    // One look too many finds nothing new; one too few is the delivery lost.
    const nowhere = at({ where: null })
    expect(doorbellRings(GITHUB, nowhere, { input: {}, repository: 'github.com/acme/other' })).toBe(
      true,
    )
    expect(doorbellRings(GITHUB, { ...nowhere, event: 'push' }, repo)).toBe(false)
  })
})

describe('the secrets and the sources', () => {
  it('has a secret and a variable for every source a delivery may come from, each its own', () => {
    for (const source of HOOK_SOURCES) {
      expect(INTAKE_SOURCES).toContain(source)
      expect(HOOK_SECRETS[source].key).toMatch(/^[a-z_]+$/)
      expect(HOOK_SECRETS[source].env).toMatch(/^[A-Z_]+$/)
      expect(HOOK_SECRETS[source].means).toContain(`/hooks/${source}`)
    }
    const keys = HOOK_SOURCES.map((source) => HOOK_SECRETS[source].key)
    expect(new Set(keys).size).toBe(keys.length)
    // The local door has nothing to ring: its next look is five minutes away.
    expect(HOOK_SOURCES).not.toContain('cli')
  })
})

describe('a delivery’s line, read back', () => {
  it('reads what it woke, whether it verified and from where, and nothing else', () => {
    expect(
      rungFrom({
        type: 'hook_rung',
        detail: { source: 'github', delivery: 'abc', verified: true, woke: ['intake', 7] },
      }),
    ).toEqual({ source: 'github', delivery: 'abc', verified: true, woke: ['intake'] })
  })

  it('reads a line it cannot place as no line at all', () => {
    expect(
      rungFrom({ type: 'watch_checked', detail: { source: 'github', verified: true } }),
    ).toBeNull()
    expect(rungFrom({ type: 'hook_rung', detail: { source: 'jira', verified: true } })).toBeNull()
    expect(rungFrom({ type: 'hook_rung', detail: { source: 'github' } })).toBeNull()
  })
})

const HOUR = 3_600_000
const MIN = 60_000
const T0 = Date.parse('2026-10-17T12:00:00Z')
const watch = {
  when: { every: '10m' },
  missed: 'once' as const,
  created: new Date(T0).toISOString(),
}
const bell = (over: Partial<Bell> = {}): Bell => ({
  source: 'github',
  woke: T0 + 5 * MIN,
  refused: null,
  missed: null,
  ...over,
})

describe('whether a doorbell stands', () => {
  it('stands while a wake is the newest of the three moments', () => {
    expect(bellStands(undefined)).toBe(false)
    expect(bellStands(bell())).toBe(true)
    expect(bellStands(bell({ refused: T0, missed: T0 }))).toBe(true)
    // A delivery that did not verify since, or a poll that found what no
    // delivery said: either way it is not known to work.
    expect(bellStands(bell({ refused: T0 + 6 * MIN }))).toBe(false)
    expect(bellStands(bell({ missed: T0 + 6 * MIN }))).toBe(false)
  })

  it('slows a watch that polls oftener than hourly, and never makes one look oftener', () => {
    expect(bellWhen({ every: '10m' }, bell())).toEqual({ every: '1h' })
    expect(bellWhen({ every: '10m', count: 3 }, bell())).toEqual({ every: '1h', count: 3 })
    expect(bellWhen({ every: '10m' }, bell({ missed: T0 + HOUR }))).toEqual({ every: '10m' })
    expect(bellWhen({ every: '1d' }, bell())).toEqual({ every: '1d' })
    expect(bellWhen({ every: 'weekday', times: ['09:00'] }, bell())).toEqual({
      every: 'weekday',
      times: ['09:00'],
    })
  })
})

describe('when a watch a doorbell rings polls', () => {
  it('is its own rule exactly where no doorbell has ever rung', () => {
    const now = T0 + 25 * MIN
    expect(bellDue(watch, T0 + 10 * MIN, 1, now, { looks: [{ at: T0 + 10 * MIN }] })).toEqual(
      dueNow(watch, T0 + 10 * MIN, 1, now),
    )
  })

  it('polls on the hour while the doorbell stands, and not at its own ten minutes', () => {
    const watched = { bell: bell(), looks: [{ at: T0 + 5 * MIN }] }
    expect(bellDue(watch, null, 0, T0 + 20 * MIN, watched)).toBeNull()
    expect(bellDue(watch, null, 0, T0 + 50 * MIN, watched)).toBeNull()
    expect(bellDue(watch, null, 0, T0 + HOUR + MIN, watched)).toEqual({
      run: true,
      due: T0 + HOUR,
      missed: 0,
    })
  })

  it('counts a delivery’s look as a look, so the poll is not due again just after one', () => {
    const watched = {
      bell: bell({ woke: T0 + HOUR + 30_000 }),
      looks: [{ at: T0 + HOUR + 40_000 }],
    }
    expect(bellDue(watch, T0, 1, T0 + HOUR + 2 * MIN, watched)).toBeNull()
  })

  it('goes back to its own rule when the doorbell falls, without calling what it skipped missed', () => {
    // Stood from 0:05 until a poll at 1:00 found what no delivery said; now is
    // 1:12. The ten-minute moments between were left out on purpose, not
    // while Tade was closed — so the run is due at 1:10 with nothing missed.
    const watched = {
      bell: bell({ missed: T0 + HOUR }),
      looks: [{ at: T0 + HOUR }],
    }
    expect(bellDue(watch, T0 + HOUR, 1, T0 + 72 * MIN, watched)).toEqual({
      run: true,
      due: T0 + 70 * MIN,
      missed: 0,
    })
    // Fallen through a refusal at 1:05 with the last look at 0:30: the moments
    // before the fall are not missed either.
    const refused = { bell: bell({ refused: T0 + 65 * MIN }), looks: [{ at: T0 + 30 * MIN }] }
    expect(bellDue(watch, T0 + 30 * MIN, 1, T0 + 72 * MIN, refused)).toEqual({
      run: true,
      due: T0 + 70 * MIN,
      missed: 0,
    })
  })

  it('still counts what came due while Tade was closed after the newest look', () => {
    const watched = { bell: bell({ missed: T0 + 6 * MIN }), looks: [{ at: T0 + 6 * MIN }] }
    expect(bellDue(watch, T0 + 6 * MIN, 1, T0 + 52 * MIN, watched)).toEqual({
      run: true,
      due: T0 + 50 * MIN,
      missed: 4,
    })
  })
})

describe('what a schedule’s row says about its doorbell', () => {
  it('says nothing where none has rung, and which way it went and why where one has', () => {
    expect(bellSaid(undefined)).toBe('')
    expect(bellSaid(bell())).toContain('polls hourly')
    expect(bellSaid(bell({ refused: T0 + HOUR }))).toContain('did not verify')
    expect(bellSaid(bell({ missed: T0 + HOUR }))).toContain('no delivery rang for')
  })
})
