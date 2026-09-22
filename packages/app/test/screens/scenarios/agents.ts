import { IDLE_REASON } from '@tade/core'
import type { ActionsView } from '../../../src/frame.ts'
import {
  type AppState,
  focusTask,
  initialState,
  splitPane,
  toggleCheck,
  toggleDone,
  viewActions,
  withProjects,
  withTasks,
} from '../../../src/model.ts'
import { actions, base, check, finished, frame, green, running, type Scenario } from './fixtures.ts'

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

/** The page with one check open on what it printed, scrolled to where it is. */
function openCheck(state: AppState, task: string, check: string, scroll = 0): AppState {
  return { ...toggleCheck(state, task, check), actionsScroll: scroll }
}

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
      'A project with CI and no manifest of its own. What CI runs is read and shown, and none of it runs here: the row says so, and `Adopt from CI` is the one act that changes it — it writes .tade/checks.yaml, and only then are these checks Tade\u2019s to run.',
    state: viewActions(base(), 'checkout/stripe-v15'),
    frame: frame({
      actions: {
        ...nothingYet(),
        checks: [
          check('format', { run: 'biome ci .' }),
          check('tests', { run: 'pnpm vitest run' }),
          check('publish', {
            run: 'npm publish --provenance',
            skip: 'needs CI: it uses something only the runner knows',
          }),
        ],
        source: 'read from .github/workflows/ci.yml · not adopted',
        adoptable: true,
      },
    }),
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
