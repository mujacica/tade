import type { WilcoEvent } from '@wilco/core'
import type { Turn } from '@wilco/voice-core'
import { describe, expect, it } from 'vitest'
import {
  type AppState,
  addTurn,
  FOCUS_GUARD_MS,
  focusBy,
  focusTask,
  glyph,
  headline,
  initialState,
  keyAction,
  noteTyping,
  onEvent,
  parseCommand,
  projects,
  selectProject,
  setDictation,
  setListening,
  sidebar,
  type TaskSnapshot,
  TURN_HISTORY,
  tasksOf,
  whichProject,
  withProjects,
  withTasks,
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

const event = (over: Partial<WilcoEvent> = {}): WilcoEvent => ({
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
    // to Wilco, and leaving it out left a window with no tasks unusable.
    current = focusBy(current, 1)
    expect(current.focused).toBeNull()
    current = focusBy(current, 1)
    expect(current.focused).toBe('checkout/stripe-v15')
    expect(focusBy(current, -1).focused).toBeNull()
  })

  it('has somewhere to go even with no tasks at all', () => {
    // Which is the window everybody sees first.
    const empty = { ...state(), panes: [], focused: null }
    expect(focusBy(empty, 1).focused).toBeNull()
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

  it('gives each state its own glyph', () => {
    const glyphs = state().panes.map(glyph)
    expect(new Set(glyphs).size).toBe(3)
    expect(glyph({ ...state().panes[1]!, waiting: true })).toBe('●')
  })

  it('says what is waiting, and whether it is listening', () => {
    expect(headline(state())).toBe('1 waiting')
    expect(headline(setListening(state(), true))).toBe('⏺ listening · 1 waiting')
  })

  it('keeps the conversation bounded', () => {
    let current = state()
    for (let i = 0; i < TURN_HISTORY + 20; i++) {
      current = addTurn(current, turn(`utterance ${i}`))
    }
    expect(current.turns.length).toBe(TURN_HISTORY)
    expect(current.turns[0]?.utterance).toBe('utterance 20')
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
    expect(parseCommand('/task fix the double charge')).toEqual({
      name: '/task',
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

function turn(utterance: string): Turn {
  return { utterance, intent: 'status', reply: 'fine', at: NOW }
}
