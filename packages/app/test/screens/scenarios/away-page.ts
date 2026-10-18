import { markOf, noSpend, type PlanSource, planStandings, type Spend } from '@tade/core'
import {
  type AgentIn,
  type CheckRunIn,
  type CheckTreeIn,
  type Device,
  GRANTS,
  type IntakeIn,
  type NoteIn,
  type ProjectIn,
  type QueueIn,
  type Reach,
  type RunIn,
  type RunStepIn,
  type SnapshotInput,
  type SourceIn,
  type TaskIn,
  type WorkflowIn,
} from '@tade/web'
import type { World } from '../../../../web/scripts/still.ts'
import { ableOn } from '../../../src/away.ts'
import { NOW } from './fixtures.ts'

// The world the README's pictures of the away view are drawn against.
//
// **The same morning as the window's own pictures** (`fixtures.ts`): the same
// moment, the same three projects, the Stripe upgrade stopped at
// `npm i stripe@15`, the refunds agent at work and pagination out for review —
// so the page a phone opens and the window it reaches show one machine, not two.
// What the page needs that the window's scenarios never drew — a plan's steps,
// the checks' history, a request from outside, the conversation — is drawn here
// in the same story.
//
// Fixed data and nothing else: no clock, no git, no file. Each row is what the
// window would hand over, so the controls on it are `ableOn`'s and its mark is
// `markOf`'s rather than written by hand — a picture that offered a press the
// window would not is a picture of a page nobody has.

const ago = (minutes: number) => NOW - minutes * 60_000

/** Midnight before `NOW`, which is the period every figure on the page covers. */
const MIDNIGHT = Date.parse(new Date(NOW).toISOString().slice(0, 10))

/** Money a harness priced, per token. */
function priced(tokens: number, usd: number): Spend {
  return {
    ...noSpend(),
    input: Math.round(tokens * 0.1),
    output: Math.round(tokens * 0.15),
    cacheRead: Math.round(tokens * 0.75),
    tokens,
    usd,
    usdExact: usd,
    hasCost: true,
  }
}

/** A plan's turns: every token counted, no money, and what list price would have said beside it. */
function onPlan(tokens: number, atList: number): Spend {
  return {
    ...noSpend(),
    input: Math.round(tokens * 0.1),
    output: Math.round(tokens * 0.15),
    cacheRead: Math.round(tokens * 0.75),
    tokens,
    usdOnPlan: atList,
    tokensOnPlan: tokens,
    tokensUnpriced: tokens,
  }
}

/** Tokens nobody priced, which Tade prices off the published rate and marks as its own claim. */
function listed(tokens: number, usd: number): Spend {
  return { ...priced(tokens, usd), usdExact: 0, usdListed: usd }
}

type Agent = Omit<TaskIn, 'mark' | 'can' | 'cannot'>

/** One task, with the window's own mark and the window's own controls. */
function task(over: Partial<Agent> & Pick<Agent, 'id' | 'state' | 'title'>): TaskIn {
  const made: Agent = {
    project: over.id.split('/')[0] ?? '',
    reason: { kind: 'clause', said: '' },
    stalled: false,
    parked: false,
    createdAt: ago(120),
    movedAt: ago(10),
    intent: '',
    branch: `tade/${over.id.split('/')[1] ?? ''}`,
    ahead: null,
    behind: null,
    dirty: null,
    workspace: 'worktree',
    shared: false,
    effort: '',
    done: 'said',
    produces: null,
    harness: 'pi',
    model: '',
    account: '',
    origin: { kind: 'you', name: 'you' },
    agents: 1,
    lanes: 1,
    question: false,
    approval: null,
    finished: false,
    queue: '',
    lane: 'running',
    starts: 1,
    spend: noSpend(),
    checks: { state: 'unknown', failed: [], missing: ['tests'], overridden: false },
    review: null,
    ...over,
  }
  const reason = made.reason.kind === 'clause' ? made.reason.said : ''
  const mark = markOf({
    state: made.state,
    reason,
    approval: made.approval,
    finished: made.finished ? {} : null,
    queued: made.queue === '' ? null : { state: { kind: 'waiting' } },
  })
  const { can, cannot } = ableOn({
    parked: made.parked,
    origin: made.origin.kind,
    approval: made.approval !== null,
    agents: made.agents,
    finished: made.finished,
    queue: made.queue,
    steering:
      made.harness === 'codex'
        ? { how: 'next-turn', why: '' }
        : made.agents === 0
          ? { how: null, why: 'no agent is running on it' }
          : { how: 'now', why: '' },
    lane: made.lane,
  })
  return { ...made, mark, can, cannot }
}

const PASS = { state: 'pass' as const, failed: [], missing: [], overridden: false }
const PR = (n: number, repo: string) => ({
  state: 'open' as const,
  url: `https://github.com/example/${repo}/pull/${n}`,
})

const TASKS: TaskIn[] = [
  task({
    id: 'checkout/stripe-v15',
    state: 'blocked',
    title: 'Upgrade Stripe to v15',
    intent: 'Upgrade stripe to v15. The webhook signature API changed, so fix constructEvent too.',
    reason: { kind: 'approval', tool: 'Bash', also: 0 },
    approval: { id: 'req_31', tool: 'Bash', sinceAt: ago(3), command: 'Bash: npm i stripe@15' },
    createdAt: ago(52),
    movedAt: ago(3),
    ahead: 3,
    dirty: 2,
    harness: 'claude-code',
    model: 'claude-opus-5',
    lanes: 2,
    spend: onPlan(880_000, 3.12),
    checks: { state: 'fail', failed: ['tests'], missing: [], overridden: false },
  }),
  task({
    id: 'checkout/refunds',
    state: 'working',
    title: 'Partial refunds from the order page',
    intent: 'Let support refund part of an order from the order page, with a reason.',
    reason: { kind: 'clause', said: 'editing src/refunds.ts' },
    createdAt: ago(95),
    movedAt: ago(1),
    ahead: 1,
    dirty: 4,
    model: 'anthropic/claude-opus-5',
    spend: priced(460_000, 0.62),
  }),
  task({
    id: 'checkout/ledger-schema',
    state: 'review',
    title: 'Ledger tables for refunds',
    reason: { kind: 'clause', said: 'the ledger tables, with a migration and its test' },
    finished: true,
    effort: 'refund-ledger',
    origin: { kind: 'orchestrator', name: 'orchestrator' },
    createdAt: ago(170),
    movedAt: ago(64),
    ahead: 2,
    dirty: 0,
    model: 'anthropic/claude-sonnet-5',
    spend: priced(210_000, 0.41),
    checks: PASS,
    review: PR(418, 'checkout'),
  }),
  task({
    id: 'checkout/ledger-api',
    state: 'working',
    title: 'Ledger endpoints',
    reason: { kind: 'clause', said: 'writing the endpoints in src/ledger/' },
    effort: 'refund-ledger',
    origin: { kind: 'orchestrator', name: 'orchestrator' },
    createdAt: ago(170),
    movedAt: ago(2),
    ahead: 1,
    dirty: 6,
    model: 'openrouter/anthropic/claude-opus-5',
    spend: priced(412_000, 0.58),
  }),
  task({
    id: 'checkout/refund-flow',
    state: 'queued',
    title: 'Refund flow on the ledger',
    reason: { kind: 'clause', said: 'waiting on ledger-api' },
    effort: 'refund-ledger',
    origin: { kind: 'orchestrator', name: 'orchestrator' },
    createdAt: ago(170),
    movedAt: null,
    agents: 0,
    lanes: 0,
    lane: 'none',
    starts: 0,
    queue: 'waiting on ledger-api',
  }),
  task({
    id: 'checkout/refund-emails',
    state: 'queued',
    title: 'Email the customer when a refund lands',
    reason: { kind: 'clause', said: 'waiting on refund-flow' },
    effort: 'refund-ledger',
    origin: { kind: 'orchestrator', name: 'orchestrator' },
    createdAt: ago(170),
    movedAt: null,
    agents: 0,
    lanes: 0,
    lane: 'none',
    starts: 0,
    queue: 'waiting on refund-flow',
  }),
  task({
    id: 'search/pagination',
    state: 'review',
    title: 'Cursor pagination for /search',
    reason: { kind: 'clause', said: 'cursor pagination for /search, with tests' },
    finished: true,
    effort: 'search-speedup',
    createdAt: ago(240),
    movedAt: ago(38),
    ahead: 4,
    dirty: 0,
    model: 'anthropic/claude-sonnet-5',
    spend: priced(148_000, 0.2),
    checks: PASS,
    review: PR(207, 'search'),
  }),
  task({
    id: 'search/reindex',
    state: 'working',
    title: 'Reindex without downtime',
    reason: { kind: 'clause', said: 'rebuilding the index in batches of 5k' },
    effort: 'search-speedup',
    createdAt: ago(200),
    movedAt: ago(4),
    ahead: 2,
    dirty: 3,
    harness: 'codex',
    model: 'gpt-5.3-codex',
    account: 'work',
    spend: listed(620_000, 0.48),
  }),
  task({
    id: 'infra/backup-restore',
    state: 'failed',
    title: 'Restore test for the nightly backup',
    reason: { kind: 'clause', said: 'the restore test timed out twice' },
    createdAt: ago(300),
    movedAt: ago(26),
    ahead: 1,
    dirty: 1,
    lane: 'stopped',
    model: 'anthropic/claude-sonnet-5',
    spend: priced(96_000, 0.14),
    checks: { state: 'fail', failed: ['restore'], missing: [], overridden: false },
  }),
]

const PROJECTS: ProjectIn[] = ['checkout', 'search', 'infra'].map((name) => ({
  name,
  title: name[0]?.toUpperCase() + name.slice(1),
  open: true,
  changes: 1,
  can: [{ verb: 'close', how: 'now' }],
  cannot: [{ verb: 'open', why: 'it is open' }],
  watching: [],
}))

const QUEUE: QueueIn[] = [
  {
    task: 'checkout/refund-flow',
    project: 'checkout',
    state: { kind: 'waiting', on: ['checkout/ledger-api'] },
    order: null,
    waitsOn: [{ task: 'checkout/ledger-api', why: 'it calls what the endpoints return' }],
  },
  {
    task: 'checkout/refund-emails',
    project: 'checkout',
    state: { kind: 'waiting', on: ['checkout/refund-flow'] },
    order: null,
    waitsOn: [{ task: 'checkout/refund-flow', why: 'it emails what refund() returns' }],
  },
]

/** One step of a plan, out of the task it is. */
function step(id: string, layer: number, waits: RunStepIn['waits'] = []): RunStepIn {
  const made = TASKS.find((one) => one.id === id)
  if (made === undefined) throw new Error(`no task ${id} in the away page's world`)
  return {
    task: id,
    project: made.project,
    name: id.split('/')[1] ?? id,
    state: made.state,
    layer,
    waits,
    finished: made.finished,
    parked: made.parked,
    runs: made.starts,
    active: made.state === 'working',
    checks: made.checks.state,
    review: made.review?.state ?? null,
    usd: made.spend.usd,
  }
}

const RUNS: RunIn[] = [
  {
    run: 'refund-ledger',
    projects: ['checkout'],
    steps: [
      step('checkout/ledger-schema', 0),
      step('checkout/ledger-api', 1, [
        { task: 'checkout/ledger-schema', why: 'the endpoints follow the tables' },
      ]),
      step('checkout/refund-flow', 2, [
        { task: 'checkout/ledger-api', why: 'it calls what the endpoints return' },
      ]),
      step('checkout/refund-emails', 3, [
        { task: 'checkout/refund-flow', why: 'it emails what refund() returns' },
      ]),
    ],
    from: null,
    stamp: { name: 'build-a-feature', version: 2 },
    retries: 0,
  },
  {
    run: 'search-speedup',
    projects: ['search'],
    steps: [
      step('search/pagination', 0),
      step('search/reindex', 1, [
        { task: 'search/pagination', why: 'the reindex pages with the new cursor' },
      ]),
    ],
    from: null,
    stamp: null,
    retries: 0,
  },
]

/**
 * Which harnesses' plans say how much is used: the window's spend picture's
 * three, and as there, new agents run as each harness's own sign-in.
 */
const PLANS: PlanSource[] = [
  {
    harness: 'claude-code',
    account: null,
    can: 'while-working',
    pays: 'plan',
    why: 'reports it as one of its agents replies, so there is nothing to show until one has',
    said: {
      at: NOW - 6 * 60_000,
      windows: [
        { label: '5h', used: 78, resetsAt: NOW + 4_920_000 },
        { label: '7d', used: 31, resetsAt: NOW + 3 * 86_400_000 },
      ],
    },
    uses: { newAgents: true, projects: [] },
  },
  {
    harness: 'codex',
    account: null,
    can: 'while-working',
    pays: 'plan',
    why: 'says it as each turn ends, so nothing shows until an agent has worked',
    said: {
      at: NOW - 41 * 60_000,
      windows: [{ label: '5h', used: 12, resetsAt: NOW + 7_200_000 }],
    },
    uses: { newAgents: true, projects: [] },
  },
  {
    harness: 'pi',
    account: null,
    can: 'none',
    pays: 'per-token',
    why: 'is never told what a plan has left; it prices each turn instead',
    said: null,
    uses: { newAgents: true, projects: [] },
  },
]

/** A tree's record: `at` is minutes before the moment. */
function ran(check: string, state: string, minutes: number, ms: number, by: string): CheckRunIn {
  return { check, state, required: true, at: ago(minutes), ms, by }
}

const CHECKS: CheckTreeIn[] = [
  {
    project: 'checkout',
    task: 'checkout/stripe-v15',
    runs: [
      ran('format', 'passed', 44, 2_100, 'checkout/stripe-v15'),
      ran('tests', 'passed', 43, 81_000, 'checkout/stripe-v15'),
      ran('format', 'passed', 21, 2_000, 'checkout/stripe-v15'),
      ran('tests', 'failed', 20, 77_000, 'checkout/stripe-v15'),
      ran('format', 'passed', 9, 2_200, 'checkout/stripe-v15'),
      ran('tests', 'failed', 8, 79_000, 'checkout/stripe-v15'),
    ],
  },
  {
    project: 'checkout',
    task: 'checkout/ledger-schema',
    runs: [
      ran('format', 'passed', 70, 1_900, 'checkout/ledger-schema'),
      ran('tests', 'passed', 69, 74_000, 'checkout/ledger-schema'),
    ],
  },
  {
    project: 'search',
    task: 'search/pagination',
    runs: [
      ran('lint', 'passed', 61, 6_000, 'search/pagination'),
      ran('tests', 'failed', 60, 40_000, 'search/pagination'),
      ran('lint', 'passed', 41, 6_100, 'search/pagination'),
      ran('tests', 'passed', 40, 38_000, 'search/pagination'),
    ],
  },
  {
    project: 'infra',
    task: 'infra/backup-restore',
    runs: [
      ran('restore', 'timed out', 58, 600_000, 'infra/backup-restore'),
      ran('restore', 'timed out', 30, 600_000, 'infra/backup-restore'),
    ],
  },
]

const NOTES: NoteIn[] = [
  {
    text: 'Push branches only. Never push to main, even when every check is green.',
    summary: 'Branches only, never main',
    scope: null,
    by: 'you',
    at: new Date(NOW - 2 * 86_400_000).toISOString(),
  },
  {
    text: 'Use the Stripe test-mode keys from the team vault; the live ones never go near an agent.',
    summary: 'Test-mode Stripe keys only',
    scope: 'checkout',
    by: 'you',
    at: new Date(ago(400)).toISOString(),
  },
  {
    text: 'Keep the v14 webhook handler until Friday, so old events still verify.',
    summary: 'Keep the v14 handler until Friday',
    scope: 'checkout/stripe-v15',
    by: 'voice',
    at: new Date(ago(48)).toISOString(),
  },
]

const INTAKE: IntakeIn[] = [
  {
    item: 'github:1402',
    source: 'github',
    externalId: '1402',
    project: 'search',
    state: 'proposed',
    because: 'search/github-1402 is parked, waiting for a person to approve it',
    grant: 'surfaces.intake.sources.github',
    stamp: { name: 'reproduce-and-fix', version: 3 },
    revision: new Date(ago(35)).toISOString(),
    taken: new Date(ago(34)).toISOString(),
    hash: 'sha256:4f1c9a0b7e2d',
    ref: 'example/search#1402',
    watch: 'intake.github',
    schedule: 'github-issues',
    mode: 'propose',
    attempts: 0,
    tries: 3,
    said: ['Tade has this'],
    unsent: [],
    tasks: ['search/github-1402'],
    work: [
      {
        task: 'search/github-1402',
        parked: true,
        started: false,
        finished: false,
        held: null,
        state: 'parked',
      },
    ],
    run: 'github-1402',
    at: ago(34),
    approve: 'search/github-1402',
    locally: [{ act: 'refuse', why: 'saying no is answered at the machine' }],
    title: 'Search returns nothing for quoted phrases',
    who: 'octocat',
    url: 'https://github.com/example/search/issues/1402',
    material:
      'Searching for "red shoes" with the quotes returns no results; without them it works.',
    materialProblem: '',
    would: {
      starts: [
        {
          task: 'search/github-1402',
          project: 'search',
          workspace: 'worktree',
          done: 'said',
          produces: null,
          touches: ['src/query/'],
          after: [],
          parked: true,
        },
      ],
      grant: ['surfaces.intake.sources.github still allows it'],
      limits: ['search: has spent $0.68 of $20.00 today'],
      problems: [],
      warnings: [],
    },
  },
]

const SOURCES: SourceIn[] = [
  {
    source: 'github',
    state: 'found',
    because: 'the last look with github found one new issue',
    grant: 'surfaces.intake.sources.github',
    accept: true,
    reply: true,
    names: false,
    mode: 'propose',
    template: 'reproduce-and-fix',
    projects: ['search', 'checkout'],
    allowed: 2,
    watch: 'intake.github',
    schedule: 'github-issues',
    every: '10m',
    lookedAt: ago(4),
    workedAt: ago(4),
    found: 1,
    fresh: 1,
    left: 0,
    trouble: null,
    until: null,
    handed: 6,
  },
]

const WORKFLOWS: WorkflowIn[] = []

/** What the window holds of the agent waiting on you: its screen, and what it has done. */
const STRIPE: AgentIn = {
  activity: [
    { at: ago(3), kind: 'asked', what: 'Bash', ok: null },
    { at: ago(4), kind: 'used', what: 'Edit', ok: null },
    { at: ago(6), kind: 'used', what: 'Read', ok: null },
    { at: ago(8), kind: 'checked', what: 'tests', ok: false },
    { at: ago(20), kind: 'checked', what: 'tests', ok: false },
    { at: ago(31), kind: 'committed', what: '', ok: null },
    { at: ago(43), kind: 'checked', what: 'tests', ok: true },
    { at: ago(52), kind: 'started', what: '', ok: null },
  ],
  lane: {
    kind: 'read',
    at: NOW - 2_000,
    text: [
      '',
      '  ● Upgrading stripe to v15. The webhook signature API changed,',
      '    so src/webhooks.ts needs the new constructEvent signature.',
      '',
      '  ▸ Read src/webhooks.ts',
      '  ▸ Edit src/webhooks.ts  +12 −4',
      '  ▸ Edit test/webhooks.test.ts  +31 −9',
      '',
      '  ● The tests still pin stripe@14. Installing v15 before running',
      '    them again.',
      '',
      '  ? Allow bash: npm i stripe@15',
      '',
    ].join('\n'),
  },
  // Its conversation out of its harness's record: what it was told, the
  // tools it reached for, and what it said — the agent page draws it as
  // markdown, a call as a row that opens.
  conversation: {
    kind: 'read',
    earlier: false,
    rev: '3',
    turns: [
      {
        kind: 'sent',
        text: 'Upgrade **stripe** to v15 and keep the webhook tests green.',
        at: ago(52),
      },
      {
        kind: 'tool',
        id: 'toolu_read',
        tool: 'Read',
        input: { file_path: 'src/webhooks.ts' },
        ok: true,
        result: '',
        at: ago(6),
      },
      {
        kind: 'tool',
        id: 'toolu_edit',
        tool: 'Edit',
        input: {
          file_path: 'src/webhooks.ts',
          old_string: 'constructEvent(',
          new_string: 'constructEventAsync(',
        },
        ok: true,
        result: '',
        at: ago(4),
      },
      {
        kind: 'reply',
        text: [
          'The webhook signature API changed in v15:',
          '',
          '- `constructEvent` is now `constructEventAsync`',
          '- the tests still pin **stripe@14**',
          '',
          'Installing v15 before running them again.',
        ].join('\n'),
        at: ago(3),
      },
      {
        kind: 'tool',
        id: 'toolu_bash',
        tool: 'Bash',
        input: { command: 'npm i stripe@15', description: 'Install stripe v15' },
        ok: null,
        result: null,
        at: ago(3),
      },
    ],
  },
  known: [],
}

/** A device, paired a while ago, granted every reading and both acting tiers. */
function device(id: string, label: string, pairedDaysAgo: number): Device {
  return {
    id,
    label,
    digest: '',
    host: 'localhost:7654',
    csrf: '',
    until: NOW + 30 * 86_400_000,
    pairedAt: NOW - pairedDaysAgo * 86_400_000,
    scopes: ['read', 'answer', 'steer', 'ask', 'agents', 'projects'],
    projects: null,
    granted: [...GRANTS],
    from: '127.0.0.1',
    revoked: null,
    owner: false,
    passkey: null,
  }
}

export const DESK = device('dev_4e1d9b07', 'MacBook Air', 12)
export const PHONE = device('dev_9a2c6f31', 'iPhone', 9)

function input(reach: Reach): SnapshotInput {
  return {
    lifetime: { epoch: '0f9e1c2a-0000-4000-8000-000000000000', rev: 1, openedAt: ago(180) },
    reach,
    projects: PROJECTS,
    tasks: TASKS,
    queue: QUEUE,
    findings: [
      {
        key: 'checkout/ledger-api@7c1e9f2:missing_tests',
        question: 'missing_tests',
        project: 'checkout',
        tasks: ['checkout/ledger-api'],
        at: ago(12),
        probability: 0.71,
        file: 'src/ledger/api.ts',
        stillThere: true,
        account: null,
        verdict: null,
      },
    ],
    notes: NOTES,
    plans: planStandings(PLANS, NOW),
    intake: INTAKE,
    sources: SOURCES,
    runs: RUNS,
    workflows: WORKFLOWS,
    warnings: [],
    machineUpSince: ago(300),
    spendSince: MIDNIGHT,
    checks: CHECKS,
    talk: {
      lines: [
        {
          id: `${new Date(ago(5)).toISOString()}#0`,
          at: ago(5),
          kind: 'asked',
          from: 'you',
          text: 'what needs me?',
          tool: '',
          outcome: '',
          call: null,
          streaming: false,
        },
        {
          id: `${new Date(ago(5)).toISOString()}#1`,
          at: ago(5),
          kind: 'tool',
          from: '',
          text: '',
          tool: 'tade_status',
          outcome: 'ok',
          call: { input: { project: 'payments' }, result: '' },
          streaming: false,
        },
        {
          id: `${new Date(ago(4)).toISOString()}#0`,
          at: ago(4),
          kind: 'reply',
          from: '',
          text: [
            '**stripe-v15** wants to run `npm i stripe@15`, which is the upgrade you asked for.',
            '',
            '- **ledger-api** is writing the endpoints',
            '- **refund-flow** starts when it is done',
          ].join('\n'),
          tool: '',
          outcome: '',
          call: null,
          streaming: false,
        },
      ],
      rev: 'c4',
      busy: false,
      whose: '',
      known: [],
      mine: true,
    },
  }
}

export const PAGE_WORLD: World = {
  now: NOW,
  devices: [DESK, PHONE],
  input,
  agent: (id) => (id === 'checkout/stripe-v15' ? STRIPE : null),
  settings: () => ({ groups: [], known: [] }),
}
