import { noSpend, type Spend } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  leadOf,
  moneySaid,
  noMoneyWhy,
  onPlanSaid,
  periodOf,
  plansShape,
  pressureSaid,
  spentAny,
  wentOf,
} from '../src/assets/pages/spend-shape.js'
import { spendFold } from '../src/assets/store.js'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, plan, project, reach, task } from './fixtures.ts'

// What the spend page draws, against **real projected rows** rather than shapes
// a test assembled: every figure goes through `snapshotOf`, so a field the
// projection renames is a red test here rather than a dash on a phone. And the
// page's rules of honesty, each in its own words: the three kinds of dollar are
// never added in silence, a plan's worth is in no total of money, a plan's
// windows are never dollars, and nothing nobody could say is drawn as nought.

const spent = (over: Partial<Spend>): Spend => ({ ...noSpend(), ...over })

/** The task rows a device is handed, granted everything unless a test says. */
function rows(tasks: Parameters<typeof task>[0][], granted = EVERY) {
  const made = snapshotOf(
    input({
      reach: reach(granted),
      projects: [project(), project({ name: 'tade', title: '' }), project({ name: 'folio' })],
      tasks: tasks.map((one, at) => task({ id: `sentry/t${at}`, ...one })),
    }),
    NOW,
  )
  return made.tasks
}

const bill = (usd: number) => spent({ usd, usdExact: usd, hasCost: true, tokens: 1_000 })
const onPlan = (usdOnPlan: number, tokens = 2_000_000) =>
  spent({ usdOnPlan, tokens, tokensUnpriced: tokens, tokensOnPlan: tokens })

describe('the lead: what it cost', () => {
  it('draws a bill of one kind with its word, and names nothing it is made of', () => {
    const lead = leadOf(rows([{ spend: bill(8.1) }]), { granted: true, partial: false })
    expect(lead.billed).toEqual({ value: '$8.10', word: 'billed', parts: [] })
  })

  it('marks who worked a figure out, and names each part of a mix rather than averaging it', () => {
    const lead = leadOf(
      rows([
        { spend: bill(8.1) },
        { spend: spent({ usd: 4.2, usdEstimated: 4.2, hasCost: true }) },
        { spend: spent({ usd: 2.52, usdListed: 2.52, hasCost: true }) },
      ]),
      { granted: true, partial: false },
    )
    // A mix carries the guess's mark: some of it is not a bill.
    expect(lead.billed.value).toBe('~$14.82')
    expect(lead.billed.word).toBe('mixed')
    expect(lead.billed.parts).toEqual([
      { key: 'exact', said: '$8.10', word: 'billed' },
      { key: 'estimate', said: '~$4.20', word: 'estimated' },
      { key: 'listed', said: '≈$2.52', word: 'list prices' },
    ])
  })

  it('never draws Tade’s own pricing as a bill', () => {
    const lead = leadOf(rows([{ spend: spent({ usd: 2.52, usdListed: 2.52, hasCost: true }) }]), {
      granted: true,
      partial: false,
    })
    expect(lead.billed.value).toBe('≈$2.52')
    expect(lead.billed.word).toBe('list prices')
  })

  it('keeps what a plan would have cost out of the bill, beside it and marked', () => {
    const lead = leadOf(rows([{ spend: bill(8.1) }, { spend: onPlan(41.3) }]), {
      granted: true,
      partial: false,
    })
    expect(lead.billed.value).toBe('$8.10')
    expect(lead.onPlan).toEqual({ value: '≈$41.30', word: 'at list · not billed' })
  })

  it('draws a plan’s worth as a floor where some of its turns had no rate', () => {
    const partly = spent({ ...onPlan(41.3), tokensOnPlanUnrated: 300_000 })
    expect(leadOf(rows([{ spend: partly }]), { granted: true, partial: false }).onPlan.value).toBe(
      '≥≈$41.30',
    )
  })

  it('says why there is no money, and never says nought', () => {
    // This machine's own day: everything on a plan whose model has no rate.
    const unrated = spent({
      tokens: 5_000_000,
      tokensUnpriced: 5_000_000,
      tokensOnPlan: 5_000_000,
      tokensOnPlanUnrated: 5_000_000,
    })
    const lead = leadOf(rows([{ spend: unrated }]), { granted: true, partial: false })
    expect(lead.billed).toEqual({ value: null, word: 'none reported', parts: [] })
    expect(lead.onPlan).toEqual({ value: null, word: 'no rate for its model' })
    expect(lead.tokens).toEqual({ value: '5.0M', word: 'none priced' })
  })

  it('tells a period with nothing in it from work nobody priced', () => {
    const lead = leadOf(rows([{ spend: spent({}) }]), { granted: true, partial: false })
    expect(spentAny(lead.fold)).toBe(false)
    expect(lead.billed.word).toBe('nothing recorded')
    expect(lead.onPlan.word).toBe('no plan ran')
    expect(lead.tokens).toEqual({ value: null, word: 'nothing recorded' })
  })

  it('draws a device that may not read money as not granted, not as nothing spent', () => {
    const tasks = rows([{ spend: bill(8.1) }], [])
    expect(tasks[0]?.spend).toBeNull()
    const lead = leadOf(tasks, { granted: false, partial: false })
    expect([lead.billed, lead.onPlan, lead.tokens].map((one) => [one.value, one.word])).toEqual([
      [null, 'not granted'],
      [null, 'not granted'],
      [null, 'not granted'],
    ])
    expect(noMoneyWhy(lead.fold, false)).toBe('not granted')
  })

  it('draws a sum over a snapshot that left tasks out as the floor it is', () => {
    const tasks = rows([{ spend: bill(8.1) }])
    const lead = leadOf(tasks, { granted: true, partial: true })
    expect(lead.billed.value).toBe('≥$8.10')
    expect(lead.tokens.value).toBe('≥1k')
  })

  it('counts a spend nobody sent rather than adding it as nought', () => {
    const fold = spendFold([{ spend: null }, { spend: bill(1) }]) as Parameters<typeof moneySaid>[0]
    expect(fold.unknown).toBe(1)
    expect(moneySaid(fold)).toBe('$1.00')
    expect(onPlanSaid(fold)).toBeNull()
  })
})

describe('the period every money figure covers', () => {
  // Built in the reader's own zone, as the page reads it, so the test holds
  // wherever it runs.
  const local = (day: number, hour: number, minute = 0) =>
    new Date(2026, 9, day, hour, minute).getTime()

  it('is today where it began at this reader’s midnight', () => {
    expect(periodOf(new Date(local(13, 0)).toISOString(), local(13, 9))).toBe('today')
  })

  it('is the time where it began later today, and the day where it began before', () => {
    expect(periodOf(new Date(local(13, 2)).toISOString(), local(13, 9))).toBe('since 02:00')
    const earlier = periodOf(new Date(local(12, 17)).toISOString(), local(13, 9))
    expect(earlier).toMatch(/^since .*12.* 17:00$/)
    expect(periodOf(new Date(local(12, 0)).toISOString(), local(13, 9))).not.toContain('00:00')
  })

  it('says nothing where nothing has been folded, rather than naming the epoch', () => {
    expect(periodOf(null, NOW)).toBeNull()
    expect(periodOf('', NOW)).toBeNull()
    expect(periodOf('not a moment', NOW)).toBeNull()
  })
})

describe('where it went', () => {
  const day = () =>
    rows([
      { project: 'sentry', spend: bill(8.1), harness: 'pi', model: 'claude-sonnet-5' },
      { id: 'tade/window', project: 'tade', spend: bill(2), harness: 'codex', model: '' },
      { id: 'folio/landing', project: 'folio', spend: onPlan(41.3), harness: 'claude-code' },
      { id: 'folio/idle', project: 'folio', spend: spent({}), lane: 'stopped' },
    ])

  it('ranks by money where anything was billed, a plan’s row with no bar and its worth at list', () => {
    const went = wentOf(day(), 'project')
    expect(went.measure).toBe('cost')
    expect(went.rows.map((one) => [one.label, one.value, one.said, one.kind])).toEqual([
      ['sentry', 8.1, '$8.10', 'money'],
      ['tade', 2, '$2.00', 'money'],
      ['folio', null, '≈$41.30 at list', 'plan'],
    ])
    expect(went.rows[0]?.href).toBe('/p/sentry')
    // Money is not a state: every bar the quiet grey.
    expect(new Set(went.rows.map((one) => one.tone))).toEqual(new Set(['queued']))
  })

  it('ranks by tokens where nothing was billed, the only figure every harness reports', () => {
    const went = wentOf(
      rows([
        { id: 'tade/a', project: 'tade', spend: onPlan(0, 3_000_000) },
        { id: 'folio/b', project: 'folio', spend: onPlan(0, 9_000_000) },
      ]),
      'project',
    )
    expect(went.measure).toBe('tokens')
    expect(went.rows.map((one) => [one.label, one.value, one.said])).toEqual([
      ['folio', 9_000_000, '9.0M'],
      ['tade', 3_000_000, '3.0M'],
    ])
  })

  it('counts what spent nothing rather than drawing a column of dashes', () => {
    const went = wentOf(day(), 'agent')
    expect(went.rows.map((one) => one.key)).not.toContain('folio/idle')
    expect(went.quiet).toBe(1)
    expect(went.quietSaid).toBe('1 agent spent nothing')
  })

  it('names an agent, links to it, and lights only one still running', () => {
    const went = wentOf(day(), 'agent')
    const landing = went.rows.find((one) => one.key === 'folio/landing')
    expect(landing?.label).toBe('landing')
    expect(landing?.href).toBe('/t/folio/landing')
    expect(landing?.tone).toBe('working')
    expect(landing?.under).toContain('running')
    const window = went.rows.find((one) => one.key === 'tade/window')
    expect(window?.under.startsWith('tade')).toBe(true)
  })

  it('files a run nobody named under not recorded, never under a model called unknown', () => {
    const went = wentOf(day(), 'model')
    const nobody = went.rows.find((one) => one.unrecorded)
    expect(nobody?.label).toBe('not recorded')
    expect(nobody?.href).toBeNull()
    expect(went.rows.map((one) => one.label)).toContain('claude-sonnet-5')
  })

  it('says the money and the plan side by side where a row has both, and adds neither', () => {
    const went = wentOf(
      rows([
        { project: 'sentry', spend: bill(5) },
        { project: 'sentry', spend: onPlan(20) },
      ]),
      'project',
    )
    expect(went.rows[0]?.said).toBe('$5.00')
    expect(went.rows[0]?.under).toContain('≈$20.00 on a plan')
  })
})

describe('the plans', () => {
  const minutes = (n: number) => NOW + n * 60_000

  function cards() {
    const plans = snapshotOf(
      input({
        reach: reach(EVERY),
        plans: [
          plan({
            account: 'me@example.invalid',
            windows: [{ label: '5h', used: 12, resetsAt: minutes(200) }],
          }),
          plan({
            windows: [
              { label: '5h', used: 93, resetsAt: minutes(42) },
              { label: '7d', used: 64, resetsAt: 0 },
            ],
          }),
          plan({ harness: 'pi', account: 'openrouter', pays: 'per-token', windows: [], at: null }),
          plan({
            harness: 'codex',
            account: null,
            windows: [],
            at: null,
            cannotTell:
              'codex says how much of its plan is used only while one of its agents is running',
          }),
        ],
      }),
      NOW,
    ).plans
    return plansShape(plans, NOW)
  }

  it('puts the account about to run out first, then the ones that cannot say, then per token', () => {
    expect(cards().map((one) => [one.name, one.kind, one.tightest])).toEqual([
      ['work@example.invalid', 'windows', 93],
      ['me@example.invalid', 'windows', 12],
      ['codex', 'cannot', null],
      ['openrouter', 'per-token', null],
    ])
  })

  it('draws each window as a share and when it starts over, and says when nobody said', () => {
    const [work] = cards()
    expect(work?.windows.map((one) => [one.label, one.said, one.pressure, one.resets])).toEqual([
      ['5h', '93%', 'tight', 'resets in 42m'],
      ['7d', '64%', 'fine', 'no reset said'],
    ])
    expect(work?.windows[0]?.under).toBe('5h\nresets in 42m')
  })

  it('carries a harness’s own sentence for why it cannot tell, and draws no window', () => {
    const codex = cards().find((one) => one.kind === 'cannot')
    expect(codex?.line).toBe(
      'codex says how much of its plan is used only while one of its agents is running',
    )
    expect(codex?.windows).toEqual([])
    expect(cards().find((one) => one.kind === 'per-token')?.line).toBe('pays per token · no window')
  })

  it('names only the plan about to stop somebody', () => {
    expect(cards().map((one) => pressureSaid(one))).toEqual(['nearly out', '', '', ''])
  })

  it('names an account this device may not read by its harness alone', () => {
    const plans = snapshotOf(input({ reach: reach(['spend']) }), NOW).plans
    const [only] = plansShape(plans, NOW)
    expect(only?.account).toBeNull()
    expect(only?.name).toBe('claude-code')
  })
})
