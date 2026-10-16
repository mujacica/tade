import { type EvalFinding, noSpend, type Spend, type TadeEvent } from '@tade/core'
import { type EvalsView, evalsView } from '../../../src/evaluations.ts'
import { evaluationsPanel } from '../../../src/panels/evaluations/state.ts'
import { base, frame, NOW, type Scenario } from './fixtures.ts'

// The Evaluations panel: which harness, model, persona and template lands work,
// and the judge's own calibration beside them. Folded by core's own rule out of
// a fortnight of journal, so the golden is what the fold says rather than
// figures somebody typed into a frame.

const HOUR = 3_600_000
let seq = 0
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString()
const line = (over: Partial<TadeEvent> & Pick<TadeEvent, 'type'>): TadeEvent => ({
  seq: ++seq,
  ts: at(100),
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

interface Work {
  task: string
  harness: string
  model: string
  hours: number | null
  landed?: 'merged' | 'committed'
  push?: 'green' | 'red'
  reds?: number
}

const work: Work[] = [
  {
    task: 'checkout/refunds',
    harness: 'claude-code',
    model: 'claude-opus-5',
    hours: 2,
    landed: 'merged',
    push: 'green',
  },
  {
    task: 'checkout/webhooks',
    harness: 'claude-code',
    model: 'claude-opus-5',
    hours: 5,
    landed: 'merged',
    push: 'red',
    reds: 2,
  },
  {
    task: 'checkout/stripe',
    harness: 'claude-code',
    model: 'claude-opus-5',
    hours: 3,
    landed: 'committed',
    push: 'green',
  },
  {
    task: 'checkout/ledger',
    harness: 'claude-code',
    model: 'claude-opus-5',
    hours: 1,
    landed: 'merged',
    push: 'green',
    reds: 1,
  },
  {
    task: 'checkout/tax',
    harness: 'claude-code',
    model: 'claude-opus-5',
    hours: 4,
    landed: 'merged',
    push: 'green',
  },
  {
    task: 'search/rank',
    harness: 'claude-code',
    model: 'claude-sonnet-5',
    hours: 2,
    landed: 'merged',
    push: 'red',
    reds: 3,
  },
  {
    task: 'search/index',
    harness: 'pi',
    model: 'kimi-k2.6',
    hours: 6,
    landed: 'merged',
    push: 'green',
  },
  { task: 'search/facets', harness: 'pi', model: 'kimi-k2.6', hours: null, push: 'red', reds: 4 },
  {
    task: 'infra/terraform',
    harness: 'codex',
    model: 'gpt-5.1-codex',
    hours: 1,
    landed: 'committed',
  },
  { task: 'infra/alerts', harness: 'codex', model: 'gpt-5.1-codex', hours: null },
  { task: 'infra/queue', harness: '', model: '', hours: null },
]

const journal: TadeEvent[] = [
  line({
    type: 'template_used',
    ts: at(200),
    detail: {
      template: 'research-then-fix',
      tasks: ['checkout/webhooks', 'search/rank', 'search/facets'],
      personas: { 'checkout/webhooks': 'implementer', 'search/rank': 'implementer' },
    },
  }),
  ...work.flatMap((one, index): TadeEvent[] => {
    const task = one.task
    const made = 120 - index * 8
    return [
      line({
        type: 'task_created',
        task,
        ts: at(made),
        detail: { workspace: one.landed === 'committed' ? 'checkout' : 'worktree' },
      }),
      ...(one.harness
        ? [
            line({
              type: 'run_started',
              task,
              run: `${task}/agent`,
              ts: at(made),
              detail: { harness: one.harness, model: one.model },
            }),
          ]
        : []),
      ...(one.push
        ? [
            line({
              type: one.push === 'red' ? 'permission_denied' : 'tool_call',
              task,
              ts: at(made - 0.5),
              detail: { summary: 'git push', rule: one.push === 'red' ? 'checks' : 'auto' },
            }),
          ]
        : []),
      ...Array.from({ length: one.reds ?? 0 }, () =>
        line({
          type: 'check_ran',
          task,
          ts: at(made - 0.2),
          detail: { state: 'failed', where: 'here' },
        }),
      ),
      ...(one.landed === 'committed'
        ? [line({ type: 'commit_seen', task, ts: at(made - 0.7), detail: { sha: task } })]
        : []),
      ...(one.hours !== null
        ? [
            line({
              type: 'task_done',
              task,
              ts: at(made - one.hours),
              detail: { by: 'rule', ...(one.landed === 'merged' ? { rule: 'merged' } : {}) },
            }),
          ]
        : []),
    ]
  }),
]

const money = (usd: number, tokens: number, kind: 'exact' | 'plan' = 'exact'): Spend =>
  kind === 'plan'
    ? { ...noSpend(), tokens, tokensOnPlan: tokens, tokensUnpriced: tokens, usdOnPlan: usd }
    : { ...noSpend(), tokens, usd, usdExact: usd, hasCost: true }

const spent: Record<string, Spend> = {
  'checkout/refunds': money(1.2, 2_100_000, 'plan'),
  'checkout/webhooks': money(4.4, 6_800_000, 'plan'),
  'checkout/stripe': money(2.6, 3_900_000, 'plan'),
  'checkout/ledger': money(0.8, 1_300_000, 'plan'),
  'checkout/tax': money(1.9, 2_700_000, 'plan'),
  'search/rank': money(1.1, 1_600_000, 'plan'),
  'search/index': money(0.62, 1_900_000),
  'search/facets': money(0.9, 2_400_000),
  'infra/terraform': money(0.34, 800_000),
  'infra/alerts': money(0.21, 500_000),
}

const finding = (
  tasks: string[],
  question: string,
  probability: number,
  was: 'confirmed' | 'false positive' | null,
): EvalFinding => ({ tasks, question, probability, verdict: was ? { was } : null })

const findings: EvalFinding[] = [
  finding(['checkout/refunds'], 'test_missing', 0.91, 'confirmed'),
  finding(['checkout/webhooks'], 'test_missing', 0.88, 'confirmed'),
  finding(['checkout/stripe'], 'test_missing', 0.83, 'false positive'),
  finding(['search/rank'], 'test_missing', 0.79, 'confirmed'),
  finding(['search/facets'], 'test_missing', 0.94, 'confirmed'),
  finding(['search/index'], 'test_missing', 0.71, null),
  finding(['checkout/webhooks'], 'did_what_was_asked', 0.86, 'false positive'),
  finding(['checkout/tax'], 'did_what_was_asked', 0.82, 'false positive'),
  finding(['infra/terraform'], 'did_what_was_asked', 0.77, 'false positive'),
  finding(['search/facets'], 'did_what_was_asked', 0.74, 'false positive'),
  finding(['infra/alerts'], 'did_what_was_asked', 0.9, 'false positive'),
  finding(['checkout/ledger'], 'secret_committed', 0.97, 'confirmed'),
]

export const evals: EvalsView = evalsView(journal, {
  window: 'all',
  now: NOW,
  openedAt: NOW - HOUR,
  spent,
  findings,
  merged: new Set(),
})

export const EVALUATION_SCREENS: Scenario[] = [
  {
    name: 'evaluations-by-harness',
    about:
      'Which harness lands work: agents, done and landed, first push green, reds caught here, what ' +
      'the judge raised and how it came out, the cost and tokens per landed agent and the time to ' +
      'done — counts before rates, and a rate only from five.',
    state: { ...base(), panel: evaluationsPanel('harness') },
    frame: frame({ evaluations: evals }),
  },
  {
    name: 'evaluations-by-persona',
    about:
      'The same scorecards by persona: what was stamped out of a template is filed under the ' +
      'persona its step was told from, and work asked for in somebody’s own words under none.',
    state: { ...base(), panel: evaluationsPanel('persona') },
    frame: frame({ evaluations: evals }),
  },
  {
    name: 'evaluations-the-judge',
    about:
      'The judge’s own record beside the scorecards: precision per question and per band of ' +
      'probability, out of verdicts alone, with the counts said and a rate only from five.',
    state: { ...base(), panel: evaluationsPanel('judge') },
    frame: frame({ evaluations: evals }),
  },
  {
    name: 'evaluations-before-the-journal-is-read',
    about: 'Before the journal has been read the page says it is looking, never a page of noughts.',
    state: { ...base(), panel: evaluationsPanel() },
    frame: frame({ evaluations: null }),
  },
]
