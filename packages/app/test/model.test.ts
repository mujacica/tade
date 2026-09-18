import { IDLE_REASON, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  type AgentPane,
  type AppState,
  dragAgent,
  dropAgent,
  FOCUS_GUARD_MS,
  focusBy,
  focusNumber,
  focusTask,
  glyph,
  headline,
  historyMatch,
  initialState,
  keyAction,
  laneShown,
  markOf,
  noteTyping,
  onEvent,
  parseCommand,
  projectNumber,
  projects,
  type QueuedView,
  queuedCount,
  queueOf,
  removeAttachment,
  resizeTo,
  searchKey,
  selectProject,
  setDictation,
  setListening,
  showOrchestrator,
  showTerminal,
  sidebar,
  splitPane,
  splitRatio,
  splitShown,
  startHistorySearch,
  swapSplit,
  type TaskSnapshot,
  tasksOf,
  terminalsOf,
  turnSplit,
  typingLane,
  unsplitPane,
  whichProject,
  withProjects,
  withTasks,
  withTerminals,
} from '../src/model.ts'

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

  it('shows what waits on agents, or what waits for a time', () => {
    const state = withTasks(initialState(), plan)
    const shown = (queueFilter: AppState['queueFilter']) =>
      queueOf({ ...state, queueFilter }).map((task) => task.name)
    expect(shown('timed')).toEqual(['soon', 'later'])
    expect(shown('next')).toEqual(['stuck', 'next', 'after', 'stopped'])
    // Filtered away is not gone: the count is still all of it.
    expect(queuedCount({ ...state, queueFilter: 'timed' })).toBe(6)
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
