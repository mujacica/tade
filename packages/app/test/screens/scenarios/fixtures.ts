import { IDLE_REASON, noRuntime, type TadeEvent } from '@tade/core'
import type { ActionsView, CheckView, CommitView, Frame } from '../../../src/frame.ts'
import {
  type AppState,
  focusTask,
  initialState,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../../../src/model.ts'
import { type QueueView, WHOLE_QUEUE } from '../../../src/queue-view.ts'
import { COLOUR } from '../../../src/skin.ts'

// The world every screen is drawn against: one project, three agents, a
// morning's work behind them.
//
// Fixed data, so a screen is the same on every machine — no clock, no git, no
// terminal — and shared, so a change to what the window is handed lands in one
// place rather than in ninety-nine. What only one kind of screen needs lives
// in that screen's own file.

export interface Scenario {
  name: string
  /** What it shows, for the gallery. */
  about: string
  state: AppState
  frame: Frame
}

export const NOW = Date.parse('2026-09-13T14:00:04Z')

export const tasks: TaskSnapshot[] = [
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

export const agentScreen = [
  '',
  '  ● Upgrading stripe to v15. The webhook signature API changed,',
  '    so src/webhooks.ts needs the new constructEvent signature.',
  '',
  '  ▸ Read src/webhooks.ts',
  '  ▸ Edit src/webhooks.ts  +12 −4',
  '  ▸ bash npm i stripe@15',
].join('\n')

export const base = (): AppState =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search', 'infra']), tasks),
    'checkout/stripe-v15',
  )

/** The same window with two agents in it that have finished: what cleanup is for. */
export const finished = (): AppState =>
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

/**
 * A project's SMART QUEUE showing what its controls were left showing: the
 * scope, the `timed` switch, or both. Spread into a scenario's state, since the
 * choice is that project's.
 */
export const showing = (project: string, view: Partial<QueueView>): Partial<AppState> => ({
  queueViews: { [project]: { ...WHOLE_QUEUE, ...view } },
})

/** Times said in UTC, so the screens do not change with the machine's time zone. */
export const utcClock = (at: number) => new Date(at).toISOString().slice(11, 16)

/** Dates said in UTC, the way the window says them. */
export const utcDate = (at: number) => {
  const time = new Date(at)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getUTCDay()] ?? ''
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${day} ${time.getUTCDate()} ${month[time.getUTCMonth()] ?? ''} ${utcClock(at)}`
}

/**
 * A window drawn in UTC, because a golden read off the machine's clock is a
 * golden that only holds where it was written: `last asked 10:12` here and
 * `08:12` on a runner, with nothing in the diff to say that is what happened.
 * Said here rather than in each scenario, because a rule every one of them
 * has to remember is a rule one of them forgot.
 */
export const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 34,
  screen: agentScreen,
  skin: COLOUR,
  now: NOW,
  home: '~/.tade',
  orchestratorModel: 'openrouter/anthropic/claude-opus-5',
  orchestratorThinking: 'high',
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
  // A headline over the words, where whoever took the note wrote one — and the
  // oldest with none, drawn in its own words the way every note used to be.
  notes: [
    {
      text: 'the staging key rotates on the 1st',
      at: '2026-09-01T09:00:00.000Z',
      scope: 'checkout',
      by: 'window',
    },
    {
      text: 'we pin major versions',
      summary: 'Pin dependencies',
      at: '2026-09-02T09:00:00.000Z',
      scope: 'checkout',
      by: 'voice',
    },
    {
      text: 'refunds go through the ledger service, never the gateway',
      summary: 'Refunds via the ledger',
      at: '2026-09-03T09:00:00.000Z',
      scope: 'checkout/refunds',
      by: 'orchestrator',
    },
    {
      text: 'never force-push to main',
      summary: 'Main is never force-pushed',
      at: '2026-09-04T09:00:00.000Z',
      scope: null,
      by: 'voice',
    },
  ],
  base: 'main',
  spend: {
    tokens: 1_900_000,
    // The same morning the Spend panel draws, so the strip and the panel can
    // never say two different things about it: the Claude Code agent's turns
    // are its plan's and are no money, which is why 1.9M tokens cost $1.40.
    usd: 1.4,
    hasCost: true,
    byTask: {
      'checkout/stripe-v15': { tokens: 880_000, usd: 0 },
      'checkout/refunds': { tokens: 460_000, usd: 0.62 },
      'search/pagination': { tokens: 148_000, usd: 0.2 },
    },
    // Two agents still at it, so the morning's agent time is longer than the
    // morning: what `ran` below adds up to.
    runtime: { ...noRuntime(), ms: 7_500_000, runs: 3, running: true, workingMs: 3_100_000 },
  },
  route: {
    harness: 'pi',
    model: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    credential: 'signed in',
  },
  vitals: { model: 'anthropic/claude-opus-5', thinking: 'high', contextPercent: 41 },
  voice: { keys: ['ctrl', 'space'], available: true },
  clock: utcClock,
  date: utcDate,
  ...over,
})

let seq = 0

export const usage = (
  task: string | null,
  model: string,
  tokens: number,
  usd: number,
  on: { harness: string; provider?: string; priced: 'exact' | 'estimate' },
): TadeEvent => ({
  seq: ++seq,
  ts: '2026-09-13T13:00:00.000Z',
  type: 'usage',
  urgency: 'routine',
  task,
  lane: null,
  // An agent's spend belongs to its run, which is how the hours and the
  // dollars of one agent land on one row. The orchestrator has no run of its
  // own — it lives as long as the window — so it has none here either.
  run: task ? `${task}/agent` : null,
  detail: {
    model,
    tokens,
    usd,
    // Which harness, through which provider, and whether that dollar was
    // priced or guessed — a real morning has both, and the page may never add
    // the two without saying which it did.
    ...on,
    ...(task ? {} : { by: 'orchestrator' }),
  },
})

const runEvent = (
  type: 'run_started' | 'run_exited' | 'turn_started' | 'turn_done',
  task: string,
  ts: string,
  on: { harness: string; provider?: string } = { harness: 'pi', provider: 'anthropic' },
): TadeEvent => ({
  seq: ++seq,
  ts,
  type,
  urgency: 'notable',
  task,
  lane: `${task}/agent`,
  run: `${task}/agent`,
  // What the route asked for, which is not always what the harness answers —
  // Claude Code is told `anthropic/claude-opus-5` and reports `claude-opus-5`.
  // The hours follow the answer, so an agent is one row and not two.
  detail:
    type === 'run_started' ? { model: 'anthropic/claude-opus-5', adapter: on.harness, ...on } : {},
})

const commitSeen = (
  task: string | null,
  added: number,
  removed: number,
  files: number,
): TadeEvent => ({
  seq: ++seq,
  ts: '2026-09-13T13:30:00.000Z',
  type: 'commit_seen',
  urgency: 'routine',
  task,
  lane: null,
  run: null,
  detail: {
    sha: `c${String(seq).padStart(7, '0')}`,
    project: (task ?? 'checkout/x').split('/')[0],
    attributed: task !== null,
    added,
    removed,
    files,
  },
})

const checkRan = (check: string, state: string, ms: number): TadeEvent => ({
  seq: ++seq,
  ts: '2026-09-13T13:31:00.000Z',
  type: 'check_ran',
  urgency: 'routine',
  task: 'checkout/stripe-v15',
  lane: null,
  run: null,
  detail: { run: `r${seq}`, check, state, required: true, where: 'here', runner: 'local', ms },
})

/**
 * What the same morning produced: what the money bought. One commit belongs to
 * nobody, which is what a person committing by hand in the shared checkout
 * looks like, and is always an allowed answer.
 */
export const made = [
  commitSeen('checkout/stripe-v15', 214, 38, 9),
  commitSeen('checkout/refunds', 96, 12, 4),
  commitSeen('search/pagination', 41, 7, 2),
  commitSeen(null, 6, 1, 1),
  checkRan('types', 'passed', 21_400),
  checkRan('types', 'passed', 19_900),
  checkRan('tests', 'failed', 46_200),
  checkRan('tests', 'passed', 44_800),
  checkRan('format', 'passed', 1_900),
]

/** The same morning's runs: two agents still going, one that finished. */
/**
 * A morning of runs, and the turns inside them.
 *
 * Both halves, because the page draws both: how long each agent was open, and
 * how much of that a model spent working. An agent is open from the moment it
 * is started until it stops, so the gaps between these turns are an agent
 * sitting in its lane with an answer nobody has read yet — which is the whole
 * of why the two figures differ and the reason there are two columns.
 *
 * Refunds is mid-turn, so its working time is still counting up.
 */
const turns = (task: string, spans: readonly [string, string | null][], harness = 'pi') =>
  spans.flatMap(([from, to]) => [
    runEvent('turn_started', task, `2026-09-13T${from}.000Z`, { harness }),
    ...(to ? [runEvent('turn_done', task, `2026-09-13T${to}.000Z`, { harness })] : []),
  ])

export const ran = [
  runEvent('run_started', 'checkout/stripe-v15', '2026-09-13T13:05:00.000Z', {
    harness: 'claude-code',
  }),
  runEvent('run_started', 'search/pagination', '2026-09-13T13:02:00.000Z'),
  runEvent('run_started', 'checkout/refunds', '2026-09-13T13:20:00.000Z'),
  ...turns(
    'checkout/stripe-v15',
    [
      ['13:06:00', '13:21:00'],
      ['13:28:00', '13:54:00'],
    ],
    'claude-code',
  ),
  ...turns('search/pagination', [
    ['13:03:00', '13:11:00'],
    ['13:19:00', '13:29:00'],
  ]),
  ...turns('checkout/refunds', [
    ['13:22:00', '13:47:00'],
    ['13:52:00', null],
  ]),
  runEvent('run_exited', 'search/pagination', '2026-09-13T13:32:00.000Z'),
]

export const checkout = { path: '/Users/me/src/checkout', label: 'checkout', task: null }

/** The commit the checks on the ACTIONS tab are about. */
const AT_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** One check, as the page draws it: nothing has run unless the scenario says so. */
export function check(id: string, over: Partial<CheckView> = {}): CheckView {
  return {
    id,
    title: id,
    run: null,
    state: 'not run',
    required: true,
    skip: null,
    needs: [],
    summary: null,
    seconds: null,
    startedAt: null,
    at: null,
    commit: null,
    carried: false,
    counts: [],
    places: [],
    more: 0,
    tail: [],
    ...over,
  }
}

const OWN = (over: Partial<CommitView>): CommitView => ({
  sha: AT_COMMIT,
  subject: 'move to the stripe v15 payment intents API',
  at: NOW - 12 * 60_000,
  task: 'checkout/stripe-v15',
  files: 6,
  added: 148,
  removed: 62,
  ...over,
})

/** What a suite prints when four tests fail: the last of it, as the page keeps it. */
const FAILING_TAIL = [
  ' ❯ packages/app/test/screens.test.ts:37:5',
  '      35|   it(‘looks the way it did’, async () => {',
  '      36|     const plain = drawn.rows.map((row) => stripTerminalSequences(row))',
  '      37|     await expect(plain.join()).toMatchFileSnapshot(nameOf(scenario))',
  '        |     ^',
  '  Snapshots  4 failed',
  ' Test Files  1 failed | 131 passed | 1 skipped (133)',
  '      Tests  4 failed | 2072 passed | 3 skipped (2079)',
]

/**
 * The page as an agent in the middle of a review sees it: its own commits,
 * somebody else's beside them, work not committed in a checkout it shares,
 * and a suite that is red.
 */
export function actions(): ActionsView {
  return {
    task: 'checkout/stripe-v15',
    branch: 'tade/stripe-v15',
    base: 'main',
    ahead: 3,
    behind: 0,
    dirty: 3,
    shared: true,
    commit: AT_COMMIT,
    mine: [
      OWN({}),
      OWN({
        sha: '9f0e1d2c3b4a59687778695a4b3c2d1e0f000000',
        subject: 'keep the old webhook shape working for a release',
        at: NOW - 60 * 60_000,
        files: 2,
        added: 24,
        removed: 4,
      }),
    ],
    others: [
      OWN({
        sha: '77c4ab0998877665544332211aabbccddeeff001',
        subject: 'a test for the refund path',
        at: NOW - 2 * 3_600_000,
        task: 'checkout/refunds',
        files: 1,
        added: 31,
        removed: 0,
      }),
      OWN({
        sha: '5510ee7332211445566778899aabbccddeeff002',
        subject: 'bump the sdk',
        at: NOW - 5 * 3_600_000,
        task: null,
        files: 2,
        added: 8,
        removed: 8,
      }),
    ],
    review: null,
    checks: [
      check('format', {
        run: 'pnpm exec biome ci .',
        state: 'passed',
        seconds: 2.1,
        at: NOW - 13 * 60_000,
        commit: AT_COMMIT,
        counts: [
          { label: 'files checked', count: 493, tone: 'quiet' },
          { label: 'errors', count: 0, tone: 'bad' },
        ],
      }),
      check('types', {
        run: 'pnpm exec tsc --noEmit',
        state: 'passed',
        seconds: 6.4,
        at: NOW - 13 * 60_000,
        commit: AT_COMMIT,
      }),
      check('tests', {
        run: 'pnpm vitest run',
        state: 'failed',
        seconds: 64,
        at: NOW - 12 * 60_000,
        commit: AT_COMMIT,
        needs: ['types'],
        summary: '4 failed | 2072 passed | 3 skipped (2079)',
        counts: [
          { label: 'failed', count: 4, tone: 'bad' },
          { label: 'passed', count: 2072, tone: 'good' },
          { label: 'skipped', count: 3, tone: 'quiet' },
        ],
        places: [
          {
            path: 'packages/app/test/screens.test.ts',
            at: '37:5',
            note: 'what-an-agent-has-done',
          },
          { path: 'src/webhooks.test.ts', at: '18:3', note: 'keeps the old shape' },
        ],
        more: 2,
        tail: FAILING_TAIL,
      }),
    ],
    rollup: 'fail',
    source: 'from .tade/checks.yaml',
    adoptable: false,
    running: null,
    notes: ['on this machine, not CI’s matrix'],
  }
}

/** The same agent an hour later: everything committed, everything green. */
export function green(): ActionsView {
  const was = actions()
  return {
    ...was,
    dirty: 0,
    mine: [
      ...was.mine,
      OWN({
        sha: '3ab77c1009988776655443322110ffeeddcc003',
        subject: 'name the webhook ids the way the docs do',
        at: NOW - 3 * 60_000,
        files: 3,
        added: 31,
        removed: 9,
      }),
    ],
    checks: [
      check('format', {
        run: 'pnpm exec biome ci .',
        state: 'passed',
        seconds: 2.4,
        at: NOW - 4 * 60_000,
        commit: AT_COMMIT,
        counts: [{ label: 'files checked', count: 493, tone: 'quiet' }],
      }),
      check('types', {
        run: 'pnpm exec tsc --noEmit',
        state: 'passed',
        seconds: 6.1,
        at: NOW - 4 * 60_000,
        commit: '9f0e1d2c3b4a59687778695a4b3c2d1e0f000000',
        carried: true,
      }),
      check('tests', {
        run: 'pnpm vitest run',
        state: 'passed',
        seconds: 148,
        at: NOW - 2 * 60_000,
        commit: AT_COMMIT,
        needs: ['types'],
        counts: [
          { label: 'passed', count: 2559, tone: 'good' },
          { label: 'skipped', count: 3, tone: 'quiet' },
        ],
      }),
    ],
    rollup: 'pass',
  }
}

/** A run going on now, whoever started it. */
export function running(): ActionsView {
  const was = green()
  return {
    ...was,
    rollup: 'unknown',
    checks: [
      { ...(was.checks[0] as CheckView), seconds: 2.2, at: NOW - 80_000 },
      {
        ...(was.checks[2] as CheckView),
        state: 'running',
        seconds: null,
        at: null,
        startedAt: NOW - 62_000,
        counts: [],
      },
      check('types', { run: 'pnpm exec tsc --noEmit', state: 'queued', needs: ['tests'] }),
    ],
    running: { since: NOW - 84_000, by: 'checkout/stripe-v15', done: 1, total: 3 },
  }
}
