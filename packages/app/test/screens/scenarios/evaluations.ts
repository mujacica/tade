import {
  caseDetail,
  type EvalFinding,
  evaluationsFrom,
  noSpend,
  type ReplayCase,
  type ReplayEntrantFacts,
  replayRecords,
  replaysIn,
  type Spend,
  type TadeEvent,
} from '@tade/core'
import { EvaluationsAnswerSchema, evaluationsFor, GRANTS } from '@tade/web'
import { type EvalsView, evalsView } from '../../../src/evaluations.ts'
import { cardsOf } from '../../../src/machine-looks.ts'
import type { FindingThere } from '../../../src/machine-there.ts'
import { evaluationsPanel } from '../../../src/panels/evaluations/state.ts'
import { base, frame, NOW, type Scenario } from './fixtures.ts'
import { elsewhere } from './machines.ts'

/** What the VPS's judge flagged about its own agents, and what came of each there. */
const vpsFindings: FindingThere[] = [
  {
    key: 'tade/remote-link:missing_test',
    question: 'missing_test',
    project: 'tade',
    tasks: ['tade/remote-link'],
    at: NOW - 3 * 3_600_000,
    probability: 0.88,
    file: 'packages/remotes/core/src/follow.ts',
    stillThere: true,
    account: null,
    verdict: null,
  },
  {
    key: 'tade/intake-door:swallowed_error',
    question: 'swallowed_error',
    project: 'tade',
    tasks: ['tade/intake-door'],
    at: NOW - 40 * 60_000,
    probability: 0.71,
    file: 'packages/extensions/intake/src/slack.ts',
    stillThere: true,
    account: { did: 'not real', said: 'the catch rethrows after logging' },
    verdict: null,
  },
  {
    key: 'tade/linear:missing_test',
    question: 'missing_test',
    project: 'tade',
    tasks: ['tade/linear'],
    at: NOW - 26 * 3_600_000,
    probability: 0.64,
    file: 'packages/extensions/intake/src/linear.ts',
    stillThere: false,
    account: { did: 'fixed', said: null },
    verdict: 'confirmed',
  },
  {
    key: 'tade/linear:secret_in_diff',
    question: 'secret_in_diff',
    project: 'tade',
    tasks: ['tade/linear'],
    at: NOW - 26 * 3_600_000,
    probability: 0.52,
    file: 'test/fixtures/linear.json',
    stillThere: true,
    account: { did: 'not real', said: 'a fixture token, revoked' },
    verdict: 'false positive',
  },
]

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

/**
 * The VPS's scorecards, as it folds them over its own journal and sends them
 * (`GET /api/evaluations`), read here the one way the window reads them: the
 * same models as this machine's, and never added into this machine's rows.
 */
const vpsJournal: TadeEvent[] = [
  ['tade/remote-link', 'claude-code', 'claude-opus-5', 'merged'],
  ['tade/intake-door', 'claude-code', 'claude-opus-5', 'merged'],
  ['tade/mirror-branches', 'codex', 'gpt-5.1-codex', 'committed'],
  ['tade/notes-shared', 'claude-code', 'claude-opus-5', null],
].flatMap(([task, harness, model, landed], index): TadeEvent[] => [
  line({ type: 'task_created', task, ts: at(60 - index * 5) }),
  line({
    type: 'run_started',
    task,
    run: `${task}/agent`,
    ts: at(60 - index * 5),
    detail: { harness, model },
  }),
  ...(landed === 'committed'
    ? [line({ type: 'commit_seen', task, ts: at(58 - index * 5), detail: { sha: task } })]
    : []),
  line({
    type: 'task_done',
    task,
    ts: at(57 - index * 5),
    detail: { by: 'rule', ...(landed === 'merged' ? { rule: 'merged' } : {}) },
  }),
])

const vpsCards = cardsOf({
  answer: EvaluationsAnswerSchema.parse(
    JSON.parse(
      JSON.stringify(
        evaluationsFor(
          { device: 'mac', projects: { kind: 'every' }, granted: [...GRANTS], answers: true },
          (projects) =>
            evaluationsFrom(vpsJournal, {
              since: 0,
              projects,
              spent: {
                'tade/remote-link': money(3.1, 4_200_000),
                'tade/intake-door': money(1.4, 2_000_000),
                'tade/mirror-branches': money(0.6, 900_000),
              },
              findings: null,
            }),
        ),
      ),
    ),
  ),
  at: NOW - 30_000,
  said: null,
  busy: false,
})

/** One case that landed, as a replay took it: its words, what it ran on, cost and changed. */
const original = (task: string, over: Partial<ReplayCase> = {}): ReplayCase => ({
  task,
  project: 'checkout',
  said: `make ${task.split('/')[1]} retry on a timeout`,
  base: 'a1b2c3d',
  baseThere: true,
  harness: 'claude-code',
  model: 'claude-opus-5',
  done: NOW - 30 * HOUR,
  context: null,
  usd: 2.1,
  workedMs: 34 * 60_000,
  size: { added: 120, removed: 18 },
  tests: ['test/retry.test.ts'],
  head: 'b2c3d4e',
  ...over,
})

/** What the window knows of each entrant, as its last look said. */
const ran = (task: string, over: Partial<ReplayEntrantFacts> = {}): ReplayEntrantFacts => ({
  task,
  removed: false,
  started: true,
  finished: true,
  state: 'review',
  checks: 'pass',
  failed: [],
  strayed: false,
  size: { commits: 2, added: 96, removed: 11 },
  usd: 0.74,
  workedMs: 21 * 60_000,
  ...over,
})

const replayed = replaysIn(
  replayRecords([
    line({
      type: 'replay_started',
      ts: at(6),
      detail: {
        replay: 'sonnet-night',
        project: 'checkout',
        said: 'eval sonnet on the last five checkout tasks, five dollars at most',
        by: 'orchestrator',
        candidate: { model: 'claude-sonnet-5' },
        ceiling_usd: 5,
        cases: [
          caseDetail({
            of: 'checkout/refunds',
            task: 'checkout/sonnet-night-1',
            couldNot: null,
            original: original('checkout/refunds'),
          }),
          caseDetail({
            of: 'checkout/webhooks',
            task: 'checkout/sonnet-night-2',
            couldNot: null,
            original: original('checkout/webhooks', {
              usd: 4.4,
              size: { added: 210, removed: 40 },
            }),
          }),
          caseDetail({
            of: 'checkout/stripe',
            task: null,
            couldNot:
              'its words — “yes, that one” — are too few to stand on their own: they answered a conversation the replay does not have',
            original: original('checkout/stripe', { said: 'yes, that one' }),
          }),
          caseDetail({
            of: 'checkout/ledger',
            task: 'checkout/sonnet-night-3',
            couldNot: null,
            original: original('checkout/ledger', { usd: 0.8 }),
          }),
          caseDetail({
            of: 'checkout/tax',
            task: 'checkout/sonnet-night-4',
            couldNot: null,
            original: original('checkout/tax', { usd: 1.9 }),
          }),
        ],
      },
    }),
    line({
      type: 'replay_graded',
      task: 'checkout/sonnet-night-2',
      ts: at(4),
      detail: { state: 'failed', failed: ['tests'], laid: ['test/webhooks.test.ts'] },
    }),
  ]),
  (task) =>
    task === 'checkout/sonnet-night-3'
      ? ran(task, { size: { commits: 0, added: 0, removed: 0 }, usd: 0.31, workedMs: 6 * 60_000 })
      : task === 'checkout/sonnet-night-4'
        ? ran(task, { finished: false, state: 'working', checks: null, size: null, usd: 0.4 })
        : task === 'checkout/sonnet-night-2'
          ? ran(task, {
              usd: 1.12,
              workedMs: 40 * 60_000,
              size: { commits: 3, added: 160, removed: 22 },
            })
          : ran(task),
)

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
    name: 'evaluations-the-judge-on-another-machine',
    about:
      'The Judge tab with the VPS linked: this machine’s own record, then what the VPS’s judge ' +
      'flagged about its agents — every question with how often it fired and what was decided ' +
      'there, and what still waits on a verdict, oldest first, the probability grey and the ' +
      'judge’s — under its own name, as of when it last said.',
    state: { ...base(), panel: evaluationsPanel('judge') },
    frame: frame({
      evaluations: evals,
      machines: {
        ...elsewhere.down(),
        remotes: elsewhere
          .down()
          .remotes.map((one) =>
            one.name !== 'vps' ? one : { ...one, detail: { ...one.detail, findings: vpsFindings } },
          ),
      },
    }),
  },
  {
    name: 'evaluations-on-two-machines',
    about:
      'By harness with the VPS linked: this Mac’s own scorecards, then the VPS’s as it folded ' +
      'them over its own journal — the same harnesses in the same columns, one under the other, ' +
      'its own `all` row its total, over all its work whatever range this page is on, and as of ' +
      'when it said — and nothing of the one added into the other.',
    state: { ...base(), panel: evaluationsPanel('harness') },
    frame: frame({
      evaluations: evals,
      machines: {
        ...elsewhere.up(),
        remotes: elsewhere
          .up()
          .remotes.filter((one) => one.name === 'vps')
          .map((one) => ({ ...one, detail: { ...one.detail, cards: vpsCards } })),
      },
    }),
  },
  {
    name: 'evaluations-replays',
    about:
      'A replay: the last landed tasks asked again on a candidate model at their own base, each ' +
      'beside its original — passed, failed with why, could not replay said apart from failing, ' +
      'still running — with what it cost and took against what the original did, and the ceiling; ' +
      'and above them, a candidate judge asked Jev’s questions again, counted against the verdicts.',
    state: { ...base(), panel: evaluationsPanel('replays') },
    frame: frame({
      evaluations: evals,
      replays: {
        replays: replayed,
        judges: [
          {
            at: at(2),
            judge: 'jev',
            version: 'jev-1.14.0',
            against: ['jev-1.13.0'],
            score: {
              read: 12,
              couldNot: 1,
              agreed: 171,
              asked: 192,
              raised: { recorded: 14, candidate: 11 },
              confirmed: { of: 6, caught: 5 },
              dismissed: { of: 5, raisedAgain: 1 },
            },
            costUsd: 0.38,
          },
        ],
      },
    }),
  },
  {
    name: 'evaluations-no-replays',
    about: 'With no replay yet the tab says how one is started, rather than an empty table.',
    state: { ...base(), panel: evaluationsPanel('replays') },
    frame: frame({ evaluations: evals, replays: { replays: [], judges: null } }),
  },
  {
    name: 'evaluations-before-the-journal-is-read',
    about: 'Before the journal has been read the page says it is looking, never a page of noughts.',
    state: { ...base(), panel: evaluationsPanel() },
    frame: frame({ evaluations: null }),
  },
]
