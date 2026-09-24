import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import {
  checkBudget,
  modelDetail,
  modelIdentity,
  modelIn,
  modelLastRunOn,
  modelsSaid,
  noSpend,
  pricedOf,
  runFactsFrom,
  spendFrom,
  startOfToday,
  UNRECORDED,
} from '../src/spend.ts'

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

// How it was reached, which is what tells one model's three rows apart.
//
// `claude-opus-5` on a subscription, `anthropic/claude-opus-5` through an API
// key and `openrouter/anthropic/claude-opus-5` through a router are the same
// weights and three different bills. The harness, the sign-in and the provider
// are what say which — and every one of them is read off what somebody wrote
// down, never off the model's name.
describe('what a run was', () => {
  const started = (over: Partial<TadeEvent> & { detail?: Record<string, unknown> }): TadeEvent =>
    ({
      seq: 1,
      ts: '2026-09-13T10:00:00.000Z',
      type: 'run_started',
      urgency: 'notable',
      task: 'checkout/refunds',
      lane: null,
      run: 'r1',
      ...over,
      detail: { ...over.detail },
    }) as TadeEvent

  it('files spend by the harness, the sign-in and the provider the event carries', () => {
    const report = spendFrom(
      [
        usage({
          run: 'r1',
          detail: { harness: 'claude-code', account: 'work', provider: 'anthropic', usd: 1 },
        }),
        usage({ run: 'r2', detail: { harness: 'pi', provider: 'openrouter', usd: 2 } }),
      ],
      { since: 0 },
    )
    expect(report.byHarness['claude-code']?.usd).toBe(1)
    expect(report.byHarness.pi?.usd).toBe(2)
    // A sign-in is the harness alone for its own, `harness@account` for an
    // account's — the same spelling its adapter is filed under.
    expect(Object.keys(report.byAccount).sort()).toEqual(['claude-code@work', 'pi'])
    expect(report.byProvider.anthropic?.usd).toBe(1)
    expect(report.byProvider.openrouter?.usd).toBe(2)
  })

  it('reads it off the run that opened it, for usage that predates carrying its own', () => {
    const runs = runFactsFrom([
      started({ run: 'r1', detail: { adapter: 'claude-code', account: 'work' } }),
    ])
    const report = spendFrom([usage({ run: 'r1', detail: { usd: 3 } })], { since: 0, runs })
    expect(report.byHarness['claude-code']?.usd).toBe(3)
    expect(report.byAccount['claude-code@work']?.usd).toBe(3)
  })

  it('never reads the provider out of the model name', () => {
    // `anthropic/claude-opus-5` reached through OpenRouter is a real route on
    // a real machine. Guessing from the name would file this under Anthropic
    // and look certain about it, so the answer is that nobody said.
    const report = spendFrom(
      [usage({ run: 'r9', detail: { model: 'anthropic/claude-opus-5', usd: 1 } })],
      { since: 0 },
    )
    expect(Object.keys(report.byProvider)).toEqual([UNRECORDED])
    expect(report.byProvider.anthropic).toBeUndefined()
  })

  it('says nothing recorded rather than inventing a harness called unknown', () => {
    const report = spendFrom([usage({ run: null, detail: { usd: 1 } })], { since: 0 })
    expect(report.byHarness[UNRECORDED]?.usd).toBe(1)
    expect(report.byModel['claude-opus-5']?.usd).toBe(1)
    // And a usage event with no model at all goes in the same kind of bucket,
    // never under a model called `unknown`.
    const none = spendFrom([usage({ detail: { model: undefined, usd: 1 } })], { since: 0 })
    expect(none.byModel[UNRECORDED]?.usd).toBe(1)
  })

  it('reports which run was on which model, for runtime to be timed by', () => {
    const said = modelsSaid([
      usage({ run: 'r1', detail: { model: 'claude-opus-5' } }),
      usage({ run: 'r2', detail: { model: 'gpt-5' } }),
    ])
    expect(said.get('r1')).toBe('claude-opus-5')
    expect(said.get('r2')).toBe('gpt-5')
  })
})

// Priced and estimated money are both real dollars, both go in the total, and
// neither goes in silently.
describe('priced or guessed', () => {
  it('keeps what was priced apart from what was estimated', () => {
    const report = spendFrom(
      [
        usage({ detail: { usd: 1.5, priced: 'exact' } }),
        usage({ detail: { usd: 0.5, priced: 'estimate' } }),
      ],
      { since: 0 },
    )
    expect(report.total.usd).toBe(2)
    expect(report.total.usdExact).toBe(1.5)
    expect(report.total.usdEstimated).toBe(0.5)
    expect(pricedOf(report.total)).toBe('mixed')
  })

  it('counts money nobody vouched for as an estimate', () => {
    // A harness that never said is not a harness that priced it: money with
    // no word beside it is money nobody stands behind.
    const report = spendFrom([usage({ detail: { usd: 2 } })], { since: 0 })
    expect(pricedOf(report.total)).toBe('estimate')
    expect(report.total.usdEstimated).toBe(2)
  })

  it('is no kind of money at all when nothing reported any', () => {
    // A subscription reports tokens and no price. Zero dollars from one is not
    // free, and an estimate of nothing is not an estimate.
    const report = spendFrom([usage({ detail: { usd: 0, priced: 'estimate' } })], { since: 0 })
    expect(pricedOf(report.total)).toBe('none')
    expect(report.total.hasCost).toBe(false)
  })
})

// A journal is years long and holds what every Tade that ever wrote it
// believed. What a harness *is* — the provider it reaches, whether its money
// is money — is a fact about the harness and not about any one line, so it is
// the same answer for a line written today and a line written last spring.
describe('what a reader may believe about a harness', () => {
  /**
   * The shape of the journal this was reported from: one Claude Code agent on
   * a subscription and one pi agent through a router, the same model spelled
   * each harness's own way, and a route that had written `openrouter` onto
   * every line of both because the config said so.
   */
  const BOTH: TadeEvent[] = [
    usage({
      run: 'r1',
      task: 'tade/spend',
      detail: {
        model: 'claude-opus-5',
        modelId: 'anthropic/claude-opus-5',
        harness: 'claude-code',
        provider: 'openrouter',
        priced: 'estimate',
        tokens: 900_000,
        usd: 954.51,
      },
    }),
    usage({
      run: 'r2',
      task: 'tade/queue',
      detail: {
        model: 'claude-opus-5',
        modelId: 'openrouter/anthropic/claude-opus-5',
        harness: 'pi',
        provider: 'openrouter',
        priced: 'exact',
        tokens: 140_000,
        usd: 78.23,
      },
    }),
  ]

  it('files the money and the tokens where each belongs', () => {
    const report = spendFrom(BOTH, { since: 0 })
    // The plan's turns are tokens and no money; pi's are money it priced.
    expect(report.total.usd).toBe(78.23)
    expect(report.total.usdExact).toBe(78.23)
    expect(report.total.usdEstimated).toBe(0)
    expect(report.total.tokens).toBe(1_040_000)
    expect(pricedOf(report.total)).toBe('exact')
    expect(report.byHarness['claude-code']?.usd).toBe(0)
    expect(report.byHarness['claude-code']?.tokens).toBe(900_000)
    expect(report.byHarness.pi?.usd).toBe(78.23)
    // Both spellings are one model, and its hours and its money are one row.
    expect(Object.keys(report.byModel)).toEqual(['claude-opus-5'])
  })

  it('does not believe a router beside a harness that cannot reach one', () => {
    const report = spendFrom(BOTH, { since: 0 })
    // Claude Code reaches Anthropic through its own sign-in and no router, so
    // the tokens of that agent are Anthropic's whatever the route wished; pi
    // is the harness that really routes, and its line stands as recorded.
    expect(report.byProvider.anthropic?.tokens).toBe(900_000)
    expect(report.byProvider.anthropic?.usd).toBe(0)
    expect(report.byProvider.openrouter?.usd).toBe(78.23)
    expect(report.byProvider.openrouter?.tokens).toBe(140_000)
  })

  it('leaves a harness it does not know exactly as it was recorded', () => {
    // A journal written by a newer Tade, or by one with a harness this one
    // does not run: nothing is invented, and nothing is taken away.
    const report = spendFrom(
      [usage({ detail: { harness: 'something-else', provider: 'a-router', usd: 4 } })],
      { since: 0 },
    )
    expect(report.byProvider['a-router']?.usd).toBe(4)
  })

  it('leaves an account beside a subscription its own money', () => {
    // A sign-in added beside the harness's own may be billed per token, and
    // the harness's own plan says nothing about it.
    const report = spendFrom(
      [
        usage({
          detail: { harness: 'claude-code', account: 'billed', usd: 3, priced: 'estimate' },
        }),
      ],
      { since: 0 },
    )
    expect(report.byAccount['claude-code@billed']?.usd).toBe(3)
    expect(pricedOf(report.total)).toBe('estimate')
  })
})

// One model has as many spellings as there are ways of reaching it, and the
// journal is full of all of them: the one this was written from had
// `claude-opus-5` 9,846 times, `openrouter/anthropic/claude-opus-5` 5,858,
// `anthropic/claude-opus-5` 256 and `openrouter/moonshotai/kimi-k2.6` 12 —
// two models, spelled four ways, drawn as four rows.
describe('one name for one model', () => {
  it('reads the model out of every spelling of it', () => {
    for (const said of [
      'claude-opus-5',
      'anthropic/claude-opus-5',
      'openrouter/anthropic/claude-opus-5',
    ]) {
      expect(modelIdentity(said).name).toBe('claude-opus-5')
    }
    expect(modelIdentity('openrouter/moonshotai/kimi-k2.6').name).toBe('kimi-k2.6')
  })

  it('keeps the spelling that reaches it again, which is not its name', () => {
    // Handed back to a harness to start an agent on: a bare `claude-opus-5` is
    // offered by several providers and pi refuses to guess between them.
    const found = modelIdentity('anthropic/claude-opus-5', 'openrouter')
    expect(found.id).toBe('anthropic/claude-opus-5')
    expect(found.provider).toBe('openrouter')
  })

  it('never reads the provider out of the name', () => {
    // `anthropic/claude-opus-5` reached through OpenRouter is a real route on
    // a real machine, and a guess would file that spend under Anthropic.
    expect(modelIdentity('anthropic/claude-opus-5').provider).toBe(UNRECORDED)
  })

  it('says nothing recorded rather than inventing a model of that name', () => {
    for (const said of [undefined, null, '', '   ', 42, 'anthropic/']) {
      expect(modelIdentity(said).name).toBe(UNRECORDED)
    }
  })

  it('writes the name, and the spelling only where they differ', () => {
    expect(modelDetail('claude-opus-5')).toEqual({ model: 'claude-opus-5' })
    expect(modelDetail('openrouter/anthropic/claude-opus-5')).toEqual({
      model: 'claude-opus-5',
      modelId: 'openrouter/anthropic/claude-opus-5',
    })
    // Absent, not null: a key holding nothing reads as a model called nothing.
    expect(modelDetail(null)).toEqual({})
  })

  it('reads an event written either way', () => {
    // A journal is years long: the old events hold the whole spelling under
    // `model`, and the new ones hold the name there and the spelling beside it.
    expect(modelIn(usage({ detail: { model: 'openrouter/anthropic/claude-opus-5' } })).name).toBe(
      'claude-opus-5',
    )
    const now = usage({
      detail: { model: 'claude-opus-5', modelId: 'openrouter/anthropic/claude-opus-5' },
    })
    expect(modelIn(now).name).toBe('claude-opus-5')
    expect(modelIn(now).id).toBe('openrouter/anthropic/claude-opus-5')
  })

  it('adds every spelling of one model into one row', () => {
    const report = spendFrom(
      [
        usage({ detail: { model: 'claude-opus-5', tokens: 100, usd: 1 } }),
        usage({ detail: { model: 'anthropic/claude-opus-5', tokens: 100, usd: 1 } }),
        usage({ detail: { model: 'openrouter/anthropic/claude-opus-5', tokens: 100, usd: 1 } }),
        usage({ detail: { model: 'openrouter/moonshotai/kimi-k2.6', tokens: 10, usd: 0.1 } }),
      ],
      { since: 0 },
    )
    expect(Object.keys(report.byModel).sort()).toEqual(['claude-opus-5', 'kimi-k2.6'])
    expect(report.byModel['claude-opus-5']?.tokens).toBe(300)
    expect(report.byModel['claude-opus-5']?.usd).toBeCloseTo(3)
  })

  it('gives back the last model one harness ran a task on, and never another’s', () => {
    const events = [
      usage({ type: 'run_model', detail: { model: 'kimi-k2.6', harness: 'pi' } }),
      usage({
        type: 'run_model',
        detail: {
          model: 'claude-opus-5',
          modelId: 'anthropic/claude-opus-5',
          harness: 'claude-code',
        },
      }),
    ]
    // The spelling that reaches it again, which is what a harness is handed.
    expect(modelLastRunOn(events, 'checkout/refunds', 'claude-code')).toBe(
      'anthropic/claude-opus-5',
    )
    // Moved back to pi, it is pi's last model — a Claude Code alias would be
    // a name pi never heard of, which is an agent that exits before reading
    // a word.
    expect(modelLastRunOn(events, 'checkout/refunds', 'pi')).toBe('kimi-k2.6')
    // Another task's model is not this one's, and nothing said is nothing.
    expect(modelLastRunOn(events, 'checkout/search', 'pi')).toBeUndefined()
    expect(
      modelLastRunOn([usage({ detail: { model: '', harness: 'pi' } })], 'checkout/refunds', 'pi'),
    ).toBeUndefined()
  })

  it('takes a line written before runs said which harness they were in', () => {
    // Nothing else can be done with it, and it is what the journal has.
    const old = [usage({ detail: { model: 'openrouter/anthropic/claude-opus-5' } })]
    expect(modelLastRunOn(old, 'checkout/refunds', 'pi')).toBe('openrouter/anthropic/claude-opus-5')
  })

  it('folds what a run said it was on, however the run said it', () => {
    const said = modelsSaid([
      usage({ run: 'r1', detail: { model: 'openrouter/anthropic/claude-opus-5' } }),
      usage({ run: 'r2', type: 'run_model', detail: { model: 'kimi-k2.6' } }),
      // Nothing said is not a model called nothing: it leaves no entry at all.
      usage({ run: 'r3', detail: { model: '' } }),
    ])
    expect(said.get('r1')).toBe('claude-opus-5')
    expect(said.get('r2')).toBe('kimi-k2.6')
    expect(said.has('r3')).toBe(false)
  })
})
