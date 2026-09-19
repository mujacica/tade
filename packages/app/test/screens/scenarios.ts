import { ConfigSchema, IDLE_REASON, settingsOf, type TadeEvent } from '@tade/core'
import { parseDiff } from '../../src/diff.ts'
import {
  type AppState,
  focusTask,
  initialState,
  openSchedule,
  type ScheduleView,
  setDictation,
  setListening,
  showPlan,
  splitPane,
  type TaskSnapshot,
  toggleDone,
  toggleSection,
  viewWork,
  withProjects,
  withTasks,
  withTerminals,
} from '../../src/model.ts'
import {
  branchMenuItems,
  branchPanel,
  changeMenuItems,
  closeDonePanel,
  confirmRemovePanel,
  diffPanel,
  extensionSetupPanel,
  extensionsPanel,
  extensionViewPanel,
  fileMenuItems,
  filePanel,
  findPanel,
  imageMenuItems,
  menuItems,
  menuPanel,
  modelPanel,
  openProjectPanel,
  promptPanel,
  searchPanel,
  settingsPanel,
  spendPanel,
  thinkingMenuItems,
} from '../../src/panels.ts'
import { type SearchEntry, searchResults } from '../../src/search.ts'
import { COLOUR } from '../../src/skin.ts'
import { spendView } from '../../src/spend.ts'
import {
  emptyTranscript,
  fromThinker,
  problem,
  said,
  suggest,
  type Transcript,
  thinking,
  youSaid,
} from '../../src/transcript.ts'
import type { Frame } from '../../src/view.ts'
import {
  editFrom,
  formattedLines,
  sourceLines,
  textLines,
  typeIn,
  type ViewedFile,
} from '../../src/viewer.ts'

// The screens the window must keep looking like.
//
// Each scenario is a state and a frame, drawn with fixed data so the result is
// the same on every machine: no clock, no git, no terminal. They are what the
// golden files under `__screens__/` are drawn from, and what the gallery shows
// a person reviewing a change to how Tade looks.
//
// Add one whenever the window gains a state worth protecting. Name it for what
// somebody would be doing when they saw it.

export interface Scenario {
  name: string
  /** What it shows, for the gallery. */
  about: string
  state: AppState
  frame: Frame
}

const NOW = Date.parse('2026-09-13T14:00:04Z')

const tasks: TaskSnapshot[] = [
  {
    task: 'checkout/stripe-v15',
    state: 'blocked',
    lane: 'checkout/stripe-v15/agent',
    lanes: [
      { id: 'checkout/stripe-v15/agent', kind: 'agent' },
      { id: 'checkout/stripe-v15/shell', kind: 'shell' },
    ],
    waiting: true,
    approval: { tool: 'bash', summary: 'npm i stripe@15' },
  },
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  { task: 'search/pagination', state: 'review' },
]

const agentScreen = [
  '',
  '  ● Upgrading stripe to v15. The webhook signature API changed,',
  '    so src/webhooks.ts needs the new constructEvent signature.',
  '',
  '  ▸ Read src/webhooks.ts',
  '  ▸ Edit src/webhooks.ts  +12 −4',
  '  ▸ bash npm i stripe@15',
].join('\n')

const base = (): AppState =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), tasks),
    'checkout/stripe-v15',
  )

/** The same window with two agents in it that have finished: what cleanup is for. */
const finished = (): AppState =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), [
      ...tasks,
      {
        task: 'checkout/refund-emails',
        state: 'review',
        title: 'Send an email when a refund lands',
      },
      {
        task: 'checkout/webhook-retries',
        state: 'blocked',
        reason: IDLE_REASON,
        finished: { by: 'agent', summary: 'Retries are idempotent now, with a test' },
      },
    ]),
    'checkout/stripe-v15',
  )

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 34,
  screen: agentScreen,
  skin: COLOUR,
  now: NOW,
  home: '~/.tade',
  orchestratorModel: 'openrouter/anthropic/claude-opus-5',
  orchestratorAccount: { provider: 'openrouter', credential: 'signed in' },
  files: [
    { path: 'src', name: 'src', depth: 0, folder: true, open: true },
    {
      path: 'src/webhooks.test.ts',
      name: 'webhooks.test.ts',
      depth: 1,
      folder: false,
      open: false,
    },
    { path: 'src/webhooks.ts', name: 'webhooks.ts', depth: 1, folder: false, open: false },
    { path: 'test', name: 'test', depth: 0, folder: true, open: false },
    { path: 'package.json', name: 'package.json', depth: 0, folder: false, open: false },
    { path: 'README.md', name: 'README.md', depth: 0, folder: false, open: false },
  ],
  where: {
    repo: '~/src/checkout',
    branch: 'tade/stripe-v15',
    base: 'main',
    worktree: '~/.tade/worktrees/checkout-stripe-v15',
    path: '/Users/me/.tade/worktrees/checkout-stripe-v15',
  },
  changes: [
    { path: 'package.json', mark: 'M', added: 2, removed: 1 },
    { path: 'src/webhooks.test.ts', mark: 'A', added: 48, removed: null },
    { path: 'src/webhooks.ts', mark: 'M', added: 12, removed: 4 },
  ],
  notes: [
    { text: 'the staging key rotates on the 1st', at: '2026-09-01T09:00:00.000Z' },
    { text: 'we pin major versions', at: '2026-09-02T09:00:00.000Z' },
    { text: 'refunds go through the ledger service', at: '2026-09-03T09:00:00.000Z' },
    { text: 'never force-push to main', at: '2026-09-04T09:00:00.000Z' },
  ],
  base: 'main',
  spend: {
    tokens: 1_900_000,
    usd: 2.66,
    hasCost: true,
    byTask: {
      'checkout/stripe-v15': { tokens: 880_000, usd: 1.26 },
      'checkout/refunds': { tokens: 460_000, usd: 0.62 },
      'search/pagination': { tokens: 148_000, usd: 0.2 },
    },
    // Two agents still at it, so the morning's agent time is longer than the
    // morning: what `ran` below adds up to.
    runtime: { ms: 7_500_000, runs: 3, running: true },
  },
  route: {
    harness: 'pi',
    model: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    credential: 'signed in',
  },
  vitals: { model: 'anthropic/claude-opus-5', thinking: 'high', contextPercent: 41 },
  voice: { keys: ['ctrl', 'space'], available: true },
  ...over,
})

/** Times said in UTC, so the screens do not change with the machine's time zone. */
const utcClock = (at: number) => new Date(at).toISOString().slice(11, 16)

/** Dates said in UTC, the way the window says them. */
const utcDate = (at: number) => {
  const time = new Date(at)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getUTCDay()] ?? ''
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${day} ${time.getUTCDate()} ${month[time.getUTCMonth()] ?? ''} ${utcClock(at)}`
}

/** A plan under way: two agents working, the rest queued in every way queued work can be. */
const queueTasks: TaskSnapshot[] = [
  { task: 'checkout/fix-charge', state: 'failed', reason: 'tests failed twice' },
  { task: 'checkout/bump-mailer', state: 'working', lane: 'checkout/bump-mailer/agent' },
  {
    task: 'checkout/add-refunds',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: {
        kind: 'held',
        on: 'checkout/fix-charge',
        because: 'checkout/fix-charge failed: tests failed twice',
      },
      after: [{ task: 'checkout/fix-charge', why: 'both change src/charge.ts' }],
      prompt: 'Add partial refunds to the charge flow. Use the ChargeResult type fix-charge adds.',
      touches: ['src/refunds.ts', 'src/charge.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/docs-typos',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'ready' },
      after: [],
      prompt: 'Fix the typos in docs/.',
      touches: ['docs/'],
      at: null,
    },
  },
  {
    task: 'checkout/refund-emails',
    state: 'queued',
    by: 'orchestrator',
    done: 'said',
    queued: {
      state: { kind: 'waiting', on: ['checkout/add-refunds', 'checkout/bump-mailer'] },
      after: [
        { task: 'checkout/add-refunds', why: 'it emails what refund() returns' },
        { task: 'checkout/bump-mailer', why: 'the mailer’s send() changes in v4' },
      ],
      prompt:
        'Email the customer when a refund goes through: use the new mailer, and say how much came back and when.',
      touches: ['src/mail/refund.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/release-notes',
    state: 'queued',
    queued: {
      state: { kind: 'scheduled', at: Date.parse('2026-09-13T18:00:00Z') },
      after: [],
      prompt: 'Draft the release notes from what merged today.',
      touches: [],
      at: Date.parse('2026-09-13T18:00:00Z'),
    },
  },
  {
    task: 'checkout/perf-check',
    state: 'queued',
    queued: {
      state: { kind: 'paused', all: false },
      after: [],
      prompt: 'Run the benchmarks.',
      touches: [],
      at: null,
    },
  },
]

/** A chain of work, each piece waiting on the one before it, and one that waits on nothing. */
const chainTasks: TaskSnapshot[] = [
  { task: 'checkout/schema', state: 'working', lane: 'checkout/schema/agent' },
  {
    task: 'checkout/api',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/schema'] },
      after: [{ task: 'checkout/schema', why: 'the endpoints follow the tables' }],
      prompt: 'Add the refunds endpoints once the tables are in.',
      touches: ['src/api/refunds.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/client',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/api'] },
      after: [{ task: 'checkout/api', why: 'it calls what the endpoints return' }],
      prompt: 'Call the new refunds endpoints from the dashboard.',
      touches: ['src/client/refunds.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/docs',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/client'] },
      after: [{ task: 'checkout/client', why: 'it screenshots the dashboard' }],
      prompt: 'Write up refunds for the guide.',
      touches: ['docs/refunds.md'],
      at: null,
    },
  },
  {
    task: 'checkout/tidy-mailer',
    state: 'queued',
    queued: {
      state: { kind: 'ready' },
      after: [],
      prompt: 'Tidy the mailer templates.',
      touches: [],
      at: null,
    },
  },
]

/** Schedules beside the queued work: one on repeat, one that asks the orchestrator, one paused. */
const queueSchedules: ScheduleView[] = [
  {
    id: 'deps-weekly',
    name: 'deps weekly',
    project: 'checkout',
    said: 'every monday morning update our dependencies',
    kind: 'agent',
    does: 'starts an agent',
    prompt:
      'Update dependencies within their major versions, run the tests, and commit what changed.',
    when: 'every Monday at 09:00',
    once: false,
    next: [
      Date.parse('2026-09-14T09:00:00Z'),
      Date.parse('2026-09-21T09:00:00Z'),
      Date.parse('2026-09-28T09:00:00Z'),
    ],
    paused: false,
    by: 'you',
    missed: 'once',
    runs: [
      {
        due: Date.parse('2026-09-07T09:00:00Z'),
        ran: true,
        missed: 0,
        task: 'checkout/deps-weekly-0907',
      },
      {
        due: Date.parse('2026-08-31T09:00:00Z'),
        ran: true,
        missed: 2,
        task: 'checkout/deps-weekly-0831',
      },
    ],
  },
  {
    id: 'morning-brief',
    name: 'morning brief',
    project: 'checkout',
    said: 'every weekday at 8:45 tell me what happened overnight',
    kind: 'ask',
    does: 'asks the orchestrator',
    prompt: 'Say what the agents did overnight, what failed, and what needs the person first.',
    when: 'every weekday at 08:45',
    once: false,
    next: [Date.parse('2026-09-14T08:45:00Z')],
    paused: false,
    by: 'orchestrator',
    missed: 'skip',
    runs: [],
  },
  {
    id: 'perf-nightly',
    name: 'perf nightly',
    project: 'checkout',
    said: '',
    kind: 'agent',
    does: 'starts an agent',
    prompt: 'Run the benchmarks.',
    when: 'every day at 02:00',
    once: false,
    next: [Date.parse('2026-09-14T02:00:00Z')],
    paused: true,
    by: 'you',
    missed: 'once',
    runs: [],
  },
]

/** A watch Sentry offers, turned on: what it found at its last look, and each look. */
const sentryWatch: ScheduleView = {
  id: 'new-sentry-errors',
  name: 'New Sentry errors',
  project: 'checkout',
  said: '',
  kind: 'watch',
  does: 'looks with sentry.new-errors, and starts work on what it finds',
  prompt: '',
  when: 'every hour',
  once: false,
  next: [
    Date.parse('2026-09-14T10:00:00Z'),
    Date.parse('2026-09-14T11:00:00Z'),
    Date.parse('2026-09-14T12:00:00Z'),
  ],
  paused: false,
  by: 'extension:sentry',
  missed: 'once',
  runs: [],
  watch: {
    id: 'sentry.new-errors',
    turnedOnBy: 'you',
    found: 'agent',
    most: 2,
    looks: [
      { at: Date.parse('2026-09-14T09:00:00Z'), found: 3, fresh: 3, left: 1, problem: null },
      { at: Date.parse('2026-09-14T08:00:00Z'), found: 1, fresh: 0, left: 0, problem: null },
      {
        at: Date.parse('2026-09-14T07:00:00Z'),
        found: 0,
        fresh: 0,
        left: 0,
        problem: 'Sentry is rate limiting these requests (429): try again in a minute',
      },
    ],
    findings: [
      {
        at: Date.parse('2026-09-14T09:00:00Z'),
        key: '4413',
        title: 'CHECKOUT-3F: Error: card_declined is not handled',
        task: null,
        told: null,
        problem: 'Sentry answered 502: Bad Gateway',
      },
      {
        at: Date.parse('2026-09-14T09:00:00Z'),
        key: '4412',
        title: "CHECKOUT-3E: TypeError: Cannot read properties of undefined (reading 'amount')",
        task: 'checkout/fix-checkout-3e',
        told: null,
        problem: null,
      },
      {
        at: Date.parse('2026-09-13T16:00:00Z'),
        key: '4398',
        title: 'CHECKOUT-3A: RangeError: Invalid currency code',
        task: 'checkout/fix-checkout-3a',
        told: null,
        problem: null,
      },
    ],
  },
}

let seq = 0
const usage = (task: string | null, model: string, tokens: number, usd: number): TadeEvent => ({
  seq: ++seq,
  ts: '2026-09-13T13:00:00.000Z',
  type: 'usage',
  urgency: 'routine',
  task,
  lane: null,
  run: null,
  detail: { model, tokens, usd, ...(task ? {} : { by: 'orchestrator' }) },
})

/** A morning's spend, the one the design was drawn with. */
const spent = [
  usage(null, 'anthropic/claude-opus-5', 412_000, 0.58),
  usage('checkout/stripe-v15', 'anthropic/claude-opus-5', 880_000, 1.26),
  usage('checkout/refunds', 'anthropic/claude-opus-5', 460_000, 0.62),
  usage('search/pagination', 'anthropic/claude-sonnet-5', 148_000, 0.2),
]

const runEvent = (type: 'run_started' | 'run_exited', task: string, ts: string): TadeEvent => ({
  seq: ++seq,
  ts,
  type,
  urgency: 'notable',
  task,
  lane: `${task}/agent`,
  run: `${task}/agent`,
  detail: type === 'run_started' ? { model: 'anthropic/claude-opus-5' } : {},
})

/** The same morning's runs: two agents still going, one that finished. */
const ran = [
  runEvent('run_started', 'checkout/stripe-v15', '2026-09-13T13:05:00.000Z'),
  runEvent('run_started', 'search/pagination', '2026-09-13T13:02:00.000Z'),
  runEvent('run_started', 'checkout/refunds', '2026-09-13T13:20:00.000Z'),
  runEvent('run_exited', 'search/pagination', '2026-09-13T13:32:00.000Z'),
]

/** What the Settings panel is shown: a machine set up the way the design was drawn. */
function settingsFacts() {
  const config = ConfigSchema.parse({
    projects: {
      checkout: { root: '~/src/checkout', budget: { usd_per_day: 5 } },
      search: { root: '~/src/search' },
      infra: { root: '~/src/infra' },
    },
    surfaces: {
      voice: {
        mic: { device: 'MacBook Pro Microphone' },
        attention: { budget: 6, quiet: '22:00-07:00' },
      },
    },
  })
  return {
    settings: settingsOf(config),
    accounts: ['anthropic'],
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 1,
  }
}

const webhooksFile: ViewedFile = {
  path: '/Users/me/src/checkout/src/webhooks.ts',
  size: 1_184,
  binary: false,
  truncated: false,
  language: 'typescript',
  mtimeMs: 1_700_000_000_000,
  error: null,
  text: [
    "import Stripe from 'stripe'",
    "import { refund } from './ledger.ts'",
    '',
    '/** Every event Stripe sends us, checked before anything acts on it. */',
    'export async function handle(body: string, sig: string): Promise<void> {',
    '  const key = process.env.STRIPE_WEBHOOK_SECRET',
    "  if (!key) throw new Error('no webhook secret')",
    '  const cryptoProvider = Stripe.createSubtleCryptoProvider()',
    '  const event = await stripe.webhooks.constructEventAsync(',
    '    body, sig, key, undefined, cryptoProvider,',
    '  )',
    "  if (event.type === 'charge.refunded') {",
    '    await refund(event)',
    '  }',
    '}',
    '',
  ].join('\n'),
}

const readmeFile: ViewedFile = {
  path: '/Users/me/src/checkout/README.md',
  size: 412,
  binary: false,
  truncated: false,
  language: 'markdown',
  mtimeMs: 1_700_000_000_000,
  error: null,
  text: [
    '# checkout',
    '',
    'Takes the **money**, and gives it back when it has to.',
    '',
    '## Running it',
    '',
    '- `pnpm dev` starts it against the Stripe test keys',
    '- `pnpm test` runs everything, webhooks included',
    '',
    '```ts',
    'const event = await stripe.webhooks.constructEventAsync(body, sig, key)',
    '```',
    '',
    '> Never force-push to main.',
    '',
  ].join('\n'),
}

function viewing(file: ViewedFile, width?: number) {
  return {
    file,
    source: sourceLines(file, false),
    text: textLines(file),
    formatted: width ? formattedLines(file, width, false) : null,
  }
}

const checkout = { path: '/Users/me/src/checkout', label: 'checkout', task: null }
const stripeTree = {
  path: '/Users/me/.tade/worktrees/checkout-stripe-v15',
  label: 'checkout › stripe-v15',
  task: 'checkout/stripe-v15',
}

/** What search shows for a query, from the same function the window uses. */
function searched(query: string): SearchEntry[] {
  const agents: SearchEntry[] = [
    {
      id: 'approve:checkout/stripe-v15',
      kind: 'approval',
      label: 'Allow once: npm i stripe@15',
      detail: 'stripe-v15',
      mark: '▲',
      tone: 'waiting',
    },
    {
      id: 'task:checkout/stripe-v15',
      kind: 'agent',
      label: 'stripe-v15',
      detail: 'in checkout',
      mark: '●',
      tone: 'waiting',
      note: 'waiting on you',
      complete: '@stripe-v15',
    },
    { id: 'run:new-agent', kind: 'action', label: 'New agent', mark: '›' },
    {
      id: 'setting:approvals',
      kind: 'setting',
      label: 'Approvals › Tools that always ask',
      mark: '◇',
    },
  ]
  const files = ['src/webhooks.ts', 'src/webhooks.test.ts', 'src/ledger.ts', 'README.md']
  return searchResults(query, {
    entries: agents,
    files: [
      ...files.map((path) => ({ root: checkout, path })),
      ...files.map((path) => ({ root: stripeTree, path })),
    ],
    matches: [
      {
        root: stripeTree,
        path: 'src/webhooks.ts',
        line: 9,
        text: '  const event = await stripe.webhooks.constructEventAsync(',
      },
      {
        root: checkout,
        path: 'README.md',
        line: 7,
        text: '- `pnpm test` runs everything, webhooks included',
      },
    ],
  })
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'what-an-agent-has-done',
    about:
      'The work tab beside an agent’s screen: its branch, the commits on it and whose they are, the review it is out for with what CI says about it, and how the project’s own checks stand at the commit in hand — run here, before anybody else has to look. The REVIEWS section down the side is every review that is open, from the same poll.',
    state: viewWork(base(), 'checkout/stripe-v15'),
    frame: frame({
      work: {
        task: 'checkout/stripe-v15',
        branch: 'tade/stripe-v15',
        base: 'main',
        ahead: 3,
        behind: 0,
        dirty: 0,
        commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        commits: [
          {
            sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            subject: 'move to the stripe v15 payment intents API',
            at: NOW - 12 * 60_000,
            task: 'checkout/stripe-v15',
          },
          {
            sha: '9f0e1d2c3b4a59687778695a4b3c2d1e0f000000',
            subject: 'keep the old webhook shape working for a release',
            at: NOW - 60 * 60_000,
            task: 'checkout/stripe-v15',
          },
          {
            sha: '77c4ab0998877665544332211aabbccddeeff001',
            subject: 'a test for the refund path',
            at: NOW - 2 * 3_600_000,
            task: null,
          },
        ],
        attributed: '2 with this task’s trailer',
        review: {
          number: '#418',
          title: 'stripe v15',
          url: 'https://github.com/acme/checkout/pull/418',
          marks: [
            { text: 'draft', tone: 'quiet' },
            { text: '✗ checks', tone: 'bad' },
          ],
        },
        checks: [
          { id: 'format', state: 'passed', summary: null, seconds: 2.1 },
          { id: 'types', state: 'passed', summary: null, seconds: 6.4 },
          {
            id: 'tests',
            state: 'failed',
            summary: '8 failed  packages/app/test/view.test.ts',
            seconds: 64,
          },
        ],
        source: 'from .tade/checks.yaml',
        running: false,
        notes: ['Green here is the commands on this machine; the OS matrix is CI’s to say.'],
      },
      lists: [
        {
          id: 'review.open',
          title: 'REVIEWS',
          problem: null,
          rows: [
            {
              section: 'review.open',
              id: 'github.com/acme/checkout#418',
              title: '#418  stripe v15',
              marks: [
                { text: 'draft', tone: 'quiet' },
                { text: '✗ checks', tone: 'bad' },
              ],
              task: 'checkout/stripe-v15',
            },
            {
              section: 'review.open',
              id: 'github.com/acme/checkout#412',
              title: '#412  retry refunds once',
              marks: [{ text: 'ready', tone: 'good' }],
            },
            {
              section: 'review.open',
              id: 'github.com/acme/api#77',
              title: '#77  bump zod',
              marks: [{ text: 'you', tone: 'warning' }],
            },
          ],
        },
      ],
    }),
  },
  {
    name: 'watching-an-agent',
    about:
      'The window with an agent waiting on an approval, its changes, spend and the talk key. The bar down the right of the sidebar and of the agent says where in each you are, and the block on the agent’s screen is where what you type would land.',
    state: base(),
    frame: frame({ paneScreen: { lines: 180, cursor: { back: 0, column: 25 } } }),
  },
  {
    name: 'pointing-at-a-button',
    about: 'The pointer over Open project: hover is drawn, not left to the terminal.',
    state: { ...base(), hover: { kind: 'action', name: 'open-project' } },
    frame: frame(),
  },
  {
    name: 'every-kind-of-agent',
    about:
      'One agent of each kind, told apart by shape as well as colour: working turns, idle, waiting on you, failed, finished, not running, parked. Each agent is a two-line tab — its name, and what it is doing — with room around it: long names end in …, the one you are on has an accent, and the one under the pointer is lit with its close and menu.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), [
          {
            task: 'checkout/agent-spend',
            state: 'working',
            title: 'Agent spend invisible because the spend manager filters by project',
            lane: 'checkout/agent-spend/agent',
          },
          {
            task: 'checkout/notes-design',
            state: 'blocked',
            reason: IDLE_REASON,
            title: 'Update notes panel to match the new agent rows',
            lane: 'checkout/notes-design/agent',
          },
          {
            task: 'checkout/stripe-v15',
            state: 'blocked',
            lane: 'checkout/stripe-v15/agent',
            waiting: true,
            approval: { tool: 'bash', summary: 'npm i stripe@15' },
          },
          { task: 'checkout/reload', state: 'failed', reason: 'agent exited with code 1' },
          {
            task: 'checkout/refunds',
            state: 'blocked',
            reason: IDLE_REASON,
            // Its agent said so: finished, not idle.
            finished: { by: 'agent', summary: 'Refunds charge once, with a test' },
          },
          { task: 'checkout/queue', state: 'queued' },
          { task: 'checkout/later', state: 'parked' },
        ]),
        'checkout/notes-design',
      ),
      folded: ['changes', 'files', 'where'],
      hover: { kind: 'task', task: 'checkout/stripe-v15' },
    },
    frame: frame({
      spend: {
        tokens: 900_000,
        usd: 1.9,
        hasCost: true,
        byTask: {
          'checkout/agent-spend': { tokens: 600_000, usd: 5.73 },
          'checkout/stripe-v15': { tokens: 300_000, usd: 1.26 },
        },
      },
    }),
  },
  {
    name: 'a-smart-queue',
    about:
      'Work planned together: two agents working, and under them the SMART QUEUE in the order the resolved tree gives — held because what it waited on failed, with what waits on it shifted right and joined to it by a line, then next, at a time, and paused — told apart by shape, with filters over it. The held one is open: it will not start by itself, it says what can be done, and the chain it is in is drawn with its own box the heavy one.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), queueTasks),
        'checkout/add-refunds',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
      hover: { kind: 'task', task: 'checkout/refund-emails' },
    },
    frame: frame({ screen: '', height: 56, clock: utcClock, schedules: queueSchedules }),
  },
  {
    name: 'a-schedule',
    about:
      'A schedule open where an agent’s screen would be: when it runs and what it does, what its agent is told, its next runs, what happens to runs Tade was closed for, who made it, and each time it ran.',
    state: {
      ...openSchedule(
        withTasks(withProjects(initialState(), ['checkout']), queueTasks),
        'deps-weekly',
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      queueFilter: 'timed',
    },
    frame: frame({
      screen: '',
      height: 44,
      clock: utcClock,
      date: utcDate,
      schedules: queueSchedules,
    }),
  },
  {
    name: 'a-watch',
    about:
      'A watch Sentry offers, turned on and open: how often it looks and what it starts, how many one look acts on, who turned it on, what it found and what became of each, and how each look went.',
    state: {
      ...openSchedule(
        withTasks(withProjects(initialState(), ['checkout']), [
          ...queueTasks,
          {
            task: 'checkout/fix-checkout-3e',
            state: 'working',
            lane: 'checkout/fix-checkout-3e/agent',
            by: 'schedule:new-sentry-errors',
          },
        ]),
        'new-sentry-errors',
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      queueFilter: 'timed',
    },
    frame: frame({
      screen: '',
      height: 44,
      clock: utcClock,
      date: utcDate,
      schedules: [...queueSchedules, sentryWatch],
    }),
  },
  {
    name: 'the-plan',
    about:
      'The plan the queue came from, where an agent’s screen would be: a column per step, a box per task with its mark and what it is doing, an arrow for each wait, and every wait’s reason under it.',
    state: {
      ...showPlan(withTasks(withProjects(initialState(), ['checkout']), queueTasks)),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', height: 44, clock: utcClock }),
  },
  {
    name: 'waiting-in-the-queue',
    about:
      'Queued work open in front of you — which is what clicking it in the queue shows: the whole chain it is in as boxes, its own drawn heavier, every wait’s reason under it, what its agent will be told, what it will change, and how it counts as finished.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), queueTasks),
        'checkout/refund-emails',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
      queueFilter: 'next',
    },
    frame: frame({ screen: '', height: 44, clock: utcClock }),
  },
  {
    name: 'a-chain-in-the-queue',
    about:
      'A chain four deep, in the middle of it. Down the side, the queue in the order the tree resolves to: what can start now first, then the chain — each piece shifted right of what it waits on and joined to it by a line that carries through the room between the tabs. In front of you, the whole chain as boxes, left to right, with the one you are on drawn heavier, and every wait’s reason under it.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), chainTasks),
        'checkout/client',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', width: 150, height: 40, clock: utcClock }),
  },
  {
    name: 'pointing-at-a-note',
    about:
      'The pointer over a note: it lights as a tab, a second line where its words run on, with its forget and menu at the end.',
    state: {
      ...base(),
      folded: ['changes', 'files', 'where'],
      hover: {
        kind: 'note',
        at: '2026-09-03T09:00:00.000Z',
        text: 'refunds go through the ledger service',
      },
    },
    frame: frame(),
  },
  {
    name: 'pointing-at-a-file',
    about: 'The pointer over a file in FILES: its row is shaded, so the click is plain.',
    state: { ...base(), hover: { kind: 'file', path: 'src/webhooks.ts' } },
    frame: frame(),
  },
  {
    name: 'a-shell-beside-the-agent',
    about:
      'An agent and its shell side by side: a divider to drag, and on the shell’s half its name, swap, turn and close.',
    state: {
      ...splitPane(base(), 'checkout/stripe-v15', 'checkout/stripe-v15/shell', 'beside'),
      keyboard: 'pane',
    },
    frame: frame({
      splitScreen: [
        '~/src/checkout (tade/stripe-v15) $ git diff --stat',
        ' src/webhooks.ts | 16 ++++++++++------',
        ' 1 file changed, 12 insertions(+), 4 deletions(-)',
        '~/src/checkout (tade/stripe-v15) $ ',
      ].join('\n'),
    }),
  },
  {
    name: 'two-terminals-split',
    about: 'Two terminals in the bottom panel, one below the other, the lower one typed into.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
      terminalSplit: { lane: 'checkout/terminals/2', direction: 'below', ratio: 0.5 },
      splitFocus: true,
      sizes: { stripHeight: 14 },
    },
    frame: frame({
      terminal: { screen: '~/src/checkout (main) $ pnpm test --watch\n ✓ 48 tests', find: null },
      splitTerminal: {
        screen: '~/src/checkout (main) $ pnpm dev\n  ready on http://localhost:3000',
        find: null,
      },
    }),
  },
  {
    name: 'terminals',
    about:
      'Terminals along the bottom: a tab each beside the orchestrator, the one in front typed into.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
    },
    frame: frame({
      terminal: {
        screen: [
          '~/src/checkout (main) $ pnpm test src/webhooks',
          '',
          ' ✓ src/webhooks.test.ts (12 tests) 48ms',
          ' ✗ refunds once when the webhook retries',
          '   AssertionError: expected 2 charges to be 1',
          '',
          '~/src/checkout (main) $ ',
        ].join('\n'),
        // Where the shell left its cursor, and how far back the lane reads:
        // the block you type at, and the bar that says where you are.
        view: { lines: 240, cursor: { back: 0, column: 24 } },
      },
    }),
  },
  {
    name: 'reading-back-a-terminal',
    about:
      'A terminal scrolled back through what it printed: the bar on the right says how far back, and the foot of it offers the newest line again.',
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
      ]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
      terminalScroll: 120,
    },
    frame: frame({
      terminal: {
        screen: [
          ' ✓ src/ledger.test.ts (4 tests) 12ms',
          ' ✓ src/refunds.test.ts (9 tests) 31ms',
          ' ✓ src/webhooks.test.ts (12 tests) 48ms',
          ' ✗ charges once when the webhook retries',
          '   AssertionError: expected 2 charges to be 1',
        ].join('\n'),
        view: { lines: 240, cursor: { back: 0, column: 24 } },
      },
    }),
  },
  {
    name: 'finding-in-a-terminal',
    about:
      "Find in a terminal: its scrollback, the line found lit, and the box on the panel's edge.",
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
      ]),
      bottom: 'checkout/terminals/1',
      panel: findPanel('checkout/terminals/1', 'assert', 0),
    },
    frame: frame({
      panel: { found: 2, terminalName: 'tests' },
      terminal: {
        screen: '',
        find: {
          query: 'assert',
          line: 6,
          lines: [
            '$ pnpm test',
            ' ✓ src/ledger.test.ts (4 tests)',
            ' ✗ charges once',
            '   AssertionError: expected 2 charges to be 1',
            ' ✓ src/webhooks.test.ts (12 tests)',
            ' ✗ refunds once when the webhook retries',
            '   AssertionError: expected 2 refunds to be 1',
            '$ ',
          ],
        },
      },
    }),
  },
  {
    name: 'bottom-panel-folded',
    about: 'The bottom panel folded to its tabs, giving the agent the height.',
    state: { ...base(), bottomMode: 'min' },
    frame: frame(),
  },
  {
    name: 'dragging-the-sidebar',
    about: 'A divider under the pointer lights up; dragged, the sidebar follows.',
    state: { ...base(), resizing: 'sidebar', sizes: { sidebarWidth: 40 } },
    frame: frame({ layout: { sidebarWidth: 40 } }),
  },
  {
    name: 'every-section-open',
    about: 'Notes unfolded too, as they are after a click on the heading.',
    state: toggleSection(base(), 'notes'),
    frame: frame(),
  },
  {
    name: 'an-agent-not-running',
    about: 'An agent that is not running: one button opens it again.',
    state: focusTask(base(), 'search/pagination'),
    frame: frame({ screen: '', changes: [] }),
  },
  {
    name: 'talking',
    about: 'The microphone is open: the chip and the strip both say so, in red.',
    state: {
      ...setListening(base(), true),
      talkingSince: NOW - 4_000,
      levels: [
        0.05, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 0.9, 0.6, 0.35, 0.15, 0.1, 0.2, 0.4, 0.6, 0.75, 0.85, 0.7,
        0.55, 0.35, 0.2, 0.1,
      ],
    },
    frame: frame(),
  },
  {
    name: 'typing-to-tade',
    about: 'The orchestrator line, open and being typed into.',
    state: setDictation(
      { ...base(), focused: null, chose: true },
      'what is going on with checkout',
    ),
    frame: frame({ screen: '' }),
  },
  {
    name: 'orchestrator-at-work',
    about:
      'The conversation as it happens: what you said, each tool as it runs or fails with its reason, the answer arriving.',
    state: {
      ...base(),
      focused: null,
      chose: true,
      sizes: { stripHeight: 16 },
      transcript: [
        (t: Transcript) => youSaid(t, 'run the webhook tests and tell me what broke', 0),
        (t: Transcript) => thinking(t, 0),
        (t: Transcript) =>
          fromThinker(t, { type: 'tool', id: '1', tool: 'tade_status', input: {} }, 1),
        (t: Transcript) =>
          fromThinker(t, { type: 'tool_done', id: '1', ok: true, text: '2 agents, 1 waiting' }, 2),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool',
              id: '2',
              tool: 'tade_terminal_run',
              input: { terminal: 'tests', command: 'pnpm test src/webhooks' },
            },
            3,
          ),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool_done',
              id: '2',
              ok: false,
              text: 'no terminal called tests is open in checkout: open one first, or name another',
            },
            4,
          ),
        (t: Transcript) =>
          fromThinker(
            t,
            {
              type: 'tool',
              id: '3',
              tool: 'tade_terminal_open',
              input: { project: 'checkout', name: 'tests' },
            },
            5,
          ),
        (t: Transcript) =>
          fromThinker(t, { type: 'delta', text: 'Opening a **tests** terminal first, then' }, 6),
      ].reduce((t, step) => step(t), emptyTranscript()),
    },
    frame: frame({ screen: '', now: 1_300 }),
  },
  {
    name: 'orchestrator-did-not-start',
    about: 'The orchestrator failing to start, said where you would wait for it, with the reason.',
    state: {
      ...base(),
      focused: null,
      chose: true,
      transcript: problem(
        youSaid(emptyTranscript(), 'where are we', 0),
        'The orchestrator did not start: claude-opus-5 is not offered by anything you are signed in to (openrouter): pick one in Settings',
        1,
      ),
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'dropping-a-screenshot',
    about:
      'A screenshot dropped on the window: who it is for, starting on whoever you were typing to.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'images', paths: ['/Users/me/Desktop/Screenshot 2026-09-14 at 09.12.33.png'] },
        'Screenshot 2026-09-14 at 09.12.33.png',
      ),
    },
    frame: frame({
      panel: {
        items: imageMenuItems({
          agents: [
            { task: 'checkout/refunds', name: 'refunds', running: true, focused: true },
            { task: 'checkout/stripe-v15', name: 'stripe-v15', running: false, focused: false },
          ],
          terminal: { id: 'checkout/terminals/1', name: 'tests' },
        }),
      },
    }),
  },
  {
    name: 'a-screenshot-attached',
    about: 'A picture waiting to go to the orchestrator with what you type next.',
    state: {
      ...setDictation(
        { ...base(), focused: null, chose: true },
        'why does the refund button look like this',
      ),
      attached: ['/var/folders/T/tade-clipboard-1.png'],
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'pointing-at-a-terminal-tab',
    about: "A terminal's tab under the pointer: its menu and close button appear.",
    state: {
      ...withTerminals(base(), [
        { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
        { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
      ]),
      hover: { kind: 'bottom-tab', tab: 'checkout/terminals/2' },
    },
    frame: frame(),
  },
  {
    name: 'extensions',
    about:
      'The Extensions panel: what works, what needs setting up and how, what is broken, what is sitting there turned off, the actions of each, the tools Tade wrote for itself, and what pi loads by itself.',
    state: { ...base(), panel: extensionsPanel() },
    frame: frame({
      panel: {
        extensions: [
          {
            name: 'deps',
            title: 'Dependencies',
            description:
              'Finds what a project depends on that is out of date, vulnerable or deprecated, and updates it in an agent’s worktree.',
            source: 'built-in',
            state: 'ready',
            problem: null,
            tools: ['deps_check', 'deps_update'],
            actions: [
              { id: 'check', title: 'Check dependencies' },
              { id: 'update', title: 'Update dependencies (minor)' },
              { id: 'update-major', title: 'Update dependencies (major)' },
            ],
            unknownSettings: [],
            configurable: true,
            folder: null,
            watches: [],
          },
          {
            name: 'sentry',
            title: 'Sentry',
            description: 'Reads the errors, traces, logs and metrics your projects send to Sentry.',
            source: 'built-in',
            state: 'needs setup',
            problem:
              'no Sentry token: set $SENTRY_AUTH_TOKEN to a user auth token (org:read, project:read, event:read, event:write), or log in with sentry-cli',
            tools: ['sentry_issues', 'sentry_issue'],
            actions: [{ id: 'new', title: 'New Sentry issues' }],
            unknownSettings: ['orgg'],
            configurable: true,
            folder: null,
            watches: [
              {
                id: 'new-errors',
                title: 'New Sentry errors',
                means:
                  'Looks for issues first seen in Sentry since its last look, and starts an agent on each with everything Sentry knows, to find the cause, fix it and test it.',
                every: '1h',
                project: 'checkout',
                on: null,
              },
            ],
          },
          {
            name: 'standup',
            title: 'standup',
            description: '',
            source: 'yours',
            state: 'broken',
            problem: "SyntaxError: Unexpected token '!'",
            tools: [],
            actions: [],
            unknownSettings: [],
            configurable: false,
            folder: '/Users/me/.tade/extensions/standup',
            watches: [],
          },
          {
            name: 'release-notes',
            title: 'release-notes',
            description:
              'Drafts release notes from merged work, because you asked for them every Friday.',
            source: 'yours',
            state: 'off',
            problem: 'not turned on',
            tools: [],
            actions: [],
            unknownSettings: [],
            configurable: false,
            folder: '/Users/me/.tade/extensions/release-notes',
            watches: [],
          },
        ],
        written: [
          {
            name: 'standup-notes',
            why: 'Reads out what each agent did yesterday, because you ask every morning.',
            path: '/Users/me/.tade/extensions/standup-notes.ts',
            on: false,
          },
        ],
        harnessExtensions: [{ name: 'plan-mode', where: '~/.pi/agent/extensions' }],
        extensionsRoot: '~/.tade/extensions',
      },
    }),
  },
  {
    name: 'setting-up-sentry',
    about:
      'Setting an extension up: why it is not working, a guide in steps, where to get what it needs, and a field for each thing, with what the token can see offered to pick.',
    state: {
      ...base(),
      panel: {
        ...extensionSetupPanel('sentry', [
          { key: 'token', value: '' },
          { key: 'org', value: 'acme' },
          { key: 'projects', value: 'checkout: checkout-web' },
        ]),
        index: 1,
      },
    },
    frame: frame({
      panel: {
        setup: {
          title: 'Sentry',
          state: 'needs setup',
          problem: 'no Sentry token',
          guide: [
            'Create a **user auth token** with `org:read`, `project:read`, `event:read` and `event:write`.',
            'Paste it below, or log in with `sentry-cli login` and leave it empty.',
            'Say which Sentry project each of your projects sends to.',
          ],
          links: [
            { title: 'Create a token', url: 'https://sentry.io/settings/account/api/auth-tokens/' },
          ],
          fields: [
            {
              key: 'token',
              label: 'Auth token',
              help: 'kept in your config; $SENTRY_AUTH_TOKEN wins when set',
              placeholder: 'sntryu_…',
              kind: 'text',
              choices: [],
            },
            {
              key: 'org',
              label: 'Organization',
              help: 'its slug, as in the URL',
              placeholder: 'acme',
              kind: 'text',
              choices: ['acme', 'acme-labs'],
            },
            {
              key: 'projects',
              label: 'Projects',
              help: 'your project: its Sentry project, comma separated',
              placeholder: 'checkout: checkout-web',
              kind: 'map',
              choices: [],
            },
          ],
        },
      },
    }),
  },
  {
    name: 'choosing-a-model',
    about:
      'Clicking the orchestrator’s model: every model you are signed in to, filtered as you type, the current one marked, with what each costs in, out and read back from the cache.',
    state: { ...base(), panel: { ...modelPanel('orchestrator'), index: 1 } },
    frame: frame({
      panel: {
        models: [
          {
            id: 'openrouter/anthropic/claude-opus-5',
            provider: 'openrouter',
            name: 'Claude Opus 5',
            price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          },
          {
            id: 'openrouter/anthropic/claude-sonnet-5',
            provider: 'openrouter',
            name: 'Claude Sonnet 5',
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
          {
            id: 'openrouter/moonshotai/kimi-k2.6',
            provider: 'openrouter',
            name: 'Kimi K2.6',
            price: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
          },
          {
            id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
            provider: 'openrouter',
            name: 'Nemotron 3 Super (free)',
            price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: 'anthropic/claude-opus-5',
            provider: 'anthropic',
            name: 'Claude Opus 5',
            price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          },
        ],
        modelTarget: 'the orchestrator',
        currentModel: 'openrouter/anthropic/claude-opus-5',
      },
    }),
  },
  {
    name: 'resource-usage',
    about:
      'What Tade is using, kept in the status bar and clicked open: by project, kind, agent and process, with the last fifteen minutes.',
    state: { ...base(), panel: extensionViewPanel('resources') },
    frame: frame({
      statuses: [{ extension: 'resources', text: '91% · 783 MB', tone: 'quiet', viewable: true }],
      panel: {
        extensionView: {
          title: 'Resources',
          markdown: [
            '**Tade is using 91% CPU and 783 MB of memory**, across 7 processes.',
            '',
            '### By project',
            '',
            '```',
            '              CPU               memory',
            'checkout      ████████░░   76%  █████░░░░░  369 MB',
            'Tade itself  ██░░░░░░░░   15%  █████░░░░░  414 MB',
            '```',
            '',
            '### By kind',
            '',
            '```',
            '                      CPU               memory',
            'agents                ████████░░   76%  █████░░░░░  361 MB',
            'the orchestrator      █░░░░░░░░░   12%  ████░░░░░░  293 MB',
            'the window            ░░░░░░░░░░  2.5%  █░░░░░░░░░  117 MB',
            'terminals             ░░░░░░░░░░  0.5%  ░░░░░░░░░░    8 MB',
            'helpers (git, ps, …)  ░░░░░░░░░░  0.1%  ░░░░░░░░░░    4 MB',
            '```',
            '',
            '### By agent and terminal',
            '',
            '```',
            '                  CPU               memory',
            'refunds           ████████░░   76%  █████░░░░░  361 MB',
            'the orchestrator  █░░░░░░░░░   12%  ████░░░░░░  293 MB',
            'the window        ░░░░░░░░░░  2.5%  █░░░░░░░░░  117 MB',
            'terminal 1        ░░░░░░░░░░  0.5%  ░░░░░░░░░░    8 MB',
            'helpers           ░░░░░░░░░░  0.1%  ░░░░░░░░░░    4 MB',
            '```',
            '',
            '### Busiest processes',
            '',
            '```',
            '                              CPU               memory',
            '102 node cli.js (refunds)     ████░░░░░░   41%  ███░░░░░░░  244 MB',
            '104 node vitest (refunds)     ███░░░░░░░   30%  █░░░░░░░░░   88 MB',
            '101 node cli.js (the orchest  █░░░░░░░░░   12%  ████░░░░░░  293 MB',
            '103 zsh (refunds)             █░░░░░░░░░  5.0%  ░░░░░░░░░░   29 MB',
            '100 node bin.ts (the window)  ░░░░░░░░░░  2.5%  █░░░░░░░░░  117 MB',
            '105 zsh (terminal 1)          ░░░░░░░░░░  0.5%  ░░░░░░░░░░    8 MB',
            '106 git (helpers)             ░░░░░░░░░░  0.1%  ░░░░░░░░░░    4 MB',
            '```',
            '',
            '### The last 15 minutes',
            '',
            '```',
            'CPU     ▁▂▂▅█▇▄▃▂▅▅  81% average, 140% peak',
            'memory  ▁▂▂▃▄▅▅▆▇▇█  724 MB average, 783 MB peak',
            '```',
            '',
            'Watching costs one `ps` every few seconds: this one took 21 ms, 20 ms on average.',
          ].join('\n'),
        },
      },
    }),
  },
  {
    name: 'a-brief-on-demand',
    about:
      'The brief, asked for: one paragraph, and what extensions found offered as something to ask.',
    state: {
      ...base(),
      focused: null,
      chose: true,
      transcript: suggest(
        said(
          youSaid(emptyTranscript(), 'brief me', 0),
          'Morning. stripe-v15 is blocked on npm i stripe@15, 1 still working and Sentry has 3 new issues in checkout.',
          1,
        ),
        'Sentry has 3 new issues in checkout',
        'Look at the new Sentry issues in checkout and tell me which are worth fixing first, and why',
        2,
      ),
    },
    frame: frame({ screen: '' }),
  },
  {
    name: 'an-agent-on-a-sentry-issue',
    about:
      'An agent started on a Sentry issue: where its work came from, under GIT, one click away; its short id clickable where it is said.',
    state: toggleSection(toggleSection(base(), 'files'), 'changes'),
    frame: frame({
      where: {
        repo: '~/src/checkout',
        branch: 'tade/fix-shop-1a',
        base: 'main',
        worktree: '~/.tade/worktrees/checkout-fix-shop-1a',
        path: '/Users/me/.tade/worktrees/checkout-fix-shop-1a',
        links: [
          { title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' },
          { title: 'trace a1b2c3d4', url: 'https://acme.sentry.io/explore/traces/trace/a1b2/' },
        ],
      },
      linkers: [
        { pattern: '\\bSHOP-[0-9A-Z]{1,10}\\b', url: 'https://acme.sentry.io/issues/?query=$&' },
      ],
      screen: 'Reading .tade/context.md for SHOP-1A before touching src/refunds.ts',
    }),
  },
  {
    name: 'spend',
    about:
      'The Spend panel: the orchestrator and every agent today, and each project against its budget.',
    state: { ...base(), panel: spendPanel() },
    frame: frame({
      spendView: spendView(spent, {
        window: 'today',
        by: 'agent',
        now: NOW,
        openedAt: NOW - 3_600_000,
        projects: ['checkout', 'search', 'infra'],
        budgets: { checkout: { usd_per_day: 5 } },
        runs: ran,
      }),
    }),
  },
  {
    name: 'agent-menu',
    about: "An agent's menu, opened from its ≡: what can be done, and why not where it cannot.",
    state: {
      ...base(),
      panel: menuPanel({ kind: 'task', task: 'checkout/stripe-v15' }, 'stripe-v15', {
        row: 4,
        col: 2,
      }),
    },
    frame: frame({
      panel: {
        items: menuItems({ lane: 'checkout/stripe-v15/agent', state: 'blocked' }, 3),
      },
    }),
  },
  {
    name: 'choosing-how-hard-it-thinks',
    about:
      'The thinking button beside the model, opened: every level from off to max, the one the agent is at marked.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'thinking', task: 'checkout/stripe-v15', current: 'high' },
        'Thinking',
        {
          row: 3,
          col: 84,
        },
      ),
    },
    frame: frame({ panel: { items: thinkingMenuItems('high') } }),
  },
  {
    name: 'file-menu',
    about:
      'A file in FILES, right-clicked: open it here or in your editor, ask the agent, copy, reveal.',
    state: {
      ...base(),
      hover: { kind: 'file', path: 'src/webhooks.ts' },
      panel: menuPanel({ kind: 'file', path: 'src/webhooks.ts', folder: false }, 'webhooks.ts', {
        row: 19,
        col: 6,
      }),
    },
    frame: frame({
      panel: {
        items: fileMenuItems({
          folder: false,
          open: false,
          changed: true,
          agent: true,
          platform: 'darwin',
        }),
      },
    }),
  },
  {
    name: 'change-menu',
    about:
      'A changed file, right-clicked: its diff, the file, and discarding what is not committed.',
    state: {
      ...base(),
      panel: menuPanel(
        { kind: 'change', task: 'checkout/stripe-v15', path: 'src/webhooks.ts' },
        'webhooks.ts',
        { row: 13, col: 4 },
      ),
    },
    frame: frame({ panel: { items: changeMenuItems({ uncommitted: true, agent: true }) } }),
  },
  {
    name: 'branch-menu',
    about: "The project's branch under GIT: switch it, make a new one, pull.",
    state: {
      ...withProjects(initialState(), ['checkout']),
      panel: menuPanel({ kind: 'branch' }, 'main', { row: 18, col: 4 }),
    },
    frame: frame({
      screen: '',
      changes: [],
      where: {
        repo: '~/src/checkout',
        branch: 'main',
        base: null,
        worktree: null,
        path: '/Users/me/src/checkout',
      },
      panel: { items: branchMenuItems({ agent: false, name: 'main' }) },
    }),
  },
  {
    name: 'switching-branch',
    about: 'Switching the checkout: branches newest first, and a new one for a name nobody has.',
    state: {
      ...withProjects(initialState(), ['checkout']),
      panel: { ...branchPanel(), query: 'fix' },
    },
    frame: frame({
      screen: '',
      changes: [],
      panel: {
        checkout: 'main',
        branches: [
          { name: 'main', current: true, when: '2 hours ago' },
          { name: 'fix/refund-retries', current: false, when: '3 days ago' },
          { name: 'fix/webhook-signature', current: false, when: '2 weeks ago' },
          { name: 'spike/ledger', current: false, when: '5 weeks ago' },
        ],
      },
    }),
  },
  {
    name: 'adding-a-note',
    about: 'The + beside NOTES: a note, about this project or everything, kept word for word.',
    state: {
      ...base(),
      panel: {
        ...promptPanel('note', 'New note', 'NOTE ABOUT CHECKOUT'),
        text: 'The staging key rotates on the 1st',
      },
    },
    frame: frame(),
  },
  {
    name: 'files-marked-by-git',
    about: 'FILES coloured the way git sees them: changed, new, and the folders they are in.',
    state: toggleSection(toggleSection(base(), 'changes'), 'agents'),
    frame: frame({
      fileMarks: {
        'src/webhooks.ts': 'M',
        'src/webhooks.test.ts': 'U',
        'test/refunds.test.ts': 'M',
      },
    }),
  },
  {
    name: 'remove-agent',
    about: 'Removing a task asks first, and says exactly what would be lost.',
    state: { ...base(), panel: confirmRemovePanel('checkout/stripe-v15') },
    frame: frame({ panel: { ahead: 3, branch: 'tade/stripe-v15', base: 'main' } }),
  },
  {
    name: 'the-finished-agents-hidden',
    about:
      'The AGENTS heading with two controls beside its +, each narrower than it: an eye, shut here so the agents that have finished are out of the list, and a cleanup that closes them. The pointer is on the eye.',
    state: {
      ...toggleDone(finished()),
      hover: { kind: 'action', name: 'toggle-done' },
    },
    frame: frame(),
  },
  {
    name: 'cleaning-up-finished-agents',
    about:
      'The cleanup beside the + asks before it closes anything, and names every agent it would close.',
    state: {
      ...finished(),
      panel: closeDonePanel(['checkout/refund-emails', 'checkout/webhook-retries']),
    },
    frame: frame(),
  },
  {
    name: 'diff',
    about: 'A changed file, read-only, over the window.',
    state: {
      ...base(),
      panel: diffPanel(
        'checkout/stripe-v15',
        ['package.json', 'src/webhooks.ts', 'src/webhooks.test.ts'],
        1,
      ),
    },
    frame: frame({
      panel: {
        diff: parseDiff(
          [
            'diff --git a/src/webhooks.ts b/src/webhooks.ts',
            '--- a/src/webhooks.ts',
            '+++ b/src/webhooks.ts',
            '@@ -38,5 +38,7 @@ export async function handle(req, res) {',
            "   const sig = req.headers['stripe-signature']",
            '-  const event = stripe.webhooks.constructEvent(body, sig, key)',
            '+  const event = await stripe.webhooks.constructEventAsync(',
            '+    body, sig, key, undefined, cryptoProvider,',
            '+  )',
            "   if (event.type === 'charge.refunded') {",
            '     await refund(event)',
          ].join('\n'),
        ),
      },
    }),
  },
  {
    name: 'settings',
    about: 'Settings over the window: categories down the side, real controls on the right.',
    state: { ...base(), panel: { ...settingsPanel('voice'), row: 0 } },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'settings-list-open',
    about:
      'A setting whose choices need explaining opens as a list, grouped, with what each needs.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        row: 2,
        dropdown: { path: 'surfaces.voice.stt.driver', query: '', index: 0 },
      },
    },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'choosing-the-talk-key',
    about: 'Pressing a key to talk with, and being told what it would take away.',
    state: {
      ...base(),
      panel: {
        ...settingsPanel('voice'),
        capture: { path: 'surfaces.voice.talk.key', key: 'ctrl+r' },
      },
    },
    frame: frame({ panel: settingsFacts() }),
  },
  {
    name: 'open-project',
    about:
      'Opening a project: a folder browser from home, recent projects beside it, git offered where there is none.',
    state: {
      ...base(),
      panel: {
        ...openProjectPanel('/Users/me/src'),
        back: ['/Users/me'],
        index: 2,
      },
    },
    frame: frame({
      panel: {
        browsing: '/Users/me/src',
        homeDir: '/Users/me',
        openRows: [
          {
            row: { kind: 'here', name: 'src', path: '/Users/me/src', git: false },
            branch: null,
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'payments', path: '/Users/me/src/payments', git: true },
            branch: 'main',
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'payroll', path: '/Users/me/src/payroll', git: false },
            branch: null,
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'folder', name: 'search', path: '/Users/me/src/search', git: true },
            branch: 'main',
            tasks: 0,
            when: null,
          },
          {
            row: { kind: 'recent', name: 'checkout', path: '/Users/me/src/checkout', git: true },
            branch: 'main',
            tasks: 3,
            when: '2h ago',
          },
          {
            row: { kind: 'recent', name: 'tade', path: '/Users/me/tade', git: true },
            branch: 'main',
            tasks: 0,
            when: '4 days ago',
          },
        ],
      },
    }),
  },
  {
    name: 'searching',
    about:
      'ctrl+k: agents, files in every worktree and lines inside them, grouped, with what matched lit.',
    state: { ...base(), panel: { ...searchPanel('webhook'), index: 1 } },
    frame: frame({ panel: { entries: searched('webhook'), searching: false } }),
  },
  {
    name: 'searching-to-a-line',
    about: 'A file and a line: tab completes the name, enter opens it there.',
    state: { ...base(), panel: searchPanel('hooks.ts:42') },
    frame: frame({ panel: { entries: searched('hooks.ts:42'), searching: false } }),
  },
  {
    name: 'reading-a-file',
    about: 'A file opened from FILES or search: coloured, numbered, at the line asked for.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/src/webhooks.ts', 9),
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'finding-in-a-file',
    about: 'ctrl+f in a file: every match lit, the one you are on amber, its line marked.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts'),
        asking: { kind: 'find', query: 'event', index: 1 },
        line: 9,
      },
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'editing-a-file',
    about: 'Clicked into and typed in: the block where typing lands, and a Save that says so.',
    state: {
      ...base(),
      panel: {
        ...filePanel('/Users/me/src/checkout/src/webhooks.ts'),
        edit: typeIn(editFrom(textLines(webhooksFile), 5, 47), '_V2'),
      },
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(webhooksFile) } }),
  },
  {
    name: 'reading-markdown',
    about: 'Markdown laid out as it reads, with its source a tab away.',
    state: {
      ...base(),
      panel: filePanel('/Users/me/src/checkout/README.md', null, true),
    },
    frame: frame({ panel: { homeDir: '/Users/me', viewing: viewing(readmeFile, 112) } }),
  },
  {
    name: 'keys',
    about: 'The keys Tade keeps, talking first.',
    state: { ...base(), panel: { kind: 'keys', busy: false } },
    frame: frame({ panel: { talkKey: 'ctrl+space', talkMode: 'hold', releases: true } }),
  },
  {
    name: 'closing',
    about: 'Closing asks only when it would stop agents, and says what happens to them.',
    state: { ...base(), panel: { kind: 'quit', field: 'cancel', busy: false } },
    frame: frame({ panel: { running: 2 } }),
  },
  {
    name: 'another-project-needs-you',
    about:
      'An agent in a project you are not looking at wants approval: a toast, answerable where it is.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), [
          ...tasks.slice(1, 2),
          {
            task: 'search/pagination',
            state: 'blocked',
            lane: 'search/pagination/agent',
            waiting: true,
            approval: { tool: 'bash', summary: 'rm -rf node_modules && npm ci' },
          },
        ]),
        'checkout/refunds',
      ),
      toasts: [{ task: 'search/pagination', at: NOW - 12_000 }],
    },
    frame: frame(),
  },
  {
    name: 'voice-off',
    about: 'No microphone or speech engine: the chip says so, and offers setup.',
    state: base(),
    frame: frame({ voice: { keys: ['ctrl', 'space'], available: false } }),
  },
  {
    name: 'first-open',
    about:
      'A project and nothing running yet: its repository and files, and what to do next, as buttons.',
    state: withProjects(initialState(), ['checkout']),
    frame: frame({
      screen: '',
      changes: [],
      notes: [],
      base: null,
      where: {
        repo: '~/src/checkout',
        branch: 'main',
        base: null,
        worktree: null,
        path: '/Users/me/src/checkout',
      },
      files: [
        { path: 'src', name: 'src', depth: 0, folder: true, open: false },
        { path: 'test', name: 'test', depth: 0, folder: true, open: false },
        { path: 'package.json', name: 'package.json', depth: 0, folder: false, open: false },
        { path: 'README.md', name: 'README.md', depth: 0, folder: false, open: false },
      ],
      spend: { tokens: 0, usd: 0, hasCost: false, byTask: {} },
    }),
  },
  {
    name: 'pointing-at-a-link',
    about:
      'Links and file references on an agent screen are clickable, and underline under the pointer.',
    state: {
      ...base(),
      hover: { kind: 'link', url: 'https://docs.stripe.com/webhooks/signatures' },
    },
    frame: frame({
      screen: `${agentScreen}\n\n  See https://docs.stripe.com/webhooks/signatures — the failure is in src/webhooks.ts:42:7`,
    }),
  },
  {
    name: 'small-terminal',
    about: 'An 80×24 terminal: everything still fits, and nothing wraps.',
    state: base(),
    frame: frame({ width: 80, height: 24 }),
  },
]
