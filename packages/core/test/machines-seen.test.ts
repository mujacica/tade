import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import {
  inboundBeat,
  inboundSaid,
  LOST_AFTER_MS,
  type MachineSeen,
  machinesSeenFrom,
  SEEN_EVERY_MS,
  SLEPT_MOST_MS,
  seenDetail,
  seenSaid,
} from '../src/machines-seen.ts'

// Which of the person's machines are up, as this one saw them: transitions
// written by whoever saw them, folded back to the last of each, and the two
// rules a machine that links here is held to — a beat that changes nothing
// writes nothing, and a silence past its slack is `lost`.

const T = Date.parse('2026-11-22T14:00:00.000Z')
const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

const line = (seen: MachineSeen, seq = 1): TadeEvent => ({
  seq,
  ts: new Date(seen.at).toISOString(),
  type: 'machine_seen',
  urgency: 'routine',
  task: null,
  lane: null,
  run: null,
  detail: seenDetail(seen),
})

describe('the record of machines', () => {
  it('folds to the last state of each machine, each way, and skips what is not a line', () => {
    const events: TadeEvent[] = [
      line({ machine: 'mac', way: 'from', state: 'up', at: T, since: null }, 1),
      line({ machine: 'vps', way: 'to', state: 'up', at: T + 1, since: null }, 2),
      line({ machine: 'mac', way: 'from', state: 'closed', at: T + 2, since: null }, 3),
      {
        ...line({ machine: 'x', way: 'to', state: 'up', at: T, since: null }, 4),
        detail: { machine: 'x', way: 'to', state: 'gone' },
      },
      {
        ...line({ machine: 'y', way: 'to', state: 'up', at: T, since: null }, 5),
        detail: { machine: 'y', way: 'sideways', state: 'up' },
      },
    ]
    const seen = machinesSeenFrom(events)
    expect(seen.map((one) => [one.machine, one.way, one.state])).toEqual([
      ['mac', 'from', 'closed'],
      ['vps', 'to', 'up'],
    ])
  })

  it('forgets what a machine that links here was called once it says a name of its own', () => {
    const renamed = line({ machine: 'laptop', way: 'from', state: 'up', at: T + 2, since: null }, 3)
    const events: TadeEvent[] = [
      line({ machine: 'LAPTOP-A1B2C3', way: 'from', state: 'up', at: T, since: null }, 1),
      line({ machine: 'LAPTOP-A1B2C3', way: 'to', state: 'up', at: T + 1, since: null }, 2),
      { ...renamed, detail: { ...renamed.detail, was: 'LAPTOP-A1B2C3' } },
    ]
    // Only the one that links here: a machine this one links to by that name is another.
    expect(machinesSeenFrom(events).map((one) => [one.machine, one.way])).toEqual([
      ['LAPTOP-A1B2C3', 'to'],
      ['laptop', 'from'],
    ])
  })

  it('keeps a since that is not when it was seen, and reads it back', () => {
    const went = T - 3_600_000
    const [one] = machinesSeenFrom([
      line({ machine: 'mac', way: 'from', state: 'asleep', at: T, since: went }),
    ])
    expect(one?.since).toBe(went)
  })

  it('says each state in words somebody can act on, from when it began', () => {
    expect(seenSaid({ state: 'closed', at: T, since: null }, clock)).toBe(
      'closed 14:00, said goodbye',
    )
    expect(seenSaid({ state: 'lost', at: T + 60_000, since: T }, clock)).toBe(
      'lost 14:00 — no goodbye: asleep, or off the network',
    )
    expect(seenSaid({ state: 'asleep', at: T, since: T - 3_600_000 }, clock)).toBe(
      'asleep since 13:00',
    )
    expect(seenSaid({ state: 'up', at: T, since: null }, clock)).toBe('up since 14:00')
  })
})

describe('a machine that links here', () => {
  it('is up on its first word, and its next beats write nothing', () => {
    const first = inboundSaid('mac', null, { state: 'up', slept: null }, T)
    expect(first.lines.map((one) => one.state)).toEqual(['up'])
    const again = inboundSaid('mac', first.now, { state: 'up', slept: null }, T + SEEN_EVERY_MS)
    expect(again.lines).toEqual([])
    expect(again.now?.heardAt).toBe(T + SEEN_EVERY_MS)
  })

  it('is closed on its goodbye, and a silence after a goodbye is not lost', () => {
    const up = inboundSaid('mac', null, { state: 'up', slept: null }, T)
    const bye = inboundSaid('mac', up.now, { state: 'closed' }, T + 1_000)
    expect(bye.lines.map((one) => one.state)).toEqual(['closed'])
    expect(inboundBeat('mac', bye.now, T + 10 * LOST_AFTER_MS).lines).toEqual([])
  })

  it('is lost once it says nothing past its slack, counted from when it was last heard, and once', () => {
    const up = inboundSaid('mac', null, { state: 'up', slept: null }, T)
    expect(inboundBeat('mac', up.now, T + LOST_AFTER_MS).lines).toEqual([])
    const lost = inboundBeat('mac', up.now, T + LOST_AFTER_MS + 1)
    expect(lost.lines).toEqual([
      { machine: 'mac', way: 'from', state: 'lost', at: T + LOST_AFTER_MS + 1, since: T },
    ])
    expect(inboundBeat('mac', lost.now, T + 5 * LOST_AFTER_MS).lines).toEqual([])
  })

  it('says on waking when it went to sleep: asleep from then, and up now, even after it was lost', () => {
    const up = inboundSaid('mac', null, { state: 'up', slept: null }, T)
    const lost = inboundBeat('mac', up.now, T + LOST_AFTER_MS + 1)
    const back = T + 3_600_000
    const woke = inboundSaid('mac', lost.now, { state: 'up', slept: back - (T + 5_000) }, back)
    expect(woke.lines.map((one) => [one.state, one.since])).toEqual([
      ['asleep', T + 5_000],
      ['up', null],
    ])
    expect(woke.now?.state).toBe('up')
  })

  it('cannot say it slept for longer than a week, whatever its clock says', () => {
    const woke = inboundSaid('mac', null, { state: 'up', slept: 400 * 86_400_000 }, T)
    expect(woke.lines[0]?.since).toBe(T - SLEPT_MOST_MS)
  })
})
