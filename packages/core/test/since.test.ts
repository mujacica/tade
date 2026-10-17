import { describe, expect, it } from 'vitest'
import type { EventType, TadeEvent } from '../src/events.ts'
import {
  AWAY_MS,
  nobodyHere,
  PRESENCE_LINE_MS,
  PRESENT_MS,
  presenceLineDue,
  presentBefore,
  sinceHere,
} from '../src/since.ts'

// "Since you were here", folded on the machine it is about: a laptop that
// opens after a night away is told what finished, what is waiting to be read,
// what is held, what was put to that machine's orchestrator, and what it cost
// — from the last moment that machine counted the person present.

const NOW = Date.UTC(2026, 9, 17, 9, 0)
const MINUTE = 60_000

let seq = 0
function event(
  type: EventType,
  task: string | null,
  minute: number,
  detail: Record<string, unknown> = {},
): TadeEvent {
  seq++
  return {
    seq,
    ts: new Date(NOW + minute * MINUTE).toISOString(),
    type,
    urgency: 'routine',
    task,
    lane: null,
    run: null,
    detail,
  }
}
const present = (minute: number) => event('person_present', null, minute, { device: 'd1' })

describe('when a presence is worth a line', () => {
  it('is a keypress a moment ago, the first time and then once a stretch', () => {
    expect(presenceLineDue(null, 0, NOW)).toBe(true)
    expect(presenceLineDue(NOW - PRESENCE_LINE_MS + 1, 0, NOW)).toBe(false)
    expect(presenceLineDue(NOW - PRESENCE_LINE_MS, 0, NOW)).toBe(true)
  })

  it('is never a keypress too long ago to count anybody present', () => {
    // A link carries a keypress up to ten minutes old; one past the stretch a
    // keypress counts for is somebody who has gone, and is no cut at all.
    expect(presenceLineDue(null, PRESENT_MS, NOW)).toBe(true)
    expect(presenceLineDue(null, PRESENT_MS + 1, NOW)).toBe(false)
    expect(presenceLineDue(null, -1, NOW)).toBe(false)
  })

  it('is due again at once where the clock went back past the last line', () => {
    expect(presenceLineDue(NOW + MINUTE, 0, NOW)).toBe(true)
  })
})

describe('the moment somebody was last here', () => {
  it('is the newest presence line before they came back, whatever was written after', () => {
    // The laptop opened at 0 and its link carried a key a breath later (line
    // at 0): that line is of the stretch they are in now, and the card is
    // about the one before it.
    const lines = [present(-600), present(-300), present(-120), present(0), present(1)]
    expect(presentBefore(lines, NOW)).toBe(NOW - 120 * MINUTE)
    expect(presentBefore(lines, NOW - 120 * MINUTE)).toBe(NOW - 300 * MINUTE)
  })

  it('is never, on a machine that has never counted anybody present', () => {
    expect(presentBefore([event('task_done', 'vps/a', -5, { by: 'agent' })], NOW)).toBeNull()
    expect(presentBefore([present(3)], NOW)).toBeNull()
  })
})

describe('what happened since', () => {
  const since = NOW - 60 * MINUTE

  it('is what finished since, newest first, and not what finished before or began again', () => {
    const got = sinceHere(
      [
        event('task_done', 'vps/before', -90, { by: 'agent' }),
        event('task_done', 'vps/one', -50, { by: 'agent' }),
        event('task_done', 'vps/two', -20, { by: 'rule' }),
        event('task_done', 'vps/again', -40, { by: 'agent' }),
        event('run_started', 'vps/again', -10),
        event('task_done', 'vps/gone', -30, { by: 'orchestrator' }),
        event('task_removed', 'vps/gone', -5),
      ],
      since,
      NOW,
    )
    expect(got.finished).toEqual([
      { task: 'vps/two', at: NOW - 20 * MINUTE, said: 'its rule was met' },
      { task: 'vps/one', at: NOW - 50 * MINUTE, said: 'its agent said so' },
    ])
  })

  it('is what is still held, and never a hold somebody answered since', () => {
    const got = sinceHere(
      [
        event('queue_held', 'vps/wait', -30, { because: 'vps/base failed' }),
        event('queue_held', 'vps/answered', -40, { because: 'vps/base failed' }),
        event('queue_changed', 'vps/answered', -35, { start: 'now' }),
        event('queue_held', 'vps/old', -100, { because: 'over budget' }),
      ],
      since,
      NOW,
    )
    expect(got.held).toEqual([{ task: 'vps/wait', at: NOW - 30 * MINUTE, said: 'vps/base failed' }])
  })

  it('is a document handed over to read since, said once, and never one decided about', () => {
    const got = sinceHere(
      [
        event('document_ready', 'vps/plan', -30, { produces: 'p/plan.md', asked: 'A or B?' }),
        event('task_done', 'vps/audit', -25, { by: 'agent', produces: 'p/audit.md' }),
        event('document_ready', 'vps/read', -20, { produces: 'p/read.md' }),
        event('document_triaged', 'vps/read', -10, { path: 'p/read.md', decided: 'nothing' }),
      ],
      since,
      NOW,
    )
    expect(got.documents.map((one) => [one.task, one.said])).toEqual([
      ['vps/audit', 'finished, with a document to read'],
      ['vps/plan', 'handed over a document to read'],
    ])
    // The finish is said as the document, not twice.
    expect(got.finished).toEqual([])
  })

  it('is what a watch put to the orchestrator since and nobody has decided', () => {
    const got = sinceHere(
      [
        event('watch_found', 'vps/red', -30, {
          schedule: 'ci',
          key: 'k1',
          title: 'main is red',
          proposed: true,
        }),
        event('watch_found', 'vps/decided', -20, {
          schedule: 'ci',
          key: 'k2',
          title: 'flaky',
          proposed: true,
        }),
        event('proposal_decided', 'vps/decided', -15, { decision: 'leave', by: 'orchestrator' }),
      ],
      since,
      NOW,
    )
    expect(got.proposed).toEqual([{ task: 'vps/red', at: NOW - 30 * MINUTE, said: 'main is red' }])
  })

  it('is what the agents spent since, and nothing spent before', () => {
    const usage = (minute: number, usd: number) =>
      event('usage', 'vps/a', minute, { model: 'claude-opus-5', tokens: 100, usd })
    const got = sinceHere([usage(-90, 5), usage(-30, 0.25), usage(-10, 0.5)], since, NOW)
    expect(got.spend.usd).toBeCloseTo(0.75)
    expect(got.spend.tokens).toBe(200)
    expect(got.spend.hasCost).toBe(true)
  })
})

describe('nobody is here, told to the orchestrator', () => {
  const asked = {
    seen: null as number | null,
    opened: NOW - 2 * 60 * MINUTE,
    keptBy: null as string | null,
    holds: 'orchestrator' as const,
    now: NOW,
  }

  it('says nothing while a sign of the person is recent', () => {
    expect(nobodyHere({ ...asked, seen: NOW - AWAY_MS + MINUTE })).toBeNull()
  })

  it('says how long, and the rule that goes with it, once there has been none for a while', () => {
    const said = nobodyHere({ ...asked, seen: NOW - 134 * MINUTE })
    expect(said).toBe(
      'Nobody has been at a keyboard of theirs for 2h 14m — not this window, and no other machine of theirs says so. Decide only what is yours: what was held is yours to decide (queue.holds: orchestrator). Park the rest, and say in a sentence what you parked and why: they read it when they are back.',
    )
    // Where held work is theirs, waiting on an answer is waiting on nobody.
    expect(nobodyHere({ ...asked, seen: NOW - 134 * MINUTE, holds: 'ask' })).toContain(
      'theirs to decide (queue.holds: ask), so park it',
    )
  })

  it('counts a window a person opened as a sign, and one a service manager opened as none', () => {
    // Somebody typed `tade app` a minute ago: they are here.
    expect(nobodyHere({ ...asked, opened: NOW - MINUTE })).toBeNull()
    // systemd brought it up a minute ago at three in the morning: nobody is.
    const kept = nobodyHere({ ...asked, opened: NOW - MINUTE, keptBy: 'systemd' })
    expect(kept).toContain('since systemd started this window, 1m ago')
    // And a key pressed since is a sign either way.
    expect(nobodyHere({ ...asked, keptBy: 'systemd', seen: NOW - MINUTE })).toBeNull()
  })
})
