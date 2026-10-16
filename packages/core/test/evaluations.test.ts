import { describe, expect, it } from 'vitest'
import { calibrationOf, ENOUGH, precisionSaid } from '../src/calibration.ts'
import {
  countSaid,
  type EvalFacts,
  evaluationsFrom,
  outcomesFrom,
  perLanded,
  perLandedCost,
  scorecardsBy,
  WITHOUT,
} from '../src/evaluations.ts'
import type { TadeEvent } from '../src/events.ts'
import { noSpend, type Spend, UNRECORDED } from '../src/spend.ts'

// The scorecards, read back out of the journal. Pure: events and what was asked
// again in, the cards out — and the same events always give the same cards.

let seq = 0
const event = (over: Partial<TadeEvent>): TadeEvent => ({
  seq: ++seq,
  ts: '2026-10-10T09:00:00.000Z',
  type: 'task_created',
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

const made = (task: string, ts = '2026-10-10T09:00:00.000Z') =>
  event({ type: 'task_created', task, ts })
const started = (task: string, harness: string, model: string, run = `${task}/agent`) =>
  event({ type: 'run_started', task, run, detail: { harness, model } })
const turnedOut = (task: string, model: string, run = `${task}/agent`) =>
  event({ type: 'run_model', task, run, detail: { model } })
const done = (task: string, ts: string, rule?: string) =>
  event({ type: 'task_done', task, ts, detail: { by: 'agent', ...(rule ? { rule } : {}) } })
const pushed = (task: string, checks?: string) =>
  event({
    type: 'tool_call',
    task,
    detail: { tool: 'bash', summary: 'git push origin main', ...(checks ? { checks } : {}) },
  })
const held = (task: string) =>
  event({
    type: 'permission_denied',
    task,
    detail: { tool: 'bash', summary: 'git push', rule: 'checks', reason: 'types failed' },
  })
const ran = (task: string | null, state: string, over: Record<string, unknown> = {}) =>
  event({ type: 'check_ran', task, detail: { check: 'tests', state, where: 'here', ...over } })

const dollars = (usd: number, tokens = 1000): Spend => ({
  ...noSpend(),
  tokens,
  usd,
  usdExact: usd,
  hasCost: usd > 0,
})

const facts = (over: Partial<EvalFacts> = {}): EvalFacts => ({
  since: 0,
  spent: {},
  findings: null,
  ...over,
})

describe('outcomesFrom', () => {
  it('counts only work somebody made, so the orchestrator and a chat are not tasks', () => {
    const outcomes = outcomesFrom(
      [
        made('shop/fix'),
        event({ type: 'usage', task: 'tade/orchestrator', detail: { model: 'opus' } }),
        started('chat/1', 'pi', 'kimi'),
      ],
      { since: 0 },
    )
    expect(outcomes.map((one) => one.task)).toEqual(['shop/fix'])
  })

  it('files a task under its first run, and says when a later one was on something else', () => {
    const [one] = outcomesFrom(
      [
        made('shop/fix'),
        started('shop/fix', 'claude-code', 'anthropic/claude-opus-5'),
        started('shop/fix', 'pi', 'kimi-k2', 'shop/fix/agent-2'),
      ],
      { since: 0 },
    )
    expect(one).toMatchObject({ harness: 'claude-code', model: 'claude-opus-5', moved: true })
  })

  it('takes the model the first run turned out to be on over the one it asked for', () => {
    const [one] = outcomesFrom(
      [made('shop/fix'), started('shop/fix', 'pi', ''), turnedOut('shop/fix', 'kimi-k2')],
      { since: 0 },
    )
    expect(one).toMatchObject({ harness: 'pi', model: 'kimi-k2', moved: false })
  })

  it('leaves what nobody wrote down unrecorded, and never invents a harness', () => {
    const [one] = outcomesFrom([made('shop/fix')], { since: 0 })
    expect(one).toMatchObject({ harness: UNRECORDED, model: UNRECORDED })
  })

  it('reads the template and persona each stamped task came from', () => {
    const outcomes = outcomesFrom(
      [
        event({
          type: 'template_used',
          detail: {
            template: 'research-then-plan',
            tasks: ['shop/research', 'shop/plan'],
            personas: { 'shop/research': 'researcher' },
          },
        }),
        made('shop/research'),
        made('shop/plan'),
        made('shop/mine'),
      ],
      { since: 0 },
    )
    expect(outcomes.map(({ task, template, persona }) => ({ task, template, persona }))).toEqual([
      { task: 'shop/research', template: 'research-then-plan', persona: 'researcher' },
      { task: 'shop/plan', template: 'research-then-plan', persona: WITHOUT },
      { task: 'shop/mine', template: WITHOUT, persona: WITHOUT },
    ])
  })

  it('says a persona nobody recorded when the line predates saying which', () => {
    const [one] = outcomesFrom(
      [
        event({ type: 'template_used', detail: { template: 'fix', tasks: ['shop/a'] } }),
        made('shop/a'),
      ],
      { since: 0 },
    )
    expect(one?.persona).toBe(UNRECORDED)
  })

  it('reads the first push: held, told red, or green — and nothing where nobody saw one', () => {
    const outcomes = outcomesFrom(
      [
        made('shop/held'),
        held('shop/held'),
        pushed('shop/held'),
        made('shop/told'),
        pushed('shop/told', 'types failed at this commit'),
        made('shop/green'),
        pushed('shop/green'),
        held('shop/green'),
        made('shop/quiet'),
        event({ type: 'tool_call', task: 'shop/quiet', detail: { summary: 'git status' } }),
      ],
      { since: 0 },
    )
    expect(Object.fromEntries(outcomes.map((one) => [one.task, one.firstPush]))).toEqual({
      'shop/held': 'red',
      'shop/told': 'red',
      'shop/green': 'green',
      'shop/quiet': null,
    })
  })

  it('counts the reds caught on this machine, a shared checkout’s by whose run it was', () => {
    const [one] = outcomesFrom(
      [
        made('shop/fix'),
        ran('shop/fix', 'failed'),
        ran(null, 'timed out', { by: 'shop/fix' }),
        ran('shop/fix', 'passed'),
        ran('shop/fix', 'failed', { where: 'forge' }),
        ran(null, 'failed', { by: 'you' }),
      ],
      { since: 0 },
    )
    expect(one).toMatchObject({ checkedHere: 3, redsHere: 2 })
  })

  it('reads a merge from the done rule, and from what a forge was asked again', () => {
    const outcomes = outcomesFrom(
      [
        made('shop/a'),
        done('shop/a', '2026-10-10T10:00:00.000Z', 'merged'),
        made('shop/b'),
        done('shop/b', '2026-10-10T10:00:00.000Z'),
        made('shop/c'),
      ],
      { since: 0, merged: new Set(['shop/b']) },
    )
    expect(outcomes.map((one) => one.merged)).toEqual([true, true, false])
  })

  it('lands what merged, and what was committed onto a shared checkout under its own trailer', () => {
    const shared = (task: string) =>
      event({ type: 'task_created', task, detail: { workspace: 'checkout' } })
    const own = (task: string) =>
      event({ type: 'task_created', task, detail: { workspace: 'worktree' } })
    const commit = (task: string) =>
      event({ type: 'commit_seen', task, detail: { sha: task, attributed: true } })
    const outcomes = outcomesFrom(
      [
        shared('shop/main'),
        commit('shop/main'),
        shared('shop/nothing'),
        own('shop/branch'),
        commit('shop/branch'),
        own('shop/merged'),
        done('shop/merged', '2026-10-10T10:00:00.000Z', 'merged'),
      ],
      { since: 0 },
    )
    expect(Object.fromEntries(outcomes.map((one) => [one.task, one.landed]))).toEqual({
      'shop/main': true,
      'shop/nothing': false,
      // A branch of its own is not on the project's branch until it merges.
      'shop/branch': false,
      'shop/merged': true,
    })
  })

  it('keeps only work in the projects asked about', () => {
    const outcomes = outcomesFrom([made('shop/a'), made('blog/b')], {
      since: 0,
      projects: new Set(['blog']),
    })
    expect(outcomes.map((one) => one.task)).toEqual(['blog/b'])
  })

  it('keeps only work made inside the window', () => {
    const outcomes = outcomesFrom(
      [made('shop/old', '2026-10-01T00:00:00.000Z'), made('shop/new', '2026-10-12T00:00:00.000Z')],
      { since: Date.parse('2026-10-05T00:00:00.000Z') },
    )
    expect(outcomes.map((one) => one.task)).toEqual(['shop/new'])
  })
})

describe('evaluationsFrom', () => {
  const journal = [
    made('shop/a'),
    started('shop/a', 'claude-code', 'claude-opus-5'),
    pushed('shop/a'),
    done('shop/a', '2026-10-10T10:00:00.000Z', 'merged'),
    made('shop/b'),
    started('shop/b', 'claude-code', 'claude-opus-5'),
    held('shop/b'),
    ran('shop/b', 'failed'),
    done('shop/b', '2026-10-10T12:00:00.000Z'),
    made('shop/c'),
    started('shop/c', 'pi', 'kimi-k2'),
  ]

  it('groups by harness, model, persona and template, the busiest first', () => {
    const evals = evaluationsFrom(journal, facts())
    expect(scorecardsBy(evals, 'harness').map((one) => [one.key, one.tasks])).toEqual([
      ['claude-code', 2],
      ['pi', 1],
    ])
    expect(scorecardsBy(evals, 'model').map((one) => one.key)).toEqual(['claude-opus-5', 'kimi-k2'])
    expect(scorecardsBy(evals, 'template').map((one) => one.key)).toEqual([WITHOUT])
    expect(scorecardsBy(evals, 'persona').map((one) => one.key)).toEqual([WITHOUT])
  })

  it('adds up what landed, what was red here, and how long it took', () => {
    const [claude] = evaluationsFrom(journal, facts()).byHarness
    expect(claude).toMatchObject({
      tasks: 2,
      done: 2,
      merged: 1,
      landed: 1,
      pushed: 2,
      firstPushGreen: 1,
      checkedHere: 1,
      redsHere: 1,
      // One hour and three hours: the middle of two is their mean.
      toDoneMs: 2 * 3_600_000,
    })
  })

  it('divides the landed tasks’ own spend by how many landed, and nothing where none did', () => {
    const evals = evaluationsFrom(
      journal,
      facts({ spent: { 'shop/a': dollars(4, 2000), 'shop/b': dollars(10), 'shop/c': dollars(1) } }),
    )
    const [claude, pi] = evals.byHarness
    expect(claude?.spend.usd).toBe(14)
    expect(claude && perLanded(claude, (spend) => spend.usd)).toBe(4)
    expect(claude && perLanded(claude, (spend) => spend.tokens)).toBe(2000)
    expect(pi && perLanded(pi, (spend) => spend.usd)).toBeNull()
  })

  it('keeps a plan’s list-price figure out of the money it adds up', () => {
    const plan: Spend = { ...noSpend(), tokens: 500, usdOnPlan: 3, tokensOnPlan: 500 }
    const [claude] = evaluationsFrom(journal, facts({ spent: { 'shop/a': plan } })).byHarness
    expect(claude?.landedSpend).toMatchObject({ usd: 0, hasCost: false, usdOnPlan: 3 })
    expect(claude && perLandedCost(claude)).toEqual([{ said: '≈$3.00', kind: 'at list' }])
  })

  it('divides billed money by billed work and a plan’s list price by the plan’s, never one by both', () => {
    const plan: Spend = { ...noSpend(), tokens: 500, usdOnPlan: 6, tokensOnPlan: 500 }
    const evals = evaluationsFrom(
      [...journal, event({ type: 'commit_seen', task: 'shop/c' })],
      facts({
        spent: { 'shop/a': dollars(4), 'shop/c': plan },
        merged: new Set(['shop/c']),
      }),
    )
    // Two landed, one billed $4 and one a plan's ≈$6: $4 each billed, ≈$6 each
    // on the plan — and never $2, which is the bill spread over work it did not pay for.
    expect(evals.total.landed).toBe(2)
    expect(perLandedCost(evals.total)).toEqual([
      { said: '$4.00', kind: 'billed' },
      { said: '≈$6.00', kind: 'at list' },
    ])
  })

  it('says no judge was read, rather than none found, where nothing reads anything', () => {
    const evals = evaluationsFrom(journal, facts({ findings: null }))
    expect(evals.byHarness[0]?.findings).toBeNull()
    expect(evals.calibration).toBeNull()
  })

  it('counts findings per change by what became of them, and only about work in the window', () => {
    const finding = (tasks: string[], was: string | null, question = 'did_what_was_asked') => ({
      tasks,
      question,
      probability: 0.9,
      verdict: was ? { was } : null,
    })
    const evals = evaluationsFrom(
      journal,
      facts({
        findings: [
          finding(['shop/a'], 'confirmed'),
          finding(['shop/a'], null, 'secrets'),
          finding(['shop/b'], 'false positive'),
          finding(['elsewhere/x'], 'confirmed'),
        ],
      }),
    )
    expect(evals.byHarness[0]?.findings).toEqual({
      fired: 3,
      on: 2,
      confirmed: 1,
      wrong: 1,
      open: 1,
    })
    expect(evals.byHarness[1]?.findings).toEqual({
      fired: 0,
      on: 0,
      confirmed: 0,
      wrong: 0,
      open: 0,
    })
    expect(evals.calibration?.total).toMatchObject({ fired: 3, judged: 2, confirmed: 1 })
  })

  it('says whether a forge was asked about merges, or only the journal', () => {
    expect(evaluationsFrom(journal, facts()).mergedFrom).toBe('journal')
    expect(evaluationsFrom(journal, facts({ merged: new Set() })).mergedFrom).toBe(
      'journal and forge',
    )
  })
})

describe('counts before rates', () => {
  it('says nothing out of nothing, the counts under ENOUGH, and the rate only after them', () => {
    expect(countSaid(0, 0)).toBe('—')
    expect(countSaid(2, 2)).toBe('2 of 2')
    expect(countSaid(3, ENOUGH)).toBe(`3 of ${ENOUGH} · 60%`)
  })

  it('calibrates per question and per band with the rule Jev’s own page uses', () => {
    const cal = calibrationOf([
      { question: 'q', probability: 0.85, verdict: { was: 'confirmed' } },
      { question: 'q', probability: 0.95, verdict: null },
    ])
    expect(cal.byQuestion[0]?.tally).toMatchObject({ fired: 2, judged: 1, open: 1 })
    expect(cal.byBand[8]?.tally.fired).toBe(1)
    expect(cal.byBand[9]?.tally.open).toBe(1)
    expect(precisionSaid(cal.total)).toBe('1 of 1, too few to call')
  })
})
