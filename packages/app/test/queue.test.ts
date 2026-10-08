import type { Queued, QueueFacts, TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { describeQueue, heldMessage, planAnswer, whyStarting } from '../src/queue.ts'

const facts = (events: TadeEvent[] = [], finished: string[] = []): QueueFacts => ({
  tasks: new Map([['shop/fix-charge', { state: 'working', reason: '' }]]),
  finished: new Map(finished.map((task) => [task, { at: '', by: 'agent', summary: '' }])),
  events,
  now: Date.parse('2026-09-15T13:00:00Z'),
})

const refunds: Queued = {
  task: 'shop/add-refunds',
  project: 'shop',
  parked: false,
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
        projects: ['shop'],
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

  it('keeps every name whole when the change spans repositories, and says what it is called', () => {
    // Two tasks called `oauth-scopes` is the ordinary shape of one change in
    // two repos: stripped of their projects they are one name said twice.
    expect(
      planAnswer({
        projects: ['sentry', 'sentry-cli'],
        effort: 'oauth-scopes',
        made: ['sentry/oauth-scopes', 'sentry-cli/oauth-scopes'],
        started: ['sentry/oauth-scopes'],
        waiting: [{ task: 'sentry-cli/oauth-scopes', state: 'after sentry/oauth-scopes' }],
        warnings: [],
      }),
    ).toBe(
      [
        'Made 2 tasks in sentry and sentry-cli, as oauth-scopes.',
        'Started sentry/oauth-scopes.',
        'Queued sentry-cli/oauth-scopes (after sentry/oauth-scopes).',
      ].join('\n'),
    )
  })
})
