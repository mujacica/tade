import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { fleetOfFeeds, queuedElsewhereSays } from '../src/queued-elsewhere.ts'

// Every other machine's queued work as the orchestrator is told it in
// tade_queue and its briefing: a section per machine, labelled with when it
// was last heard, at most so many named and the rest counted.

let seq = 0
const line = (
  type: string,
  task: string,
  at: string,
  detail: Record<string, unknown> = {},
): TadeEvent =>
  ({ seq: ++seq, ts: at, type, urgency: 'routine', task, lane: null, detail }) as TadeEvent

const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

describe('other machines’ queued work, said', () => {
  it('names each machine’s, labelled and capped, and counts the rest', () => {
    const hub = Array.from({ length: 8 }, (_, n) =>
      line('task_created', `api/q${n}`, `2026-11-23T10:0${n}:00.000Z`, { after: [] }),
    )
    const said = queuedElsewhereSays(
      fleetOfFeeds('mac', [
        {
          name: 'box',
          called: 'vps',
          events: [...hub, line('task_done', 'api/q7', '2026-11-23T10:09:00.000Z')],
        },
        {
          name: 'laptop',
          events: [line('task_created', 'web/x', '2026-11-23T09:00:00.000Z', { after: [] })],
        },
        { name: 'idle', events: [line('task_created', 'web/y', '2026-11-23T09:00:00.000Z')] },
      ]),
      Date.parse('2026-11-23T11:00:00.000Z'),
      clock,
      3,
    )
    expect(said).toEqual([
      'Queued on vps (last heard 10:09, by its own clock; only vps starts it):',
      '- vps:api/q0',
      '- vps:api/q1',
      '- vps:api/q2',
      '- 4 more on vps not listed',
      'Queued on laptop (last heard 09:00, by its own clock; only laptop starts it):',
      '- laptop:web/x',
    ])
  })

  it('says nothing where nothing waits anywhere else, and a machine never heard is said so', () => {
    expect(queuedElsewhereSays(undefined, 0, clock)).toEqual([])
    expect(
      queuedElsewhereSays(fleetOfFeeds('mac', [{ name: 'vps', events: [] }]), 0, clock),
    ).toEqual([])
    const odd = fleetOfFeeds('mac', [
      { name: 'vps', events: [line('task_created', 'a/b', 'not a time', { after: [] })] },
    ])
    expect(queuedElsewhereSays(odd, 0, clock)[0]).toBe(
      'Queued on vps (not heard from here yet; only vps starts it):',
    )
  })
})
