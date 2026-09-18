import { describe, expect, it } from 'vitest'
import {
  type AttentionContext,
  type Channel,
  DEFAULT_ATTENTION,
  decideAttention,
  parseQuietHours,
  type Surface,
  summarise,
} from '../src/attention.ts'
import type { EventType, TadeEvent, Urgency } from '../src/events.ts'

const NOW = Date.parse('2026-09-11T14:00:00Z')

function event(type: EventType, over: Partial<TadeEvent> = {}): TadeEvent {
  const urgency: Urgency =
    type === 'permission_request' || type === 'failed'
      ? 'blocking'
      : type === 'output'
        ? 'trace'
        : 'notable'
  return {
    seq: 1,
    ts: '2026-09-11T14:00:00.000Z',
    type,
    urgency,
    task: 'app/refunds',
    lane: null,
    run: 'r1',
    detail: {},
    ...over,
  }
}

function context(over: Partial<AttentionContext> = {}): AttentionContext {
  return { now: NOW, surface: 'voice', spokenInLastHour: 0, localHour: 14, ...over }
}

interface Case {
  name: string
  event: TadeEvent
  context?: Partial<AttentionContext>
  want: Channel
  reason?: RegExp
}

const cases: Case[] = [
  // --- what earns speech
  { name: 'an agent waiting on you', event: event('permission_request'), want: 'speak' },
  { name: 'a run that failed', event: event('failed'), want: 'speak' },
  {
    name: 'a task reaching review',
    event: event('state_change', { detail: { state: 'review' } }),
    want: 'speak',
    reason: /review/,
  },
  {
    name: 'a task reaching blocked',
    event: event('state_change', { detail: { state: 'blocked' } }),
    want: 'speak',
  },

  // --- what does not
  {
    name: 'a task starting work',
    event: event('state_change', { detail: { state: 'working' } }),
    want: 'earcon',
  },
  { name: 'a turn finishing', event: event('turn_done'), want: 'earcon' },
  { name: 'a lane opening', event: event('lane_opened'), want: 'earcon' },
  { name: 'raw output', event: event('output'), want: 'silent' },
  {
    name: 'a routine tool call',
    event: event('tool_call', { urgency: 'routine' }),
    want: 'silent',
  },

  // --- surfaces
  {
    name: 'a screen you are looking at never talks',
    event: event('permission_request'),
    context: { surface: 'tui' },
    want: 'silent',
    reason: /tui never/,
  },
  {
    name: 'a watch face still speaks the blocking one',
    event: event('permission_request'),
    context: { surface: 'watch' },
    want: 'speak',
  },

  // --- downgrades
  {
    name: 'quiet hours keep it to a tone',
    event: event('permission_request'),
    context: { localHour: 23 },
    want: 'earcon',
    reason: /quiet hours/,
  },
  {
    name: 'quiet hours wrap past midnight',
    event: event('permission_request'),
    context: { localHour: 3 },
    want: 'earcon',
    reason: /quiet hours/,
  },
  {
    name: 'the edge of quiet hours is awake again',
    event: event('permission_request'),
    context: { localHour: 8 },
    want: 'speak',
  },
  {
    name: 'typing in that task drops it to a tone',
    event: event('permission_request'),
    context: { focusedTask: 'app/refunds', lastKeyboardInputAt: NOW - 5_000 },
    want: 'earcon',
    reason: /at the keyboard/,
  },
  {
    name: 'typing in a different task does not',
    event: event('permission_request'),
    context: { focusedTask: 'app/other', lastKeyboardInputAt: NOW - 5_000 },
    want: 'speak',
  },
  {
    name: 'typing a while ago does not',
    event: event('permission_request'),
    context: { focusedTask: 'app/refunds', lastKeyboardInputAt: NOW - 120_000 },
    want: 'speak',
  },
  {
    name: 'past the hourly budget it waits for the summary',
    event: event('permission_request'),
    context: { spokenInLastHour: 6 },
    want: 'earcon',
    reason: /budget/,
  },
  {
    name: 'under the budget it speaks',
    event: event('permission_request'),
    context: { spokenInLastHour: 5 },
    want: 'speak',
  },
  {
    name: 'the budget never promotes a quiet event',
    event: event('output'),
    context: { spokenInLastHour: 0 },
    want: 'silent',
  },
]

describe('decideAttention', () => {
  it.each(cases)('$name → $want', (c) => {
    const decision = decideAttention(c.event, context(c.context))
    expect(decision.channel).toBe(c.want)
    if (c.reason) expect(decision.reason).toMatch(c.reason)
    expect(decision.reason.length).toBeGreaterThan(0)
  })

  it('never raises an event above what its urgency earned', () => {
    for (const surface of ['voice', 'watch', 'tui'] as Surface[]) {
      const quiet = decideAttention(event('output'), context({ surface }))
      expect(quiet.channel).toBe('silent')
    }
  })

  it('is pure: same inputs, same answer, inputs untouched', () => {
    const e = event('permission_request')
    const ctx = context({ spokenInLastHour: 2 })
    const frozen = structuredClone({ e, ctx })
    expect(decideAttention(e, ctx)).toEqual(decideAttention(e, ctx))
    expect({ e, ctx }).toEqual(frozen)
  })

  it('honours settings passed in over the defaults', () => {
    const strict = { ...DEFAULT_ATTENTION.voice, budget: 0 }
    expect(decideAttention(event('failed'), context(), strict).channel).toBe('earcon')
  })
})

describe('summarise', () => {
  it('says nothing about nothing', () => {
    expect(summarise([])).toBe('')
  })

  it('collapses one task into one clause', () => {
    const text = summarise([
      event('permission_request', { detail: { summary: 'bash: npm i stripe@15' } }),
    ])
    expect(text).toBe('One thing happened. refunds is waiting on bash: npm i stripe@15.')
  })

  it('collapses several tasks into one sentence, not a queue of announcements', () => {
    const text = summarise([
      event('failed', { task: 'app/migration' }),
      event('state_change', { task: 'app/search', detail: { state: 'review' } }),
      event('permission_request', { task: 'app/refunds', detail: { summary: 'rm -rf build' } }),
    ])
    expect(text).toMatch(/^3 things happened\./)
    expect(text).toContain('migration failed')
    expect(text).toContain('search is review')
    expect(text).toContain('refunds is waiting on rm -rf build')
    // One sentence, joined properly, rather than three.
    expect(text.split('.').filter((s) => s.trim()).length).toBe(2)
    expect(text).toContain(' and ')
  })
})

describe('quiet hours, as a person writes them', () => {
  it('reads a range', () => {
    expect(parseQuietHours('22:00-08:00')).toEqual({ from: 22, to: 8 })
    expect(parseQuietHours('22-8')).toEqual({ from: 22, to: 8 })
  })

  it('is no quiet hours when there are none', () => {
    expect(parseQuietHours(undefined)).toBeNull()
    expect(parseQuietHours('')).toBeNull()
  })

  it('ignores what it cannot read rather than refusing to start', () => {
    // A preference, not a boundary: nobody should be locked out of their own
    // window by a typo in one.
    for (const bad of ['evening', '25:00-08:00', '22:00', 'from 10 to 2']) {
      expect(parseQuietHours(bad)).toBeNull()
    }
  })

  it('treats the same hour twice as meaning nothing', () => {
    // It would otherwise mean either always or never, and neither is what
    // anybody writing it twice intended.
    expect(parseQuietHours('22:00-22:00')).toBeNull()
  })
})

describe('money', () => {
  const budgetWarning = (): TadeEvent => ({
    seq: 1,
    ts: new Date(NOW).toISOString(),
    type: 'warning',
    urgency: 'notable',
    task: 'checkout/refunds',
    lane: null,
    run: null,
    detail: { message: 'checkout is near its budget: 82% of $20.00 today' },
  })

  it('is said out loud, not left to an earcon', () => {
    // An earcon says "something happened". By the time you go and look, the
    // budget is spent — which is the one outcome the warning exists to avoid.
    // The hour is supplied, never read off the clock: 14:00 UTC is the middle
    // of the night in some timezones, and a test that passes where it was
    // written is not a test.
    const decided = decideAttention(budgetWarning(), {
      now: NOW,
      surface: 'voice',
      spokenInLastHour: 0,
      localHour: 14,
    })
    expect(decided.channel).toBe('speak')
    expect(decided.reason).toContain('spend')
  })

  it('still yields to quiet hours, like everything else', () => {
    // Loud enough to interrupt is not the same as loud enough to wake you.
    const decided = decideAttention(budgetWarning(), {
      now: NOW,
      surface: 'voice',
      spokenInLastHour: 0,
      localHour: 3,
    })
    expect(decided.channel).toBe('earcon')
  })

  it('leaves every other warning where it was', () => {
    const other = { ...budgetWarning(), detail: { message: 'config.yaml is invalid' } }
    const context = { now: NOW, surface: 'voice' as const, spokenInLastHour: 0, localHour: 14 }
    expect(decideAttention(other, context).channel).toBe('earcon')
  })
})
