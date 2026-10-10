import {
  focusTask,
  initialState,
  type ScheduleView,
  showPlan,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../../../src/model.ts'
import { base, frame, type Scenario, showing, utcClock } from './fixtures.ts'

// Work that has not started: the SMART QUEUE, the SCHEDULES under it, and the
// plans behind both.
//
// Every way queued work can be waiting — held, ready, after another, at a
// time, paused — and the chains that put it in columns, including the ones
// too deep for the side and too wide for the pane. Then the two sections
// against each other: work and no clockwork, clockwork and no work, both, and
// neither.

/** A plan under way: two agents working, the rest queued in every way queued work can be. */
export const queueTasks: TaskSnapshot[] = [
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

/**
 * A chain too long to draw as columns, with a branch half way down it: what
 * the reasons have to carry on their own, and the shape a flat list of waits
 * hides.
 */
const longChainTasks: TaskSnapshot[] = [
  { task: 'checkout/ledger-schema', state: 'working', lane: 'checkout/ledger-schema/agent' },
  {
    task: 'checkout/ledger-api',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/ledger-schema'] },
      after: [{ task: 'checkout/ledger-schema', why: 'the endpoints follow the tables' }],
      prompt: 'Put the ledger behind an endpoint.',
      touches: ['src/api/ledger.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/refund-flow',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/ledger-api'] },
      after: [
        {
          task: 'checkout/ledger-api',
          why: 'a refund is a ledger entry, and it posts it through the endpoint the api adds',
        },
      ],
      prompt: 'Refund through the ledger.',
      touches: ['src/refunds.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/admin-view',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/refund-flow'] },
      after: [{ task: 'checkout/refund-flow', why: 'it lists what the flow wrote' }],
      prompt: 'Show refunds in the admin.',
      touches: ['src/admin/refunds.tsx'],
      at: null,
    },
  },
  {
    task: 'checkout/refund-emails',
    state: 'queued',
    by: 'orchestrator',
    done: 'said',
    queued: {
      state: { kind: 'waiting', on: ['checkout/refund-flow'] },
      after: [{ task: 'checkout/refund-flow', why: 'it emails what refund() returns' }],
      prompt: 'Email the customer when a refund goes through: say how much came back, and when.',
      touches: ['src/mail/refund.ts'],
      at: null,
    },
  },
  {
    task: 'checkout/release-guide',
    state: 'queued',
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting', on: ['checkout/refund-emails'] },
      after: [{ task: 'checkout/refund-emails', why: 'the guide screenshots the email it sends' }],
      prompt: 'Write refunds up for the guide.',
      touches: ['docs/refunds.md'],
      at: null,
    },
  },
]

/**
 * Six deep, each waiting on the one before it, with names nobody would want
 * cut in half: what the side has to draw when the indent alone is wider than
 * a narrow sidebar.
 */
const deepChainTasks: TaskSnapshot[] = [
  { task: 'keys/layout-json', state: 'working', lane: 'keys/layout-json/agent' },
  ...[
    ['keycaps-and-row-marks', 'layout-json', 'the caps are drawn from the layout it writes'],
    ['stagger-and-spacing', 'keycaps-and-row-marks', 'a row is spaced against the caps in it'],
    ['legends-and-fonts', 'stagger-and-spacing', 'a legend is placed once the cap has a size'],
    ['switch-preview', 'legends-and-fonts', 'the preview draws the legend over the switch'],
    ['export-to-svg', 'switch-preview', 'the file is what the preview shows, written out'],
  ].map(([task, after, why]) => ({
    task: `keys/${task}`,
    state: 'queued' as const,
    by: 'orchestrator',
    queued: {
      state: { kind: 'waiting' as const, on: [`keys/${after}`] },
      after: [{ task: `keys/${after}`, why: why ?? '' }],
      prompt: `Do ${task}.`,
      touches: [`src/${task}.ts`],
      at: null,
    },
  })),
]

/** Schedules beside the queued work: one on repeat, one that asks the orchestrator, one paused. */
export const queueSchedules: ScheduleView[] = [
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

/**
 * Two watches beside the schedules: one looking happily and starting an agent on
 * what it finds, one that could not look at all — which several real ones are
 * doing at any moment, and the reason a row has to be able to say so and then
 * be told to stop saying it.
 */
export const queueWatches: ScheduleView[] = [
  {
    id: 'vulnerable-dependencies',
    name: 'Vulnerable dependencies',
    project: 'checkout',
    said: '',
    kind: 'watch',
    does: 'looks with deps.vulnerabilities, and starts work on what it finds',
    prompt: '',
    when: 'every day at 07:00',
    once: false,
    next: [Date.parse('2026-09-14T07:00:00Z')],
    paused: false,
    by: 'extension:deps',
    missed: 'once',
    runs: [],
    watch: {
      id: 'deps.vulnerabilities',
      turnedOnBy: 'you',
      found: 'agent',
      most: 1,
      looks: [
        {
          at: Date.parse('2026-09-13T07:00:00Z'),
          found: 0,
          fresh: 0,
          left: 0,
          problem: 'the npm registry answered 503: Service Unavailable',
          trouble: null,
          until: null,
          said: null,
        },
      ],
      findings: [],
    },
  },
  {
    id: 'ci-on-this-branch',
    name: 'CI on this branch',
    project: 'checkout',
    said: '',
    kind: 'watch',
    does: 'looks with review.branch-ci, and tells the orchestrator what it finds',
    prompt: '',
    when: 'every 10 minutes',
    once: false,
    next: [Date.parse('2026-09-13T14:10:00Z')],
    paused: false,
    by: 'extension:review',
    missed: 'skip',
    runs: [],
    watch: {
      id: 'review.branch-ci',
      turnedOnBy: 'you',
      found: 'ask',
      most: 2,
      looks: [
        {
          at: Date.parse('2026-09-13T14:00:00Z'),
          found: 2,
          fresh: 1,
          left: 0,
          problem: null,
          trouble: null,
          until: null,
          said: null,
        },
      ],
      findings: [],
    },
  },
]

export const QUEUE_SCREENS: Scenario[] = [
  {
    name: 'a-smart-queue',
    about:
      'Work planned together: two agents working, and under them the SMART QUEUE in the order the resolved tree gives — held because what it waited on failed, with what waits on it shifted right and joined to it by a line, then next, at a time, and paused — told apart by shape, with its one control over it: how much of the tree, `all` or `next`. Under that, SCHEDULES: the standing rules, apart from the work, each saying how often it fires and whether firing makes work or tells somebody. The held piece of work is open: it will not start by itself, it says what can be done, and the chain it is in is drawn with its own box the heavy one.',
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
    name: 'what-is-next-in-the-queue',
    about:
      'Work and no clockwork: the queue under NEXT — the front of the resolved tree, the one only waiting for room and the one whose single wait is an agent working now, which says how much is ahead of it. The rest of the chain is behind those two and left out. The chip showing is filled in the brand’s amber and the pointer is on the other, which lights. SCHEDULES under it is folded, and its heading says why: nothing here runs on a clock.',
    state: {
      ...withTasks(withProjects(initialState(), ['checkout']), chainTasks),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
      hover: { kind: 'action', name: 'queue-scope:all' },
    },
    frame: frame({ screen: '', height: 30, clock: utcClock }),
  },
  {
    name: 'nothing-is-next',
    about:
      'NEXT with nothing in it, and why in the words of the actual reason: the work at the front is held and needs a decision, so what waits behind it is behind that rather than next. Not one sentence for every case — nothing queued, everything paused, and everything at the front held each say their own.',
    state: {
      ...withTasks(
        withProjects(initialState(), ['checkout']),
        queueTasks.filter(
          (task) =>
            !['checkout/docs-typos', 'checkout/release-notes', 'checkout/perf-check'].includes(
              task.task,
            ),
        ),
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
    },
    frame: frame({ screen: '', height: 30, clock: utcClock }),
  },
  {
    name: 'a-watch-that-cannot-look',
    about:
      'The two sections apart, with the clockwork in trouble: SMART QUEUE is the work, and SCHEDULES under it is the five standing rules — how often each fires, and pinned at the right whether firing makes work or tells somebody, which is the difference between an agent at three in the morning and a sentence to read. A watch has a third row for its last look: `14:00 · 1 new` for the one looking happily, and for the one that could not look the reason in Tade’s own words with a `×` to say you have read it. The heading counts it while it is failing, so folding the section away cannot hide it. The pointer is on the `×`.',
    state: {
      ...withTasks(withProjects(initialState(), ['checkout']), queueTasks),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      hover: { kind: 'action', name: 'schedule-hush:vulnerable-dependencies' },
    },
    frame: frame({
      screen: '',
      height: 62,
      clock: utcClock,
      schedules: [...queueSchedules, ...queueWatches],
    }),
  },
  {
    name: 'a-watch-hushed',
    about:
      'The same watch, hushed: the sentence and its `×` are gone, and nothing else is. The `!` on its mark stays, because the watch still cannot look, and so does `1 not looking` on the heading — hushing a reason is being told you have read it, never being told it is fine. It comes back if the reason changes, and if a look works and then it breaks again.',
    state: {
      ...withTasks(withProjects(initialState(), ['checkout']), queueTasks),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      hushed: ['vulnerable-dependencies\u0000the npm registry answered 503: Service Unavailable'],
    },
    frame: frame({
      screen: '',
      height: 62,
      clock: utcClock,
      schedules: [...queueSchedules, ...queueWatches],
    }),
  },
  {
    name: 'clockwork-and-no-queue',
    about:
      'Clockwork and no work: nothing is queued, so SMART QUEUE is folded and its heading says so, and SCHEDULES under it has all five rules in it — two schedules on repeat, one paused, and two watches with their last look under them. A project can be entirely standing rules, and then this is the whole of what is waiting. The window has two projects and the side has been dragged wide, so each row says which project’s rule it is: the same watch runs in both under the same name, and a row that cannot be placed is the confusion this section was split out to end. Where the side is narrower the project is what goes, never how often it fires.',
    state: {
      ...withTasks(withProjects(initialState(), ['checkout', 'search']), [
        { task: 'checkout/bump-mailer', state: 'working', lane: 'checkout/bump-mailer/agent' },
      ]),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
      sizes: { sidebarWidth: 52 },
    },
    frame: frame({
      screen: '',
      height: 44,
      clock: utcClock,
      schedules: [...queueSchedules, ...queueWatches],
    }),
  },
  {
    name: 'work-on-a-clock-is-still-the-queue',
    about:
      'A piece of work due at 18:00, in the queue where it belongs: it starts once, when its time comes, which is what every other row here does. There was a switch to hide it while the schedules were listed beside it and crowding it out; with those in their own section it is one row of ordinary queued work, and a switch over it would have been a second way of saying what the heading already says.',
    state: {
      ...withTasks(
        withProjects(initialState(), ['checkout']),
        queueTasks.filter((task) =>
          ['checkout/bump-mailer', 'checkout/release-notes'].includes(task.task),
        ),
      ),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', height: 30, clock: utcClock, schedules: queueSchedules }),
  },
  {
    name: 'an-empty-smart-queue',
    about:
      'Neither: the SMART QUEUE and SCHEDULES both with nothing in them — there, as they always are, and each folded by itself with its heading saying why in the words of the reason it actually is, rather than either section being gone from the side altogether.',
    state: base(),
    frame: frame({ width: 160 }),
  },
  {
    name: 'the-smart-queue-collapsed',
    about:
      'A queue with five pieces of work in it, folded shut by the person looking at it: the count stays on the heading, so what was put away is still said to be there. The choice is theirs and outlives the window, and it is the queue’s alone — SCHEDULES under it folds and remembers on its own.',
    state: {
      ...withTasks(withProjects(initialState(), ['checkout']), queueTasks),
      project: 'checkout',
      folded: ['queue', 'changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', height: 30, clock: utcClock }),
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
      'Queued work open in front of you — which is what clicking it in the queue shows: the whole chain it is in as boxes, its own drawn heavier, every wait’s reason under it, what its agent will be told, what it will change, and how it counts as finished. Down the side, NEXT with the clocks in it: the piece due at 18:00 stands behind nothing and starts by itself, so it is next like the rest of the front.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), queueTasks),
        'checkout/refund-emails',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
    },
    frame: frame({ screen: '', height: 44, clock: utcClock }),
  },
  {
    name: 'a-chain-in-the-queue',
    about:
      'A chain four deep, in the middle of it. Down the side, the queue in the order the tree resolves to, each piece in the column its depth gives it: the one that can start now on its own at the front, then the chain, each shifted right of what it waits on and joined to it by a line that carries through the room between the tabs — so the same column always means the same priority. In front of you, the whole chain as boxes, left to right, with the one you are on drawn heavier, and every wait’s reason under it.',
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
    name: 'a-plan-too-long-for-columns',
    about:
      'A plan five deep with a branch in it, where an agent’s screen would be. More steps than the pane is wide, so the boxes are drawn in the room they need and the pane is a window onto them, with a bar under them to reach the rest — never a flat list of names, which says nothing about what waits on what. Under it, WHY THIS ORDER draws the same shape again: each piece under what it waits on and shifted right of it, the two that wait on one thing branching under it, and every reason wrapped beneath the wait it belongs to.',
    state: {
      ...showPlan(withTasks(withProjects(initialState(), ['checkout']), longChainTasks)),
      project: 'checkout',
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', height: 42, clock: utcClock }),
  },
  {
    name: 'a-long-chain-of-reasons',
    about:
      'Queued work five deep in a chain, open on the piece in the middle. Longer than the pane is wide, and it keeps its boxes anyway: the chain is drawn whole with a bar under it saying how much is in view. Under that, WHY IT WAITS says the same shape in words — each piece under what it waits on, joined by a line, and every reason wrapped under the wait it belongs to.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), longChainTasks),
        'checkout/refund-emails',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', height: 42, clock: utcClock }),
  },
  {
    name: 'why-it-waits-in-a-narrow-window',
    about:
      'The same chain in a narrow window: the boxes are still drawn rather than given up on, with a bar under them saying how much of the chain is in view. Down the side, NEXT is the front of the tree — the piece behind the one agent working, which says how much is ahead of it — and the piece in front of you is listed with it whatever the view says, in the column its depth gives it.',
    state: {
      ...focusTask(
        withTasks(withProjects(initialState(), ['checkout']), longChainTasks),
        'checkout/refund-emails',
      ),
      folded: ['changes', 'files', 'notes', 'where'],
      ...showing('checkout', { scope: 'next' }),
    },
    frame: frame({ screen: '', width: 80, height: 26, clock: utcClock }),
  },
  {
    name: 'a-deep-chain-in-a-narrow-side',
    about:
      'Six pieces of work stacked in one chain, down a sidebar too narrow for the indent alone. Each sits in the column its depth in the resolved tree gives it — the same column means the same priority, and two pieces that could run side by side would line up — so the tree reaches further right than the side is wide, and a bar along the bottom of it says how much is in view. Nothing is folded back into a column that is not its own, and nothing is squeezed to nothing: what is past the edge is scrolled to.',
    state: {
      ...withTasks(withProjects(initialState(), ['keys']), deepChainTasks),
      project: 'keys',
      folded: ['changes', 'files', 'notes', 'where'],
    },
    frame: frame({ screen: '', width: 96, height: 30, clock: utcClock }),
  },
  {
    name: 'a-deep-chain-scrolled-across',
    about:
      'The same side, dragged sideways: the whole tree has moved together, so the columns still line up and the names the indent had pushed off the edge are readable. What is pinned at the right of a tab has not moved with it — pause, remove and the menu under the pointer belong to the side, not to the tree, so a chain being deep never puts them out of reach.',
    state: {
      ...withTasks(withProjects(initialState(), ['keys']), deepChainTasks),
      project: 'keys',
      folded: ['changes', 'files', 'notes', 'where'],
      across: 8,
      hover: { kind: 'task', task: 'keys/stagger-and-spacing' },
    },
    frame: frame({ screen: '', width: 96, height: 30, clock: utcClock }),
  },
]
