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
  setDictation,
  setListening,
  sidebar,
  type TaskSnapshot,
  TURN_HISTORY,
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

  it('cycles through panes in both directions, wrapping', () => {
    let current = state()
    expect(current.focused).toBe('checkout/stripe-v15')
    current = focusBy(current, 1)
    expect(current.focused).toBe('checkout/refunds')
    current = focusBy(current, 1)
    expect(current.focused).toBe('search/pagination')
    current = focusBy(current, 1)
    expect(current.focused).toBe('checkout/stripe-v15')
    expect(focusBy(current, -1).focused).toBe('search/pagination')
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
