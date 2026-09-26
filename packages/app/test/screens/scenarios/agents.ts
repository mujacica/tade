import { IDLE_REASON } from '@tade/core'
import type { ActionsView } from '../../../src/frame.ts'
import {
  type AppState,
  focusTask,
  initialState,
  toggleCheck,
  toggleDone,
  toggleSection,
  viewActions,
  withProjects,
  withTasks,
} from '../../../src/model.ts'
import { splitPane } from '../../../src/split.ts'
import { NOT_HERE } from '../../../src/view/actions.ts'
import {
  actions,
  base,
  check,
  finished,
  frame,
  green,
  NOW,
  running,
  type Scenario,
} from './fixtures.ts'

// An agent, its screen, and what it has actually done.
//
// The ACTIONS page is most of this: the commits carrying its own trailer, what
// it changed, the review it is out for, and how the project's checks stand —
// green, red, running, read from CI, and never run at all.

/** An agent that has done nothing yet: the page says so, rather than looking green. */
function nothingYet(): ActionsView {
  return {
    ...actions(),
    branch: null,
    ahead: 0,
    dirty: 0,
    commit: null,
    mine: [],
    others: [],
    checks: [
      check('format', { run: 'pnpm exec biome ci .' }),
      check('types', { run: 'pnpm exec tsc --noEmit' }),
      check('tests', { run: 'pnpm vitest run', needs: ['types'] }),
    ],
    rollup: 'unknown',
    running: null,
  }
}

/**
 * A project whose CI is mostly things this machine is not: two steps that run
 * here, three that do not, and two the reading could not place as checks at all.
 *
 * What runs here is the whole of the top of the page; the rest is one fold with
 * a count on it, and the reason for each row is inside it rather than printed at
 * anybody. One of them is a person's own answer rather than the reading's.
 */
function ciCannotRunHere(): ActionsView {
  return {
    ...green(),
    checks: [
      check('format', {
        run: 'pnpm exec biome ci .',
        state: 'passed',
        seconds: 2.4,
        at: NOW - 6 * 60_000,
        counts: [{ label: 'files checked', count: 493, tone: 'quiet' }],
      }),
      check('types', {
        run: 'pnpm exec tsc --noEmit',
        state: 'passed',
        seconds: 31,
        at: NOW - 60_000,
      }),
      check('integration', {
        run: 'pnpm vitest run test/integration',
        skip: 'its job needs service containers, which only CI has',
        required: false,
      }),
      check('e2e', {
        run: 'pnpm playwright test',
        skip: 'it uses something only the runner knows',
        required: false,
      }),
      check('coverage', {
        run: 'pnpm coverage',
        skip: 'you turned it off here',
        chosen: false,
        required: false,
      }),
    ],
    unread: [
      'release › publish is the action actions/setup-node@v4, which only the runner can run',
      'release › npm publish ships something rather than checking it',
    ],
    source: 'read from .github/workflows/ci.yml',
  }
}

/** The page with one check open on what it printed, scrolled to where it is. */
function openCheck(state: AppState, task: string, check: string, scroll = 0): AppState {
  return { ...toggleCheck(state, task, check), actionsScroll: scroll }
}

/**
 * A program that draws its own conversation on the alternate screen: every
 * row of it repainted in place, the scrollback its own and nobody else's.
 * What the window has of it is exactly this, and never a line more.
 */
const alternateScreen = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ ✻ Refund emails                                              │',
  '╰──────────────────────────────────────────────────────────────╯',
  '',
  '> the ledger is the only place a refund is final',
  '',
  '● I read src/refunds.ts and src/ledger.ts. The gateway call is',
  '  fire-and-forget, so a refund that fails there is still marked',
  '  refunded in our own table.',
  '  ⎿ Read src/refunds.ts (212 lines)',
  '  ⎿ Read src/ledger.ts (96 lines)',
  '',
  '● Moving the write behind the ledger’s acknowledgement.',
  '  ⎿ Edit src/refunds.ts  +18 −6',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ >                                                            │',
  '╰──────────────────────────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

export const AGENT_SCREENS: Scenario[] = [
  {
    name: 'what-an-agent-has-done',
    about:
      'The ACTIONS tab beside an agent’s screen: the commits that carry its own task’s trailer, kept apart from everybody else’s, with what each touched; what is changed and not committed, and whose that is; the review it is out for; and how the project’s own checks stand at the commit in hand — what each ran, how long it took, and what it counted. The tests are red, and the failing file is on the page. The REVIEWS section down the side is every review that is open, from the same poll.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({
      actions: {
        ...actions(),
        review: {
          number: '#418',
          title: 'stripe v15',
          url: 'https://github.com/acme/checkout/pull/418',
          marks: [
            { text: 'draft', tone: 'quiet' },
            { text: '✗ checks', tone: 'bad' },
          ],
        },
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
    name: 'a-check-that-failed-opened',
    about:
      'The failing check opened where it is: what it ran, what it counted, the files it named, and the last of what it printed — read on the page rather than in the conversation, which is where you were going next anyway. The whole log is still one button away.',
    state: openCheck(viewActions(base(), 'checkout/stripe-v15'), 'checkout/stripe-v15', 'tests', 7),
    frame: frame({ actions: actions() }),
  },
  {
    name: 'an-agent-that-is-green',
    about:
      'The same page with everything green: three commits of its own, nothing outstanding, and every check passed — one of them carried over from the commit before, because the bytes it read are the bytes this commit holds. `unknown` never becomes green by silence, so a page that says green is a page where somebody ran them.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({ actions: green() }),
  },
  {
    name: 'checks-running-now',
    about:
      'A run watched as it goes: which check is running, how long it has been going, how many are done — written down by whoever started it, so an agent’s own run is watched the same way the button’s is.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({ actions: running() }),
  },
  {
    name: 'an-agent-with-nothing-yet',
    about:
      'An agent that has not committed anything yet: no commits of its own, nothing changed, and checks nobody has run — said as unknown, which is not the same as fine.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({ actions: nothingYet() }),
  },
  {
    name: 'checks-read-from-ci',
    about:
      'What this project checks is read out of the workflow that runs on every change — nothing of Tade\u2019s is in the repository, and nothing had to be adopted. Two of the three run here and are the page; the third is a step CI runs and this machine cannot, which keeps its place behind the fold rather than a sentence on it, and is out of what a local run adds up to because a rollup is what ran here.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({
      actions: {
        ...nothingYet(),
        checks: [
          check('format', { run: 'biome ci .' }),
          check('tests', { run: 'pnpm vitest run' }),
          check('integration', {
            run: 'pnpm vitest run test/integration',
            skip: 'cannot run here: its job needs service containers, which only CI has',
            required: false,
          }),
        ],
        source: 'read from .github/workflows/ci.yml',
      },
    }),
  },
  {
    name: 'checks-ci-cannot-run-here',
    about:
      'A project whose CI is mostly things this machine is not. What Tade runs here is the page; everything else is one fold, opened here, where each row says in a few words why it is not run — a job that needs service containers, a step that interpolates a secret, and one somebody turned off, which is the other reason and is a person’s. `run here` on any of them moves it across, and what it writes is one key in Tade’s own config under the project: nothing is ever put in the repository. The last two rows are steps the reading could not call checks at all, named because Tade checking less than CI does is only safe while it says so.',
    state: toggleSection(viewActions(base(), 'checkout/stripe-v15'), NOT_HERE, true),
    frame: frame({ actions: ciCannotRunHere() }),
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
    name: 'a-shell-beside-the-agent',
    about:
      'An agent and its shell side by side: a divider to drag, and on the shell’s half its name, swap, turn and close.',
    state: {
      ...splitPane(base(), 'checkout/stripe-v15', 'checkout/stripe-v15/shell', 'beside'),
      keyboard: 'pane',
    },
    // Both halves as a lane that size would really hold. A lane is resized to
    // the pane it is drawn in (`fitLane`), so a shell beside an agent has
    // about forty columns and has wrapped its own output to them — canning
    // the wide screen here would draw a window whose text runs off the edge,
    // which is a picture of a bug Tade does not have.
    frame: frame({
      screen: [
        '',
        '  ● Upgrading stripe to v15: the webhook',
        '    signature API changed.',
        '',
        '  ▸ Read src/webhooks.ts',
        '  ▸ Edit src/webhooks.ts  +12 −4',
        '  ▸ bash npm i stripe@15',
      ].join('\n'),
      splitScreen: [
        'checkout $ git diff --stat',
        ' src/webhooks.ts | 16 ++++++-----',
        ' 1 file changed, 12 insertions(+),',
        ' 4 deletions(-)',
        'checkout $ ',
      ].join('\n'),
    }),
  },
  {
    name: 'an-agent-not-running',
    about: 'An agent that is not running: one button opens it again.',
    state: focusTask(base(), 'search/pagination'),
    frame: frame({ screen: '', changes: [] }),
  },
  {
    name: 'a-pane-that-scrolls-itself',
    about:
      'An agent whose program took the whole screen and answers the wheel itself: the column down its right is a dashed rule rather than a bar, because the window cannot say how much there is, how much is in view, or where in it you are — and a thumb drawn from numbers nobody has is the one thing worse than no thumb. It is not a handle either: nothing lights on it and nothing can be dragged.',
    state: focusTask(base(), 'checkout/refunds'),
    // What such a lane really reports: its screen is all there is — nothing
    // scrolled off was kept — so `lines` is the rows it was drawn in, and the
    // driver says the scrolling is the lane's. Kinder numbers here (a deep
    // scrollback the program does not have) would draw a bar that works in a
    // picture and never on a machine.
    frame: frame({
      screen: alternateScreen,
      paneScreen: { lines: 19, cursor: { back: 0, column: 2 }, scrolling: 'lane' },
      route: { harness: 'claude', model: 'claude-opus-5', provider: 'anthropic' },
      vitals: { model: 'claude-opus-5', thinking: 'high', contextPercent: 41 },
    }),
  },
  {
    name: 'the-finished-agents-hidden',
    about:
      'The AGENTS heading with two letters beside its +, each narrower than it: H, filled in here because the agents that have finished are hidden, and X, which closes them. The pointer is on the H.',
    state: {
      ...toggleDone(finished()),
      hover: { kind: 'action', name: 'toggle-done' },
    },
    frame: frame(),
  },
]
