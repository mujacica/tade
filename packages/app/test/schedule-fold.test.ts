import { type TadeEvent, watchedFrom } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { KEPT, OWED, ScheduleFold } from '../src/schedule-fold.ts'

// What a window keeps of each schedule in place of every line it wrote. The
// claim is that what is read off it is what the whole journal says, except
// how far back the runs and looks to draw go — so that is what is tested,
// against `watchedFrom` over every line.

let seq = 0
const T0 = Date.parse('2026-10-01T00:00:00Z')

const line = (
  type: string,
  minutes: number,
  detail: Record<string, unknown>,
  task: string | null = null,
): TadeEvent =>
  ({
    seq: ++seq,
    ts: new Date(T0 + minutes * 60_000).toISOString(),
    type,
    urgency: 'routine',
    task,
    lane: null,
    run: null,
    detail,
  }) as TadeEvent

const fired = (minutes: number, ran = true, schedule = 'nightly') =>
  line('schedule_fired', minutes, {
    schedule,
    due: new Date(T0 + minutes * 60_000).toISOString(),
    missed: 0,
    ran,
  })

const looked = (minutes: number, detail: Record<string, unknown>, schedule = 'review') =>
  line('watch_checked', minutes, { schedule, found: 0, fresh: [], left: 0, ...detail })

const folded = (lines: readonly TadeEvent[]) => {
  const fold = new ScheduleFold()
  for (const one of lines) fold.add(one)
  return fold
}

describe('what a schedule has done, folded', () => {
  it('counts every run it ever had, and keeps the newest to draw', () => {
    const lines = Array.from({ length: KEPT * 3 }, (_, i) => fired(i * 5, i % 4 !== 0))
    const { ran, runs } = folded([...lines, fired(1, true, 'other')]).runsOf('nightly')
    // What a schedule that runs N times stops at: every run, not the drawn ones.
    expect(ran).toBe(lines.filter((one) => one.detail.ran).length)
    expect(runs).toHaveLength(KEPT)
    expect(runs.at(-1)?.due).toBe(T0 + (KEPT * 3 - 1) * 5 * 60_000)
    expect(runs.map((one) => one.due)).toEqual([...runs.map((one) => one.due)].sort())
    expect(folded([]).runsOf('nightly')).toEqual({ ran: 0, runs: [] })
  })

  it('says what a watch has done as the whole journal does, but for how many looks are kept', () => {
    const lines = [
      looked(0, { since: 'cursor-1' }),
      line('watch_found', 1, { schedule: 'review', key: 'pr:1', title: 'One' }, 'app/one'),
      // Every look after the one that said where to start could not look —
      // more of them than are kept — so where the next starts is a look long
      // gone from the newest.
      ...Array.from({ length: KEPT + 5 }, (_, i) =>
        looked(2 + i, { problem: 'nothing answered', trouble: 'unreachable' }),
      ),
      line('watch_found', 90, { schedule: 'review', key: 'pr:2', title: 'Two', told: 'you' }),
      looked(91, { since: 'other', problem: 'refused' }, 'elsewhere'),
    ]
    const all = watchedFrom(lines, 'review')
    const kept = folded(lines).watchedOf('review')
    expect(all.since).toBe('cursor-1')
    expect(kept.since).toBe(all.since)
    expect(kept.seen).toEqual(all.seen)
    expect(kept.findings).toEqual(all.findings)
    expect(kept.looks).toEqual(all.looks.slice(0, KEPT))
  })

  it('takes a later look that worked and said nothing as where the next starts', () => {
    const lines = [
      looked(0, { since: 'cursor-1' }),
      looked(1, { since: '' }),
      ...Array.from({ length: KEPT }, (_, i) => looked(2 + i, { problem: 'no' })),
    ]
    expect(watchedFrom(lines, 'review').since).toBeNull()
    expect(folded(lines).watchedOf('review').since).toBeNull()
  })

  it('reads nothing off a line that names no schedule', () => {
    const fold = folded([line('schedule_fired', 0, { due: 'x' }), line('watch_found', 0, {})])
    expect(fold.runsOf('undefined')).toEqual({ ran: 0, runs: [] })
    expect(fold.watchedOf('undefined').findings).toEqual([])
  })
})

describe('a watch’s doorbell, folded', () => {
  // What `bellDue` slows the poll by (`hooks.ts`): a delivery that verified
  // woke it, its source sent one that did not, or a look nothing rang for
  // found something new. The next look after a wake is the doorbell's.
  const rung = (minutes: number, detail: Record<string, unknown>) =>
    line('hook_rung', minutes, { source: 'github', delivery: 'ab12', ...detail })

  it('has no bell for a watch no delivery ever woke', () => {
    const fold = folded([
      looked(0, { since: 'x', fresh: ['k'] }),
      rung(1, { verified: true, woke: ['other'] }),
    ])
    expect(fold.watchedOf('review').bell).toBeUndefined()
  })

  it('remembers the wake, and does not count the look it made as the poll missing anything', () => {
    const fold = folded([
      rung(10, { verified: true, woke: ['review', 'other'] }),
      looked(10.1, { since: 'x', fresh: ['pr:1'] }),
    ])
    expect(fold.watchedOf('review').bell).toEqual({
      source: 'github',
      woke: T0 + 10 * 60_000,
      refused: null,
      missed: null,
    })
  })

  it('counts a look nothing rang for that found something new as the poll finding what no delivery said', () => {
    const fold = folded([
      rung(10, { verified: true, woke: ['review'] }),
      looked(10.1, { since: 'x' }),
      looked(70, { since: 'y', fresh: ['pr:2'] }),
      // A look that found nothing new, or could not look, is not that.
      looked(80, { since: 'z' }),
      looked(90, { problem: 'refused', fresh: ['pr:3'] }),
    ])
    expect(fold.watchedOf('review').bell?.missed).toBe(T0 + 70 * 60_000)
  })

  it('reads a delivery that did not verify against every schedule its source woke', () => {
    const fold = folded([
      rung(10, { verified: true, woke: ['review'] }),
      rung(20, { verified: false, delivery: '', why: 'signature' }),
      line('hook_rung', 30, { source: 'slack', delivery: '', verified: false }),
    ])
    expect(fold.watchedOf('review').bell?.refused).toBe(T0 + 20 * 60_000)
  })

  it('reads a line it cannot place as nothing', () => {
    const fold = folded([
      line('hook_rung', 1, { source: 'jira', verified: true, woke: ['review'] }),
    ])
    expect(fold.watchedOf('review').bell).toBeUndefined()
  })
})

describe('what deliveries named for a look, folded', () => {
  // A Slack mention inside a thread, which no poll of the channel can see: a
  // delivery names it (`HookRung.item`), its next look is handed it, and a look
  // that read it to the end lets go of it — so a window closed before a look
  // could read one hands it to the first look after it opens.
  const mention = (minutes: number, item: string, woke = ['mentions']) =>
    line('hook_rung', minutes, { source: 'slack', delivery: 'd', verified: true, woke, item })
  const A = '1727445000.000200/1727442000.000100'
  const B = '1727445100.000300/1727442000.000100'

  it('hands every look what was named until one says it read it', () => {
    const fold = folded([
      mention(1, A),
      mention(2, B),
      mention(3, A),
      looked(4, { since: 'x', read: [A] }, 'mentions'),
    ])
    expect(fold.watchedOf('mentions').rang).toEqual([B])
    expect(folded([mention(1, A)]).watchedOf('mentions').rang).toEqual([A])
  })

  it('is let go of by no look that could not look, and by none that said nothing of it', () => {
    const fold = folded([
      mention(1, A),
      looked(2, { problem: 'Slack rate limited the look', read: [A] }, 'mentions'),
      looked(3, { since: 'x' }, 'mentions'),
    ])
    expect(fold.watchedOf('mentions').rang).toEqual([A])
    const done = folded([mention(1, A), looked(2, { since: 'x', read: [A] }, 'mentions')])
    expect(done.watchedOf('mentions').rang).toBeUndefined()
  })

  it('is held for the schedules it woke and no other, and only so many', () => {
    const lines = Array.from({ length: OWED + 4 }, (_, n) =>
      mention(n, `${1727445000 + n}.000100/1727442000.000100`),
    )
    const rang = folded([...lines, mention(99, A, ['other'])]).watchedOf('mentions').rang
    expect(rang).toHaveLength(OWED)
    expect(rang?.[0]).toBe(`${1727445000 + 4}.000100/1727442000.000100`)
    expect(rang).not.toContain(A)
  })
})
