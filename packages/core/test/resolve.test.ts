import { describe, expect, it } from 'vitest'
import type { EventType, WilcoEvent } from '../src/events.ts'
import { ago, historyFrom } from '../src/history.ts'
import type { TaskState } from '../src/model.ts'
import {
  type KnownTask,
  type ResolveContext,
  resolveAnswer,
  resolveTarget,
} from '../src/resolve.ts'

const NOW = Date.parse('2026-09-11T14:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

function event(type: EventType, task: string, over: Partial<WilcoEvent> = {}): WilcoEvent {
  return {
    seq: 1,
    ts: minutesAgo(1),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: 'r1',
    detail: {},
    ...over,
  }
}

const task = (id: string, state: TaskState): KnownTask => ({
  id,
  project: id.split('/')[0] ?? id,
  state,
})

function context(over: Partial<ResolveContext> = {}): ResolveContext {
  const tasks = over.tasks ?? [
    task('checkout/refunds', 'working'),
    task('checkout/stripe-v15', 'blocked'),
    task('search/pagination', 'review'),
  ]
  // Spelled out rather than spread, so `tasks` is set exactly once.
  return {
    tasks,
    history: over.history ?? historyFrom([], NOW),
    focused: over.focused ?? null,
    lastAddressed: over.lastAddressed ?? null,
    now: over.now ?? NOW,
  }
}

describe('historyFrom', () => {
  it('rolls the journal up into what moved, and when', () => {
    const history = historyFrom(
      [
        event('task_created', 'checkout/refunds', { ts: minutesAgo(90) }),
        event('run_started', 'checkout/refunds', { ts: minutesAgo(80) }),
        event('state_change', 'checkout/refunds', {
          ts: minutesAgo(70),
          detail: { state: 'working' },
        }),
        event('turn_done', 'search/pagination', { ts: minutesAgo(5) }),
      ],
      NOW,
    )

    // Most recently active first: that is what "it" usually means.
    expect(history.tasks.map((t) => t.task)).toEqual(['search/pagination', 'checkout/refunds'])
    const refunds = history.tasks.find((t) => t.task === 'checkout/refunds')
    expect(refunds).toMatchObject({ project: 'checkout', state: 'working', events: 3 })
    expect(refunds?.lastInteractionAt).toBe(Date.parse(minutesAgo(80)))
    expect(history.projects.map((p) => p.project)).toEqual(['search', 'checkout'])
  })

  it('knows what is still waiting on you, and what has been answered', () => {
    const waiting = historyFrom(
      [event('permission_request', 'checkout/refunds', { detail: { requestId: 'q1' } })],
      NOW,
    )
    expect(waiting.tasks[0]?.waiting).toBe(true)
    expect(waiting.projects[0]).toMatchObject({ project: 'checkout', waiting: 1 })

    const answered = historyFrom(
      [
        event('permission_request', 'checkout/refunds', { detail: { requestId: 'q1' } }),
        event('permission_granted', 'checkout/refunds', { detail: { requestId: 'q1' } }),
      ],
      NOW,
    )
    expect(answered.tasks[0]?.waiting).toBe(false)
    // Answering one is you doing something, so it counts as an interaction.
    expect(answered.tasks[0]?.lastInteractionAt).not.toBeNull()
  })

  it('does not count a task someone else asked for as something you did', () => {
    const history = historyFrom(
      [
        event('task_created', 'checkout/fix-shop-1f2', { detail: { by: 'extension:sentry' } }),
        event('task_created', 'checkout/refunds', { detail: { by: 'you' } }),
        // From before anyone said who asked: that was you.
        event('task_created', 'checkout/older', {}),
      ],
      NOW,
    )
    const touched = (id: string) => history.tasks.find((t) => t.task === id)?.lastInteractionAt
    expect(touched('checkout/fix-shop-1f2')).toBeNull()
    expect(touched('checkout/refunds')).not.toBeNull()
    expect(touched('checkout/older')).not.toBeNull()
  })

  it('says how long ago in words', () => {
    expect(ago(30_000)).toBe('just now')
    expect(ago(5 * 60_000)).toBe('5m ago')
    expect(ago(3 * 3_600_000)).toBe('3h ago')
    expect(ago(50 * 3_600_000)).toBe('2d ago')
  })
})

describe('resolveTarget', () => {
  it('takes you at your word when you name one', () => {
    expect(resolveTarget('refunds', context())).toMatchObject({
      kind: 'resolved',
      task: 'checkout/refunds',
      why: 'you said refunds',
    })
  })

  it('accepts the full id, and a name said with spaces', () => {
    expect(resolveTarget('checkout/stripe-v15', context())).toMatchObject({
      task: 'checkout/stripe-v15',
    })
    expect(resolveTarget('stripe v15', context())).toMatchObject({ task: 'checkout/stripe-v15' })
  })

  it('resolves a project that owns exactly one task', () => {
    expect(resolveTarget('search', context())).toMatchObject({
      task: 'search/pagination',
      why: 'the only task in search',
    })
  })

  it('asks which one when a project owns several', () => {
    expect(resolveTarget('checkout', context())).toMatchObject({
      kind: 'ask',
      candidates: ['checkout/refunds', 'checkout/stripe-v15'],
    })
  })

  it('narrows a project by what the verb needs', () => {
    expect(resolveTarget('checkout', context(), { prefer: 'waiting' })).toMatchObject({
      kind: 'resolved',
      task: 'checkout/stripe-v15',
    })
  })

  it('says so plainly when the name means nothing here', () => {
    expect(resolveTarget('nonsense', context())).toMatchObject({
      kind: 'none',
      why: 'nothing here is called nonsense',
    })
  })

  describe('when you do not name one', () => {
    it('uses what you are looking at', () => {
      expect(resolveTarget('it', context({ focused: 'search/pagination' }))).toMatchObject({
        task: 'search/pagination',
        why: 'it is what you are looking at',
      })
    })

    it('falls back to what you last spoke to', () => {
      expect(resolveTarget(null, context({ lastAddressed: 'checkout/refunds' }))).toMatchObject({
        task: 'checkout/refunds',
        why: 'it is what you last spoke to',
      })
    })

    it('prefers what you are looking at over what you last said', () => {
      expect(
        resolveTarget(
          'that',
          context({ focused: 'search/pagination', lastAddressed: 'checkout/refunds' }),
        ),
      ).toMatchObject({ task: 'search/pagination' })
    })

    it('uses the only thing that has moved recently', () => {
      const history = historyFrom(
        [
          event('turn_done', 'checkout/refunds', { ts: minutesAgo(2) }),
          event('turn_done', 'search/pagination', { ts: minutesAgo(600) }),
        ],
        NOW,
      )
      expect(resolveTarget('it', context({ history }))).toMatchObject({
        task: 'checkout/refunds',
        why: 'it is the only one that has moved recently',
      })
    })

    it('answers an approval with the one that is waiting', () => {
      expect(resolveTarget(null, context(), { prefer: 'waiting' })).toMatchObject({
        kind: 'resolved',
        task: 'checkout/stripe-v15',
      })
    })

    it('asks rather than guessing between equals', () => {
      const target = resolveTarget('it', context())
      expect(target.kind).toBe('ask')
      if (target.kind !== 'ask') throw new Error('unreachable')
      expect(target.candidates.length).toBe(3)
      expect(target.question).toBe('Which one?')
    })

    it('asks a sharper question when the verb narrows it', () => {
      const tasks = [task('a/one', 'blocked'), task('b/two', 'blocked')]
      const target = resolveTarget(null, context({ tasks }), { prefer: 'waiting' })
      expect(target).toMatchObject({ kind: 'ask', candidates: ['a/one', 'b/two'] })
      if (target.kind !== 'ask') throw new Error('unreachable')
      expect(target.question).toMatch(/More than one is waiting/)
    })

    it('has nothing to say when there are no tasks', () => {
      expect(resolveTarget('it', context({ tasks: [] }))).toMatchObject({ kind: 'none' })
    })
  })
})

describe('resolveAnswer', () => {
  const candidates = ['checkout/refunds', 'checkout/stripe-v15', 'search/pagination']

  it('takes an ordinal', () => {
    expect(resolveAnswer('the first one', candidates)).toBe('checkout/refunds')
    expect(resolveAnswer('second', candidates)).toBe('checkout/stripe-v15')
  })

  it('takes a number', () => {
    expect(resolveAnswer('3', candidates)).toBe('search/pagination')
  })

  it('takes a name', () => {
    expect(resolveAnswer('pagination', candidates)).toBe('search/pagination')
    expect(resolveAnswer('checkout/refunds', candidates)).toBe('checkout/refunds')
  })

  it('refuses what it cannot place, rather than picking one', () => {
    expect(resolveAnswer('checkout', candidates)).toBeNull() // matches two
    expect(resolveAnswer('nonsense', candidates)).toBeNull()
    expect(resolveAnswer('9', candidates)).toBeNull()
  })
})
