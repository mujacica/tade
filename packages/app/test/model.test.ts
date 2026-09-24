import { IDLE_REASON, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  type AgentPane,
  type AppState,
  acrossOf,
  anythingWorking,
  doneTasks,
  dragAgent,
  dropAgent,
  escapeMeans,
  FOCUS_GUARD_MS,
  focusBy,
  focusNumber,
  focusTask,
  glyph,
  grabBar,
  headline,
  historyMatch,
  initialState,
  keyAction,
  laneShown,
  leaveLine,
  markOf,
  noteTyping,
  onEvent,
  openLine,
  openSchedule,
  parseCommand,
  projectNumber,
  projects,
  type QueuedView,
  queuedCount,
  queueEmptySays,
  queueOf,
  queueTree,
  removeAttachment,
  resizeTo,
  scrollBarTo,
  scrollBy,
  searchKey,
  sectionOpen,
  selectProject,
  setDictation,
  setListening,
  showOrchestrator,
  showPlan,
  showTerminal,
  sidebar,
  somethingTyped,
  startHistorySearch,
  type TaskSnapshot,
  tasksOf,
  terminalsOf,
  toggleDone,
  toggleSection,
  whichProject,
  withProjects,
  withTasks,
  withTerminals,
} from '../src/model.ts'
import { extensionsPanel } from '../src/panels/extensions/state.ts'
import {
  splitPane,
  splitRatio,
  splitShown,
  swapSplit,
  turnSplit,
  typingLane,
  unsplitPane,
} from '../src/split.ts'
import { thinking, youSaid } from '../src/transcript.ts'

const NOW = Date.parse('2026-09-11T14:00:00Z')

const tasks: TaskSnapshot[] = [
  {
    task: 'checkout/stripe-v15',
    state: 'blocked',
    lane: 'checkout/stripe-v15/agent',
    waiting: true,
  },
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  { task: 'search/pagination', state: 'review' },
]

const state = (over: Partial<AppState> = {}): AppState => ({
  ...withTasks(initialState(), tasks),
  ...over,
})

const event = (over: Partial<TadeEvent> = {}): TadeEvent => ({
  seq: 1,
  ts: '2026-09-11T14:00:00.000Z',
  type: 'permission_request',
  urgency: 'blocking',
  task: 'checkout/refunds',
  lane: null,
  run: 'r1',
  detail: {},
  ...over,
})

describe('tasks and focus', () => {
  it('focuses the first task when there was nothing before', () => {
    expect(withTasks(initialState(), tasks).focused).toBe('checkout/stripe-v15')
  })

  it('keeps your place when the task list is refreshed', () => {
    const focused = focusTask(state(), 'search/pagination')
    // Status polls constantly; losing the pane each time would be unusable.
    expect(withTasks(focused, tasks).focused).toBe('search/pagination')
  })

  it('moves focus elsewhere only when the task is gone', () => {
    const focused = focusTask(state(), 'search/pagination')
    const fewer = withTasks(focused, tasks.slice(0, 2))
    expect(fewer.focused).toBe('checkout/stripe-v15')
  })

  it('cycles through panes and the orchestrator, wrapping', () => {
    let current = state()
    expect(current.focused).toBe('checkout/stripe-v15')
    current = focusBy(current, 1)
    expect(current.focused).toBe('checkout/refunds')
    current = focusBy(current, 1)
    expect(current.focused).toBe('search/pagination')
    // The orchestrator is one of the things you tab to: it is where you type
    // to Tade, and leaving it out left a window with no tasks unusable. Its
    // line opens, and the agent you were watching stays in view behind it.
    current = focusBy(current, 1)
    expect(current.dictation).toBe('')
    expect(current.focused).toBe('search/pagination')
    current = focusBy(current, 1)
    expect(current.focused).toBe('checkout/stripe-v15')
    expect(current.dictation).toBeNull()
    expect(focusBy(current, -1).dictation).toBe('')
  })

  it('has somewhere to go even with no tasks at all', () => {
    // Which is the window everybody sees first.
    const empty = { ...state(), panes: [], focused: null }
    expect(focusBy(empty, 1)).toMatchObject({ focused: null, dictation: '' })
  })

  it('ignores a task it does not have', () => {
    expect(focusTask(state(), 'nope/nope').focused).toBe('checkout/stripe-v15')
  })

  it('copes with having nothing to show', () => {
    expect(focusBy(initialState(), 1).focused).toBeNull()
    expect(sidebar(initialState())).toEqual([])
  })
})

describe('a pane raising itself', () => {
  it('takes the screen when an agent needs a human', () => {
    const next = onEvent(state(), event(), NOW)
    expect(next.focused).toBe('checkout/refunds')
    expect(next.notice).toBe('refunds needs you')
  })

  it('does not, while you are typing somewhere else', () => {
    const typing = noteTyping(state(), NOW - 5_000)
    expect(onEvent(typing, event(), NOW).focused).toBe('checkout/stripe-v15')
  })

  it('does once you have stopped', () => {
    const idle = noteTyping(state(), NOW - FOCUS_GUARD_MS - 1)
    expect(onEvent(idle, event(), NOW).focused).toBe('checkout/refunds')
  })

  it('never for routine noise', () => {
    for (const type of ['output', 'tool_call', 'turn_done'] as const) {
      const next = onEvent(state(), event({ type, urgency: 'routine' }), NOW)
      expect(next.focused).toBe('checkout/stripe-v15')
    }
  })

  it('never for a task that has no pane', () => {
    expect(onEvent(state(), event({ task: 'ghost/task' }), NOW).focused).toBe('checkout/stripe-v15')
  })

  it('marks a pane as waiting, and clears it once answered', () => {
    const waiting = onEvent(state(), event(), NOW)
    expect(waiting.panes.find((p) => p.task === 'checkout/refunds')?.waiting).toBe(true)

    const answered = onEvent(
      waiting,
      event({ type: 'permission_granted', urgency: 'routine' }),
      NOW,
    )
    expect(answered.panes.find((p) => p.task === 'checkout/refunds')?.waiting).toBe(false)
  })
})

describe('what the window shows', () => {
  it('groups tasks under their projects', () => {
    const groups = sidebar(state())
    expect(groups.map((g) => g.project)).toEqual(['checkout', 'search'])
    expect(groups[0]?.tasks.map((t) => t.name)).toEqual(['stripe-v15', 'refunds'])
    expect(groups[0]?.tasks[0]?.focused).toBe(true)
  })

  it('marks what each agent is doing by its shape, not only its colour', () => {
    const pane = (over: Partial<AgentPane>) => ({
      state: 'working' as const,
      waiting: false,
      approval: null,
      ...over,
    })
    const marks = {
      working: pane({ state: 'working' }),
      idle: pane({ state: 'blocked', reason: IDLE_REASON }),
      'needs-you': pane({ state: 'blocked', reason: 'turn ended with failing tests' }),
      failed: pane({ state: 'failed' }),
      done: pane({ state: 'review' }),
      stopped: pane({ state: 'queued' }),
      parked: pane({ state: 'parked' }),
    }
    for (const [mark, one] of Object.entries(marks)) expect(markOf(one)).toBe(mark)
    // Seven marks, seven shapes: readable without colour.
    expect(new Set(Object.values(marks).map((one) => glyph(one, 0))).size).toBe(7)
    // An approval is waiting on you whatever else is true, working included.
    expect(markOf(pane({ state: 'working', approval: { tool: 'bash', summary: 'rm' } }))).toBe(
      'needs-you',
    )
    // Finished is what was said or what its rule saw, not how its turn ended...
    const finished = { by: 'agent', summary: 'Charges once.' }
    expect(markOf(pane({ state: 'blocked', reason: IDLE_REASON, finished }))).toBe('done')
    // ...until it is put back to work, or someone is asked something.
    expect(markOf(pane({ state: 'working', finished }))).toBe('working')
    expect(markOf(pane({ state: 'blocked', finished, waiting: true }))).toBe('needs-you')
    // Working turns, a tenth of a second a step.
    expect(glyph(marks.working, 0)).not.toBe(glyph(marks.working, 100))
    expect(glyph(marks.idle, 0)).toBe(glyph(marks.idle, 100))
  })

  it('says what is waiting, and whether it is listening', () => {
    expect(headline(state())).toBe('1 waiting')
    expect(headline(setListening(state(), true))).toBe('⏺ listening · 1 waiting')
  })
})

describe('the smart queue', () => {
  const queued = (
    task: string,
    state: QueuedView['state'],
    at: number | null = null,
  ): TaskSnapshot => ({
    task,
    state: 'queued',
    queued: { state, after: [], prompt: '', touches: [], at },
  })
  const plan: TaskSnapshot[] = [
    { task: 'app/working', state: 'working' },
    queued('app/later', { kind: 'scheduled', at: 2_000 }, 2_000),
    queued('app/soon', { kind: 'scheduled', at: 1_000 }, 1_000),
    queued('app/stopped', { kind: 'paused', all: false }),
    queued('app/after', { kind: 'waiting', on: ['app/working'] }),
    queued('app/stuck', { kind: 'held', on: 'app/working', because: 'app/working failed' }),
    queued('app/next', { kind: 'ready' }),
  ]

  it('is apart from the agents: what needs deciding first, then what starts soonest', () => {
    const state = withTasks(initialState(), plan)
    expect(tasksOf(state).map((task) => task.name)).toEqual(['working'])
    expect(queueOf(state).map((task) => task.name)).toEqual([
      'stuck',
      'next',
      'after',
      'soon',
      'later',
      'stopped',
    ])
    expect(queuedCount(state)).toBe(6)
    // Held is a decision nobody has made: it counts as waiting on you.
    expect(markOf(state.panes.find((pane) => pane.task === 'app/stuck') ?? plan[0]!)).toBe(
      'needs-you',
    )
  })

  it('shows what waits for a time, or the front of the resolved tree', () => {
    const state = withTasks(initialState(), plan)
    const shown = (queueFilter: AppState['queueFilter']) =>
      queueOf({ ...state, queueFilter }).map((task) => task.name)
    expect(shown('timed')).toEqual(['soon', 'later'])
    // `next` is the front of the tree: the one with room, and the one whose
    // only wait is an agent working now — it starts when that agent finishes.
    // Held and paused work will not start by itself, so neither is next.
    expect(shown('next')).toEqual(['next', 'after'])
    // Filtered away is not gone: the count is still all of it.
    expect(queuedCount({ ...state, queueFilter: 'timed' })).toBe(6)
  })

  it('says why nothing is next in the words of the reason there is nothing', () => {
    const says = (tasks: TaskSnapshot[], queueFilter: AppState['queueFilter'] = 'next') =>
      queueEmptySays({ ...withTasks(initialState(), tasks), queueFilter })
    expect(says([{ task: 'app/working', state: 'working' }])).toBe('nothing is queued')
    expect(
      says([
        { task: 'app/working', state: 'working' },
        queued('app/stuck', { kind: 'held', on: 'app/working', because: 'it failed' }),
      ]),
    ).toBe('nothing is next: stuck is held')
    // Behind held work is not next: what is at the front is what is stopping it.
    expect(
      says([
        queued('app/stuck', { kind: 'held', on: 'app/gone', because: 'it failed' }),
        queued('app/stopped', { kind: 'paused', all: false }),
      ]),
    ).toBe('nothing is next: what is at the front is held or paused')
    expect(says([queued('app/stopped', { kind: 'paused', all: false })])).toBe(
      'nothing is next: stopped is paused',
    )
    expect(says([queued('app/soon', { kind: 'scheduled', at: 1_000 }, 1_000)])).toBe(
      'nothing is next: soon waits for a time',
    )
    // The other two filters answer for themselves.
    expect(says(plan, 'timed')).toBe('nothing waits for a time')
    expect(says(plan, 'all')).toBe('nothing is queued')
  })

  it('orders the queue by the resolved tree, each piece under what it waits on', () => {
    const chain: TaskSnapshot[] = [
      { task: 'app/fix', state: 'failed', reason: 'tests failed' },
      { task: 'app/mailer', state: 'working' },
      queued('app/typos', { kind: 'ready' }),
      queued('app/emails', { kind: 'waiting', on: ['app/refunds', 'app/mailer'] }),
      queued('app/refunds', { kind: 'held', on: 'app/fix', because: 'app/fix failed' }),
      queued('app/thanks', { kind: 'waiting', on: ['app/emails'] }),
    ]
    // What each waits on is in its plan, which is what the tree is read from.
    const withAfter = chain.map((task) =>
      task.queued
        ? {
            ...task,
            queued: {
              ...task.queued,
              after:
                task.task === 'app/emails'
                  ? [
                      { task: 'app/refunds', why: 'it emails what it returns' },
                      { task: 'app/mailer', why: 'send() changes' },
                    ]
                  : task.task === 'app/thanks'
                    ? [{ task: 'app/emails', why: 'it follows the email' }]
                    : task.task === 'app/refunds'
                      ? [{ task: 'app/fix', why: 'both change charge.ts' }]
                      : [],
            },
          }
        : task,
    )
    const state = withTasks(initialState(), withAfter)
    const tree = queueTree(state)
    // The held one is at the front of its path; what waits on it follows it,
    // however deep, before the work that only waits for room.
    expect(tree.map((row) => row.pane.name)).toEqual(['refunds', 'emails', 'thanks', 'typos'])
    expect(tree.map((row) => row.depth)).toEqual([0, 1, 2, 0])
    expect(tree.map((row) => row.parent)).toEqual([null, 'app/refunds', 'app/emails', null])
    // Next is the front of the tree that will start by itself: the one with
    // room. The held one needs a decision, and what is behind it is behind it.
    expect(queueOf({ ...state, queueFilter: 'next' }).map((task) => task.name)).toEqual(['typos'])
  })
})

describe('folding a section in the sidebar', () => {
  it('opens one that folds itself away, and remembers that you did', () => {
    // A section with nothing in it is shut on its own. Opening it is a
    // choice, and a choice outlasts the minute it was made in.
    const start = initialState()
    expect(sectionOpen(start, 'queue', true)).toBe(false)
    const open = toggleSection(start, 'queue', true)
    expect(open.opened).toEqual(['queue'])
    expect(open.folded).not.toContain('queue')
    expect(sectionOpen(open, 'queue', true)).toBe(true)
    // Still open once there is something in it, and still yours to shut.
    expect(sectionOpen(open, 'queue', false)).toBe(true)
  })

  it('writes down only what differs from what the section does on its own', () => {
    // Shut a section that is open on its own and that is a choice; open it
    // again and it is back to following its own rule, not pinned to it.
    const shut = toggleSection(initialState(), 'changes', false)
    expect(shut.folded).toContain('changes')
    const again = toggleSection(shut, 'changes', false)
    expect(again.folded).not.toContain('changes')
    expect(again.opened).not.toContain('changes')
    // The same the other way round, for one that starts shut with nothing in it.
    const opened = toggleSection(initialState(), 'queue', true)
    const back = toggleSection(opened, 'queue', true)
    expect(back.opened).not.toContain('queue')
    expect(back.folded).not.toContain('queue')
  })

  it('keeps a section shut that you shut while there was something in it', () => {
    const shut = toggleSection(initialState(), 'queue', false)
    expect(shut.folded).toContain('queue')
    expect(sectionOpen(shut, 'queue', false)).toBe(false)
    expect(sectionOpen(shut, 'queue', true)).toBe(false)
  })
})

describe('whether anything is working', () => {
  it('is true while an agent in this project works, so its spinner turns', () => {
    const state = withTasks(initialState(), [
      { task: 'app/one', state: 'working' },
      { task: 'app/two', state: 'review' },
    ])
    expect(anythingWorking(state)).toBe(true)
    // An agent in another project turns nothing you are looking at.
    expect(anythingWorking({ ...state, project: 'elsewhere' })).toBe(false)
  })

  it('is true while the orchestrator thinks, or one of its tools runs', () => {
    const quiet = initialState()
    expect(anythingWorking(quiet)).toBe(false)
    expect(
      anythingWorking({ ...quiet, transcript: { ...quiet.transcript, thinking: 1_000 } }),
    ).toBe(true)
    expect(
      anythingWorking({
        ...quiet,
        transcript: {
          ...quiet.transcript,
          entries: [
            {
              kind: 'tool',
              id: 't1',
              tool: 'tade_status',
              detail: '',
              state: 'running',
              result: '',
              progress: null,
              at: 1_000,
            },
          ],
        },
      }),
    ).toBe(true)
  })
})

describe('the agents that have finished', () => {
  const finished: TaskSnapshot[] = [
    { task: 'app/working', state: 'working' },
    { task: 'app/reviewed', state: 'review' },
    { task: 'app/said-so', state: 'blocked', finished: { by: 'agent', summary: 'done' } },
  ]

  it('are the ones X would close, whether or not they are shown', () => {
    const state = withTasks(initialState(), finished)
    expect(doneTasks(state).map((pane) => pane.name)).toEqual(['reviewed', 'said-so'])
    // Hiding them is a view, never a decision about them.
    expect(doneTasks(toggleDone(state)).map((pane) => pane.name)).toEqual(['reviewed', 'said-so'])
  })

  it('leave the list when H hides them, and come back when it is pressed again', () => {
    const state = withTasks(initialState(), finished)
    expect(tasksOf(state).map((pane) => pane.name)).toEqual(['working', 'reviewed', 'said-so'])
    const hidden = toggleDone(state)
    expect(hidden.hidingDone).toBe(true)
    expect(tasksOf(hidden).map((pane) => pane.name)).toEqual(['working'])
    expect(tasksOf(toggleDone(hidden)).map((pane) => pane.name)).toEqual([
      'working',
      'reviewed',
      'said-so',
    ])
  })

  it('keeps the one you are watching in the list, hidden or not', () => {
    const hidden = toggleDone(focusTask(withTasks(initialState(), finished), 'app/reviewed'))
    expect(tasksOf(hidden).map((pane) => pane.name)).toEqual(['working', 'reviewed'])
  })
})

describe('the order of agents in the list', () => {
  const three: TaskSnapshot[] = [
    { task: 'app/a', state: 'working' },
    { task: 'app/b', state: 'working' },
    { task: 'app/c', state: 'working' },
  ]
  const names = (state: AppState) => tasksOf(state).map((task) => task.name)

  it('follows an agent dragged, while it is dragged, and keeps it where it is let go', () => {
    const start = withTasks(initialState(), three)
    expect(names(start)).toEqual(['a', 'b', 'c'])
    // Held over the last place: the list shows where it would land, and which one is in hand.
    const moving = dragAgent(start, 'app/a', 2)
    expect(names(moving)).toEqual(['b', 'c', 'a'])
    expect(tasksOf(moving).find((task) => task.dragging)?.name).toBe('a')
    const dropped = dropAgent(moving)
    expect(names(dropped)).toEqual(['b', 'c', 'a'])
    expect(dropped.reordering).toBeNull()
    expect(dropped.order).toEqual({ app: ['app/b', 'app/c', 'app/a'] })
  })

  it('puts an agent it has not been told about after the ones you placed', () => {
    const placed = { ...withTasks(initialState(), three), order: { app: ['app/c', 'app/a'] } }
    expect(names(placed)).toEqual(['c', 'a', 'b'])
    expect(names(withTasks(placed, [...three, { task: 'app/d', state: 'queued' }]))).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('is the order tab and the numbers go in', () => {
    const placed = focusTask(
      { ...withTasks(initialState(), three), order: { app: ['app/c', 'app/b', 'app/a'] } },
      'app/c',
    )
    expect(focusBy(placed, 1).focused).toBe('app/b')
    expect(focusNumber(placed, 3).focused).toBe('app/a')
  })
})

describe('which project you are in', () => {
  it('is the one the focused task belongs to', () => {
    expect(state().project).toBe('checkout')
    expect(focusTask(state(), 'search/pagination').project).toBe('search')
  })

  it('lists a project that has no tasks in it yet, in the order the config gives', () => {
    // It is still somewhere you can stand, and standing there is how the first
    // task in it gets made. The order is yours: the tabs follow the config.
    const known = withProjects(state(), ['search', 'infra', 'checkout'])
    expect(projects(known)).toEqual(['search', 'infra', 'checkout'])
  })

  it('shows only the tasks of that project down the side', () => {
    expect(tasksOf(state()).map((task) => task.name)).toEqual(['stripe-v15', 'refunds'])
    expect(tasksOf(selectProject(state(), 'search')).map((t) => t.name)).toEqual(['pagination'])
  })

  it('takes the focus with it, so the pane and the list agree', () => {
    expect(selectProject(state(), 'search').focused).toBe('search/pagination')
  })

  it('puts you on the orchestrator in a project with nothing in it', () => {
    const empty = withProjects(state(), ['checkout', 'search', 'infra'])
    expect(selectProject(empty, 'infra').focused).toBeNull()
  })

  it('leaves this project’s plan and schedule behind when you go to another', () => {
    // A plan belongs to the project it is a plan of, exactly as an agent does.
    // Left open, arriving in an empty project landed on `infra › plan  0
    // tasks` instead of the orchestrator — and a plan scrolled along opened
    // the next project's already scrolled.
    const empty = withProjects(state(), ['checkout', 'search', 'infra'])
    const open = { ...showPlan(empty), planAcross: 30 }
    expect(open.showingPlan).toBe(true)
    const gone = selectProject(open, 'infra')
    expect(gone.showingPlan).toBe(false)
    expect(gone.planAcross).toBe(0)
    expect(gone.focused).toBeNull()
    expect(selectProject(openSchedule(empty, 'checkout/nightly'), 'infra').schedule).toBeNull()
  })
})

describe('a typed command', () => {
  it('is the first word, and everything after it is what the command is for', () => {
    expect(parseCommand('/new fix the double charge')).toEqual({
      name: '/new',
      rest: 'fix the double charge',
    })
    expect(parseCommand('  /quit  ')).toEqual({ name: '/quit', rest: '' })
  })

  it('starts work in the project you are looking at', () => {
    expect(whichProject('fix the refund', ['checkout', 'search'], 'checkout')).toEqual({
      project: 'checkout',
      intent: 'fix the refund',
    })
  })

  it('starts it somewhere else when you name somewhere else', () => {
    expect(
      whichProject('search pagination is off by one', ['checkout', 'search'], 'checkout'),
    ).toEqual({ project: 'search', intent: 'pagination is off by one' })
  })

  it('takes the only project there is, without being told', () => {
    expect(whichProject('fix the refund', ['checkout'], null).project).toBe('checkout')
  })

  it('asks rather than guessing between two', () => {
    expect(whichProject('fix the refund', ['checkout', 'search'], null).project).toBeNull()
  })

  it('keeps what was said, so the intent is the words that were used', () => {
    // `intent_spoken` is stored verbatim; only a project named up front is
    // taken off the front, because it is addressing, not intent.
    expect(whichProject('Park The Stripe One', ['checkout'], 'checkout').intent).toBe(
      'Park The Stripe One',
    )
  })
})

describe('dictation', () => {
  it('is closed until you start talking', () => {
    expect(state().dictation).toBeNull()
  })

  it('opens empty, takes what is said, and closes again', () => {
    // Typed today, filled by a transcriber later: the same line either way.
    const open = setDictation(state(), '')
    expect(open.dictation).toBe('')
    expect(setDictation(open, 'park the stripe one').dictation).toBe('park the stripe one')
    expect(setDictation(open, null).dictation).toBeNull()
  })

  it('is not the same thing as listening', () => {
    // The line can be open with nothing said yet, so they are tracked apart.
    const open = setDictation(state(), '')
    expect(open.listening).toBe(false)
    expect(setListening(open, true).dictation).toBe('')
  })
})

describe('keys the shell claims', () => {
  it('switches panes', () => {
    expect(keyAction('tab', state())).toEqual({ kind: 'focus-next' })
    expect(keyAction('shift+tab', state())).toEqual({ kind: 'focus-previous' })
  })

  it('claims push-to-talk even while an agent has focus', () => {
    expect(keyAction('talk-down', state())).toEqual({ kind: 'talk-start' })
    expect(keyAction('talk-up', setListening(state(), true))).toEqual({ kind: 'talk-stop' })
  })

  it('ignores the release when nothing was being said', () => {
    expect(keyAction('talk-up', state())).toEqual({ kind: 'none' })
  })

  it('answers with one key only while that pane is actually waiting', () => {
    const waiting = focusTask(state(), 'checkout/stripe-v15')
    expect(keyAction('a', waiting)).toEqual({ kind: 'approve' })
    expect(keyAction('d', waiting)).toEqual({ kind: 'deny' })

    const notWaiting = focusTask(state(), 'checkout/refunds')
    // Otherwise "a" is just a letter you typed at your agent.
    expect(keyAction('a', notWaiting)).toEqual({ kind: 'none' })
  })

  it('leaves everything else to the focused agent', () => {
    for (const key of ['x', 'ctrl+r', 'up', 'enter']) {
      expect(keyAction(key, state())).toEqual({ kind: 'none' })
    }
  })
})

describe('the bottom panel', () => {
  const tabs = [
    { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
    { id: 'search/terminals/1', project: 'search', name: 'logs' },
  ]

  it('shows a terminal with the keyboard in it, and gives the front back when it goes', () => {
    let current = showTerminal(withTerminals(state(), tabs), 'checkout/terminals/1')
    expect(current).toMatchObject({
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal',
      dictation: null,
    })
    expect(terminalsOf(current).map((t) => t.name)).toEqual(['tests'])
    current = withTerminals(current, tabs.slice(1))
    expect(current).toMatchObject({ bottom: 'orchestrator', keyboard: 'pane' })
  })

  it('leaves tab, ctrl+c and letters to a terminal with the keyboard, but keeps talk and search', () => {
    const inTerminal = showTerminal(withTerminals(state(), tabs), 'checkout/terminals/1')
    for (const key of ['tab', 'shift+tab', 'ctrl+c', 'a', 'd']) {
      expect(keyAction(key, inTerminal).kind).toBe('none')
    }
    expect(keyAction('talk-down', inTerminal).kind).toBe('talk-start')
    expect(keyAction('search', inTerminal).kind).toBe('search')
    expect(keyAction('reload', state())).toEqual({ kind: 'run', action: 'reload' })
    expect(keyAction('tab', showOrchestrator(inTerminal)).kind).toBe('focus-next')
  })

  it('follows a dragged divider', () => {
    const sidebar = resizeTo({ ...state(), resizing: 'sidebar' }, { x: 40, y: 5 }, { height: 50 })
    expect(sidebar.sizes).toEqual({ sidebarWidth: 40 })
    const bottom = resizeTo(
      { ...state(), resizing: 'bottom', bottomMode: 'min' },
      { x: 0, y: 30 },
      { height: 50 },
    )
    expect(bottom).toMatchObject({ sizes: { stripHeight: 18 }, bottomMode: 'open' })
    expect(resizeTo(state(), { x: 1, y: 1 }, { height: 50 }).sizes).toEqual({})
  })
})

describe('a split pane', () => {
  const panes: TaskSnapshot[] = [
    {
      task: 'app/refunds',
      state: 'working',
      lane: 'app/refunds/agent',
      lanes: [
        { id: 'app/refunds/agent', kind: 'agent' },
        { id: 'app/refunds/shell', kind: 'shell' },
      ],
    },
  ]
  const base = focusTask(withTasks(initialState(), panes), 'app/refunds')
  const pane = () => base.panes[0] as NonNullable<(typeof base.panes)[0]>

  it('shows a shell beside the agent, types into the half with the keyboard, and swaps', () => {
    let state = splitPane(base, 'app/refunds', 'app/refunds/shell', 'beside')
    expect(splitShown(state, pane())).toMatchObject({ lane: 'app/refunds/shell', ratio: 0.5 })
    expect(typingLane(state, pane())).toBe('app/refunds/shell')
    state = { ...state, splitFocus: false }
    expect(typingLane(state, pane())).toBe('app/refunds/agent')
    state = swapSplit(state, 'app/refunds')
    expect(laneShown(state, pane())).toBe('app/refunds/shell')
    expect(splitShown(state, pane())?.lane).toBe('app/refunds/agent')
    expect(turnSplit(state, 'app/refunds').splits['app/refunds']?.direction).toBe('below')
    expect(splitShown(unsplitPane(state, 'app/refunds'), pane())).toBeNull()
    expect(splitRatio(0.95)).toBe(0.8)
  })

  it('goes to an agent and a project by number', () => {
    expect(focusNumber(base, 1).focused).toBe('app/refunds')
    expect(focusNumber(base, 5)).toBe(base)
    const two = withProjects(base, ['app', 'shop'])
    expect(projectNumber(two, 2).project).toBe('shop')
  })
})

describe('escape, and what it is allowed to mean', () => {
  // The three harnesses Tade runs agents in all answer this key the same way:
  // pi, Claude Code and Codex each interrupt the turn and each leave the
  // editor exactly as it was. The window does what they do, and — because it
  // is a window and not one pane — it has to settle what escape means when
  // something else is already using it.
  const busy = (over: Partial<AppState> = {}): AppState =>
    state({
      focused: null,
      chose: true,
      transcript: thinking(youSaid(initialState().transcript, 'why is refunds slow', 0), 0),
      ...over,
    })

  it('stops the orchestrator while it is thinking, and only then', () => {
    expect(escapeMeans(busy({ dictation: 'half a sentence' }))).toBe('interrupt')
    expect(keyAction('escape', busy({ dictation: 'half a sentence' }))).toEqual({
      kind: 'interrupt',
    })
    // Nothing is running, so there is nothing for it to stop — and it still
    // does not touch the line.
    expect(escapeMeans(state({ focused: null, chose: true, dictation: 'half a sentence' }))).toBe(
      'nothing',
    )
    expect(keyAction('escape', state({ focused: null, chose: true, dictation: 'x' }))).toEqual({
      kind: 'none',
    })
  })

  it('steps off the line only when there is nothing on it to lose', () => {
    const typed = state({ focused: null, chose: true, dictation: 'half a sentence' })
    expect(escapeMeans(typed)).toBe('nothing')
    const empty = state({ focused: null, chose: true, dictation: '' })
    expect(escapeMeans(empty)).toBe('leave')
    expect(keyAction('escape', empty)).toEqual({ kind: 'leave-line' })
    // A picture going with the message is something to lose, so it holds too.
    expect(escapeMeans({ ...empty, attached: ['/tmp/shot.png'] })).toBe('nothing')
    // And a turn to stop comes first: leaving the line can wait.
    expect(escapeMeans(busy({ dictation: '' }))).toBe('interrupt')
  })

  it('closes what is open before it stops anything, and never does both', () => {
    const panelled = busy({ dictation: '', panel: extensionsPanel() })
    expect(escapeMeans(panelled)).toBe('panel')
    expect(keyAction('escape', panelled)).toEqual({ kind: 'none' })
  })

  it('ends a history search before it stops anything', () => {
    const searching = busy({
      dictation: 'park refunds',
      historySearch: { query: 'park', skip: 0, draft: 'draft', missing: false },
    })
    expect(escapeMeans(searching)).toBe('search')
    expect(keyAction('escape', searching)).toEqual({ kind: 'none' })
  })

  it('belongs to whatever else has the keyboard: an agent, a terminal', () => {
    // pi interrupts its own agent on escape and a shell's editor wants it too,
    // so a window that ate the key would break both.
    const atAgent = focusTask({ ...busy(), dictation: null }, 'checkout/refunds')
    expect(escapeMeans(atAgent)).toBe('lane')
    const inTerminal = showTerminal(
      withTerminals(busy(), [{ id: 'checkout/terminals/1', name: 'tests', project: 'checkout' }]),
      'checkout/terminals/1',
    )
    expect(escapeMeans(inTerminal)).toBe('lane')
    expect(keyAction('escape', inTerminal)).toEqual({ kind: 'none' })
  })
})

describe('ctrl+c on the orchestrator line', () => {
  // "clear input, then quit", which is Codex's wording and pi's and Claude
  // Code's behaviour: the second press has nothing left to clear, so it quits
  // however long you took over it.
  it('discards what is typed, and quits once there is nothing left to discard', () => {
    const typed = state({ focused: null, chose: true, dictation: 'why is refunds slow' })
    expect(somethingTyped(typed)).toBe(true)
    expect(keyAction('ctrl+c', typed)).toEqual({ kind: 'discard' })
    const empty = state({ focused: null, chose: true, dictation: '' })
    expect(somethingTyped(empty)).toBe(false)
    expect(keyAction('ctrl+c', empty)).toEqual({ kind: 'quit' })
  })

  it('counts the pictures going with it, and a search part-way through', () => {
    expect(somethingTyped(state({ dictation: '', attached: ['/tmp/shot.png'] }))).toBe(true)
    expect(
      somethingTyped(
        state({
          dictation: '',
          historySearch: { query: 'park', skip: 0, draft: '', missing: false },
        }),
      ),
    ).toBe(true)
  })

  it('is still the way out from anywhere the line is closed', () => {
    expect(keyAction('ctrl+c', state({ dictation: null }))).toEqual({ kind: 'quit' })
  })
})

describe('what you said before', () => {
  const history = ['status', 'park refunds', 'why is refunds slow']

  it('is searched back through as ctrl+r does, and escape puts the line back', () => {
    let state = startHistorySearch(setDictation(initialState(), 'draft'), history)
    for (const char of 'refunds') state = searchKey(state, history, undefined, char).state
    expect(state.dictation).toBe('why is refunds slow')
    state = searchKey(state, history, 'ctrl+r', '\x12').state
    expect(state.dictation).toBe('park refunds')
    // Nothing older matches: it stays on the last it found.
    expect(searchKey(state, history, 'ctrl+r', '\x12').state.dictation).toBe('park refunds')
    expect(searchKey(state, history, 'escape', '\x1b').state).toMatchObject({
      dictation: 'draft',
      historySearch: null,
    })
    expect(searchKey(state, history, 'enter', '\r')).toMatchObject({
      send: true,
      state: { dictation: 'park refunds', historySearch: null },
    })
    let missing = startHistorySearch(setDictation(initialState(), 'draft'), history)
    for (const char of 'zzz') missing = searchKey(missing, history, undefined, char).state
    expect(missing.historySearch?.missing).toBe(true)
    expect(searchKey(missing, history, 'enter', '\r')).toMatchObject({
      send: false,
      state: { dictation: 'draft' },
    })
    expect(historyMatch(history, { query: 'STATUS', skip: 0 })).toBe('status')
  })
})

describe('the orchestrator draft', () => {
  it('survives switching focus to an agent and back', () => {
    // The orchestrator is "focused" when dictation is non-null; the agent
    // stays visible behind it, so focused keeps pointing at the last agent.
    const onOrchestrator = { ...state(), dictation: 'hello there' }
    const toAgent = focusBy(onOrchestrator, 1)
    expect(toAgent.dictation).toBeNull()
    expect(toAgent.orchestratorDraft).toBe('hello there')
    expect(toAgent.focused).toBe('checkout/stripe-v15')
    const back = focusBy(toAgent, -1)
    expect(back.dictation).toBe('hello there')
    expect(back.focused).toBe('checkout/stripe-v15')
  })

  it('survives opening a terminal and coming back', () => {
    const tabs = [{ id: 't1', project: 'checkout', name: 'tests' }]
    const onOrchestrator = { ...state(), focused: null, dictation: 'park refunds' }
    const toTerminal = showTerminal(withTerminals(onOrchestrator, tabs), 't1')
    expect(toTerminal.dictation).toBeNull()
    expect(toTerminal.orchestratorDraft).toBe('park refunds')
    const back = showOrchestrator(toTerminal)
    expect(back.dictation).toBe('park refunds')
  })

  it('keeps the newest draft when typing after returning', () => {
    const toAgent = focusBy({ ...state(), focused: null, dictation: 'first draft' }, 1)
    const back = showOrchestrator(toAgent)
    expect(back.dictation).toBe('first draft')
    const retyped = { ...back, dictation: 'second draft' }
    const awayAgain = focusBy(retyped, 1)
    expect(awayAgain.orchestratorDraft).toBe('second draft')
  })

  it('is kept by every way of leaving the line, and found by every way back', () => {
    // The two doors, and nothing else: whoever closes the line keeps what was
    // on it, and whoever opens it gets it back. A way out that forgot to save
    // or a way in that started empty is a half-written message thrown away,
    // which is the one thing the window may never do.
    const typed = { ...state(), dictation: 'why is refunds slow' }
    for (const leave of [leaveLine, (one: AppState) => setDictation(one, null)]) {
      const away = leave(typed)
      expect(away.dictation).toBeNull()
      expect(away.orchestratorDraft).toBe('why is refunds slow')
      expect(openLine(away).dictation).toBe('why is refunds slow')
      expect(showOrchestrator(away).dictation).toBe('why is refunds slow')
    }
  })

  it('leaves an open line alone when it is opened again', () => {
    const typed = { ...state(), dictation: 'half a sentence', orchestratorDraft: 'older' }
    expect(openLine(typed).dictation).toBe('half a sentence')
    // Emptied on purpose — ctrl+c, or a message sent — is not a draft to
    // restore: only a line that was closed has one.
    expect(openLine({ ...typed, dictation: '' }).dictation).toBe('')
  })
})

describe('attachments', () => {
  it('removes individual attachments without disturbing the rest', () => {
    const withAttached = { ...state(), attached: ['/a.png', '/b.txt', '/c.png'] }
    const one = removeAttachment(withAttached, '/b.txt')
    expect(one.attached).toEqual(['/a.png', '/c.png'])
    const none = removeAttachment(one, '/a.png')
    expect(none.attached).toEqual(['/c.png'])
    const last = removeAttachment(none, '/c.png')
    expect(last.attached).toEqual([])
  })
})

describe('dragging a scrollbar', () => {
  const bar = { area: 'sidebar' as const, total: 100, shown: 10 }
  const track = { top: 2, rows: 10 }

  it('scrolls to where the thumb was dropped, whichever way the region counts', () => {
    // Taken hold of on the track rather than on the thumb: it comes to the pointer.
    const middle = grabBar(state(), bar, track, 7)
    expect(middle.scroll).toBeGreaterThan(30)
    expect(middle.scroll).toBeLessThan(60)
    expect(scrollBarTo(middle, 2).scroll).toBe(0)
    expect(scrollBarTo(middle, 200).scroll).toBe(90)
    // A screen counts back from its newest line, so the same drag is the same
    // place said the other way round.
    const screen = grabBar(state(), { ...bar, area: 'pane' }, track, 12)
    expect(screen.paneScroll).toBe(0)
    expect(scrollBarTo(screen, 2).paneScroll).toBe(90)
  })

  it('moves with the pointer from where the thumb was taken hold of, not under it', () => {
    // At the newest line the thumb is at the foot of the track — three rows of
    // ten here — so pressing its middle and dragging nowhere moves nothing.
    const held = grabBar(state(), { area: 'pane', total: 30, shown: 10 }, track, 10)
    expect(held.paneScroll).toBe(0)
    expect(held.scrolling).toMatchObject({ area: 'pane', grab: 1 })
    // And the same press, dragged a row up, is a row further back.
    expect(scrollBarTo(held, 9).paneScroll).toBeGreaterThan(0)
  })

  it('lets go of it, and of nothing else', () => {
    expect(scrollBarTo(state(), 5)).toEqual(state())
  })

  it('drags a panel that has two bars by whichever one is held', () => {
    const open = { ...state(), panel: extensionsPanel('jev') }
    // The page beside the list: dragged, it stops following the control the
    // keyboard was on — a page that jumps back under the pointer is unusable.
    const page = grabBar(open, { area: 'panel', total: 60, shown: 20 }, track, 12)
    expect(page.panel).toMatchObject({ kind: 'extensions', scroll: 40, following: false })
    expect(page.panel).toMatchObject({ listScroll: 0 })
    // And the list itself, which moves nothing else: what is chosen stays chosen.
    const list = grabBar(open, { area: 'panel-side', total: 40, shown: 10 }, track, 12)
    expect(list.panel).toMatchObject({ kind: 'extensions', listScroll: 30, chosen: 'jev' })
    expect(list.panel).toMatchObject({ scroll: 0 })
  })

  it('drags the one lying down by its column, and moves the region sideways', () => {
    const lying = { area: 'sidebar' as const, total: 60, shown: 20, across: true }
    const held = grabBar(state(), lying, { top: 0, rows: 20 }, 10)
    expect(held.scrolling).toMatchObject({ area: 'sidebar', across: true })
    // Sideways only: the rows it was scrolled down to are where they were.
    expect(held.scroll).toBe(0)
    expect(held.across).toBeGreaterThan(0)
    expect(scrollBarTo(held, -5).across).toBe(0)
    expect(scrollBarTo(held, 500).across).toBe(40)
    // And the picture of a plan keeps its own place, not the side's.
    const picture = grabBar(state(), { ...lying, area: 'plan' }, { top: 0, rows: 20 }, 20)
    expect(picture.planAcross).toBe(40)
    expect(picture.across).toBe(0)
  })
})

describe('moving a region sideways', () => {
  const wide = { total: 60, shown: 20 }

  it('goes right and stops at nothing of it scrolled past', () => {
    const right = scrollBy(state(), 'sidebar', 6, wide, true)
    expect(right.across).toBe(6)
    expect(scrollBy(right, 'sidebar', -20, wide, true).across).toBe(0)
    expect(scrollBy(state(), 'plan', 4, wide, true).planAcross).toBe(4)
  })

  it('leaves alone what has nowhere to go sideways', () => {
    for (const area of ['pane', 'terminal', 'transcript', 'panel'] as const) {
      expect(scrollBy(state(), area, 4, wide, true)).toEqual(state())
    }
    // And a region as wide as its pane: the bar beside it says so by having
    // no track to speak of, and the wheel over it is handed back.
    expect(scrollBy(state(), 'sidebar', 4, { total: 20, shown: 20 }, true)).toEqual(state())
  })

  it('says how far across a region is, never further than there is to go', () => {
    const moved = scrollBy(state(), 'sidebar', 50, { total: 200, shown: 20 }, true)
    expect(acrossOf(moved, 'sidebar', 60, 20)).toBe(40)
    expect(acrossOf(moved, 'sidebar', 20, 20)).toBe(0)
    expect(acrossOf(moved, 'pane', 60, 20)).toBe(0)
  })
})

describe('the one move', () => {
  // Every surface that scrolls goes through this: the wheel, a key, a drag on
  // the bar. What each region keeps its place in differs, and that is the
  // whole of what differs.
  const deep = { total: 100, shown: 10 }

  it('stops at both ends, whichever way the region counts', () => {
    expect(scrollBy(state(), 'sidebar', -5, deep).scroll).toBe(0)
    expect(scrollBy(state(), 'sidebar', 500, deep).scroll).toBe(90)
    // A screen counts back from its newest line: down is towards it.
    const back = scrollBy(state(), 'pane', -500, deep)
    expect(back.paneScroll).toBe(90)
    expect(scrollBy(back, 'pane', 500, deep).paneScroll).toBe(0)
    const conversation = scrollBy(state(), 'transcript', -500, deep)
    expect(conversation.transcriptScroll).toBe(90)
  })

  it('never runs on past the end, so coming back moves on the first notch', () => {
    // The bug this replaced: the offset went on growing past the last line
    // there was to read, because only the drawing clamped it and only on the
    // way out. A flick off the end bought a handful of notches that did
    // nothing on the way back — which is what "not smooth" felt like.
    let end = state()
    for (let i = 0; i < 40; i++) end = scrollBy(end, 'sidebar', 30, deep)
    expect(end.scroll).toBe(90)
    expect(scrollBy(end, 'sidebar', -3, deep).scroll).toBe(87)
    let back = state()
    for (let i = 0; i < 40; i++) back = scrollBy(back, 'pane', -30, deep)
    expect(back.paneScroll).toBe(90)
    expect(scrollBy(back, 'pane', 3, deep).paneScroll).toBe(87)
  })

  it('hands back what has nowhere to go, rather than swallowing it', () => {
    for (const fits of [
      { total: 10, shown: 10 },
      { total: 0, shown: 0 },
    ]) {
      expect(scrollBy(state(), 'terminal', -3, fits)).toEqual(state())
    }
    expect(scrollBy(state(), 'sidebar', 0, deep)).toEqual(state())
  })
})
