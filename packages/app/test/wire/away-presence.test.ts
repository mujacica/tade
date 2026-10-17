import type { EventFilter, TadeEvent } from '@tade/core'
import type { Device } from '@tade/web'
import { describe, expect, it } from 'vitest'
import type { Wiring } from '../../src/wire/context.ts'
import { Presences } from '../../src/wire/web-presence.ts'

// The person at another of their screens, as the machine they are linked to
// counts them (`web-presence.ts`): held for push, written down once a stretch as
// `person_present`, and the catch-up folded from those lines — what the window
// on a VPS does with an owner's presence, without a window around it.

const NOW = Date.UTC(2026, 9, 17, 9, 0)
const MINUTE = 60_000

const OWNER = {
  id: 'a1b2c3d4e5f60718',
  owner: true,
  projects: null,
  granted: ['spend'],
} as unknown as Device

/** Just enough of a window: a clock, a journal it appends to and reads by type, and a last look. */
function windowAt(lines: TadeEvent[] = [], fails = false) {
  let now = NOW
  const wire = {
    now: () => now,
    live: { tasks: [{ task: 'tade/deploy', state: 'blocked', approval: { tool: 'Bash' } }] },
    opts: {
      client: {
        log: {
          append: async (line: Pick<TadeEvent, 'type' | 'detail'>) => {
            if (fails) throw new Error('the disk is full')
            lines.push({
              seq: lines.length + 1,
              ts: new Date(now).toISOString(),
              urgency: 'routine',
              task: null,
              lane: null,
              run: null,
              ...line,
            } as TadeEvent)
          },
          read: async (filter: EventFilter) =>
            lines.filter((one) => filter.types?.includes(one.type) ?? true),
        },
      },
    },
  } as unknown as Wiring
  return { wire, lines, at: (moment: number) => (now = moment) }
}

const line = (
  type: TadeEvent['type'],
  task: string | null,
  at: number,
  detail = {},
): TadeEvent => ({
  seq: 0,
  ts: new Date(at).toISOString(),
  type,
  urgency: 'routine',
  task,
  lane: null,
  run: null,
  detail,
})

describe('the person at another of their screens', () => {
  it('is held at once and written down once a stretch, and never for a keypress too old', async () => {
    const window = windowAt()
    const said: string[] = []
    const presences = new Presences(window.wire, (one) => said.push(one))
    presences.seen('d1', NOW - 5_000)
    window.at(NOW + MINUTE)
    presences.seen('d1', NOW + MINUTE)
    window.at(NOW + 5 * MINUTE)
    presences.seen('d1', NOW + 5 * MINUTE - 3 * MINUTE)
    window.at(NOW + 6 * MINUTE)
    presences.seen('d1', NOW + 6 * MINUTE)
    await Promise.resolve()
    expect(window.lines.map((one) => [one.type, one.ts, one.detail])).toEqual([
      ['person_present', new Date(NOW).toISOString(), { device: 'd1' }],
      ['person_present', new Date(NOW + 6 * MINUTE).toISOString(), { device: 'd1' }],
    ])
    expect(presences.presentAt()).toBe(NOW + 6 * MINUTE)
    expect(said).toEqual([])
  })

  it('says a line that would not go in, rather than starting the next card from the stretch before', async () => {
    const window = windowAt([], true)
    const said: string[] = []
    new Presences(window.wire, (one) => said.push(one)).seen('d1', NOW)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(said).toEqual([
      'the away view could not write person_present down: Error: the disk is full',
    ])
  })

  it('folds the card from the last line before they came back, with what waits on them now', async () => {
    const window = windowAt([
      line('person_present', null, NOW - 180 * MINUTE, { device: 'd1' }),
      line('task_done', 'tade/fix-login', NOW - 120 * MINUTE, { by: 'agent' }),
      line('usage', 'tade/fix-login', NOW - 100 * MINUTE, { model: 'm', tokens: 900, usd: 0.4 }),
      // Written the moment the link came back, a breath before the card was asked for.
      line('person_present', null, NOW - 1_000, { device: 'd1' }),
    ])
    const card = await new Presences(window.wire, () => {}).since()(OWNER, NOW - 2_000)
    expect(card.since).toBe(new Date(NOW - 180 * MINUTE).toISOString())
    expect(card.finished.rows.map((one) => one.task)).toEqual(['tade/fix-login'])
    expect(card.waiting.rows).toEqual([
      { task: 'tade/deploy', at: new Date(NOW).toISOString(), said: 'wants an answer about Bash' },
    ])
    expect(card.spend).toEqual({ usd: 0.4, tokens: 900, hasCost: true })
  })

  it('has nothing to catch up on where nobody was ever counted present', async () => {
    const window = windowAt([line('task_done', 'tade/fix-login', NOW - MINUTE, { by: 'agent' })])
    const card = await new Presences(window.wire, () => {}).since()(OWNER, NOW)
    expect(card.since).toBeNull()
    expect(card.finished.rows).toEqual([])
  })
})
