import type { Queued, QueueFacts, WilcoEvent } from '@wilco/core'
import { describe, expect, it } from 'vitest'
import { describeQueue, heldMessage, planAnswer, whyStarting } from '../src/queue.ts'

const facts = (events: WilcoEvent[] = [], finished: string[] = []): QueueFacts => ({
  tasks: new Map([['shop/fix-charge', { state: 'working', reason: '' }]]),
  finished: new Map(finished.map((task) => [task, { at: '', by: 'agent', summary: '' }])),
  events,
  now: Date.parse('2026-09-15T13:00:00Z'),
})

const refunds: Queued = {
  task: 'shop/add-refunds',
  project: 'shop',
  start: {
    after: [{ task: 'shop/fix-charge', why: 'both change src/charge.ts' }],
    prompt: 'add partial refunds',
    touches: [],
  },
}

describe('what the queue says', () => {
  it('says why something started', () => {
    expect(whyStarting(refunds, facts())).toBe('shop/fix-charge has finished')
    const anyway = facts([
      {
        seq: 1,
        ts: '',
        type: 'queue_changed',
        urgency: 'notable',
        task: 'shop/add-refunds',
        lane: null,
        run: null,
        detail: { change: 'start', by: 'you' },
      },
    ])
    expect(whyStarting(refunds, anyway)).toBe('it was started anyway')
    const timed: Queued = {
      ...refunds,
      start: { ...refunds.start, after: [], at: '2026-09-15T12:00:00Z' },
    }
    expect(whyStarting(timed, facts())).toBe('its time came')
  })

  it('lists queued work with where it stands and why it waits', () => {
    expect(describeQueue([], facts(), () => '')).toBe('Nothing is queued.')
    expect(describeQueue([refunds], facts(), () => '')).toBe(
      '- shop/add-refunds — after shop/fix-charge (shop/fix-charge: both change src/charge.ts)',
    )
  })

  it('asks the orchestrator to tell the person, not to decide', () => {
    expect(heldMessage('shop/add-refunds', 'shop/fix-charge failed')).toContain(
      'Tell the person, and ask what they want',
    )
  })

  it('answers a plan with what started, what waits, and what to watch', () => {
    expect(
      planAnswer({
        project: 'shop',
        made: ['shop/fix-charge', 'shop/add-refunds'],
        started: ['shop/fix-charge'],
        waiting: [{ task: 'shop/add-refunds', state: 'after shop/fix-charge' }],
        warnings: ['a and b both change src/x.ts'],
      }),
    ).toBe(
      [
        'Made 2 tasks in shop.',
        'Started fix-charge.',
        'Queued add-refunds (after shop/fix-charge).',
        'Watch out: a and b both change src/x.ts.',
      ].join('\n'),
    )
  })
})
