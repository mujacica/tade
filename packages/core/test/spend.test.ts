import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { checkBudget, noSpend, spendFrom, startOfToday } from '../src/spend.ts'

// Money is the one thing here that is not derived from git, so the rule is
// that nothing is estimated: a budget built on a guess is worse than none,
// because you would trust it.

const NOW = Date.parse('2026-09-13T12:00:00Z')

const usage = (over: Partial<TadeEvent> & { detail?: Record<string, unknown> } = {}): TadeEvent =>
  ({
    seq: 1,
    ts: '2026-09-13T11:00:00.000Z',
    type: 'usage',
    urgency: 'routine',
    task: 'checkout/refunds',
    lane: null,
    run: 'r1',
    ...over,
    detail: {
      model: 'claude-opus-5',
      input: 100,
      output: 50,
      tokens: 150,
      usd: 0.25,
      ...over.detail,
    },
  }) as TadeEvent

describe('spendFrom', () => {
  it('has spent nothing when nothing has run', () => {
    expect(spendFrom([], { since: 0 }).total).toEqual(noSpend())
  })

  it('adds up tokens and money, by project and by model', () => {
    const report = spendFrom(
      [
        usage(),
        usage({ task: 'checkout/stripe-v15' }),
        usage({
          task: 'search/pagination',
          detail: { model: 'deepseek-v3', usd: 0.01, tokens: 20 },
        }),
      ],
      { since: 0 },
    )
    expect(report.total.usd).toBeCloseTo(0.51)
    expect(report.byProject.checkout?.usd).toBeCloseTo(0.5)
    expect(report.byProject.search?.usd).toBeCloseTo(0.01)
    expect(report.byModel['claude-opus-5']?.tokens).toBe(300)
  })

  it('ignores anything before the window', () => {
    const old = usage({ ts: '2026-09-12T11:00:00.000Z' })
    expect(spendFrom([old], { since: startOfToday(NOW) }).total.tokens).toBe(0)
  })

  it('ignores events that are not about spending', () => {
    const other = { ...usage(), type: 'tool_call' } as TadeEvent
    expect(spendFrom([other], { since: 0 }).total.tokens).toBe(0)
  })

  it('tells free apart from unpriced', () => {
    // A subscription reports tokens and no money. That is not zero spend, it
    // is unknown spend, and a dollar budget cannot police it.
    const subscription = spendFrom([usage({ detail: { usd: 0, tokens: 900 } })], { since: 0 })
    expect(subscription.total.hasCost).toBe(false)
    expect(subscription.total.tokens).toBe(900)
    expect(spendFrom([usage()], { since: 0 }).total.hasCost).toBe(true)
  })
})

describe('checkBudget', () => {
  const spend = (over: Partial<ReturnType<typeof noSpend>> = {}) => ({ ...noSpend(), ...over })

  it('says nothing when no budget was set', () => {
    expect(checkBudget(spend({ usd: 999 }), undefined)).toEqual({ verdict: 'ok', reason: '' })
    expect(checkBudget(spend({ usd: 999 }), {})).toEqual({ verdict: 'ok', reason: '' })
  })

  it('warns before it stops you', () => {
    // A long run dying at 100% with no warning is how people lose work.
    expect(checkBudget(spend({ usd: 7.9 }), { usd_per_day: 10 }).verdict).toBe('ok')
    expect(checkBudget(spend({ usd: 8 }), { usd_per_day: 10 }).verdict).toBe('warn')
    expect(checkBudget(spend({ usd: 10 }), { usd_per_day: 10 }).verdict).toBe('over')
  })

  it('says what the number actually is', () => {
    const state = checkBudget(spend({ usd: 8.5 }), { usd_per_day: 10 })
    expect(state.reason).toBe('$8.50 of $10.00 today')
  })

  it('polices tokens for providers that report no money', () => {
    const state = checkBudget(spend({ tokens: 1_000_000 }), { tokens_per_day: 1_000_000 })
    expect(state.verdict).toBe('over')
    expect(state.reason).toContain('tokens today')
  })

  it('takes the strictest of the two', () => {
    const state = checkBudget(spend({ usd: 1, tokens: 999 }), {
      usd_per_day: 100,
      tokens_per_day: 1000,
    })
    // Nowhere near the money, but at the token ceiling.
    expect(state.verdict).toBe('warn')
  })

  it('ignores a limit of zero rather than refusing everything', () => {
    expect(checkBudget(spend({ usd: 1 }), { usd_per_day: 0 }).verdict).toBe('ok')
  })
})

describe('startOfToday', () => {
  it('is local midnight, which is what today means to a person', () => {
    const start = startOfToday(NOW)
    const date = new Date(start)
    expect(date.getHours()).toBe(0)
    expect(date.getMinutes()).toBe(0)
    expect(start).toBeLessThanOrEqual(NOW)
  })
})
