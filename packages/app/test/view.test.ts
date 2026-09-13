import { visibleWidth } from '@earendil-works/pi-tui'
import type { Turn } from '@wilco/voice-core'
import { describe, expect, it } from 'vitest'
import { hitAt } from '../src/hits.ts'
import {
  type AppState,
  addTurn,
  focusTask,
  initialState,
  notice,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { BUTTONS, draw, renderApp, renderTurn } from '../src/view.ts'

/** The same row without its colour, for comparing positions against columns. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

// The geometry contract matters more than the wording: a row that is not
// exactly as wide as the window, or a frame with the wrong number of rows,
// corrupts the whole screen.

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
  ...withTasks(withProjects(initialState(), ['checkout', 'search']), tasks),
  ...over,
})

const frame = (over: Partial<{ width: number; height: number; screen: string }> = {}) => ({
  width: 80,
  height: 24,
  screen: '',
  ...over,
})

const turn = (over: Partial<Turn> = {}): Turn => ({
  utterance: 'park the stripe one',
  intent: 'park',
  task: 'checkout/stripe-v15',
  why: 'you mentioned it last',
  reply: 'parked stripe-v15',
  at: 0,
  ...over,
})

describe('the frame', () => {
  it('fills the window exactly, at any size', () => {
    for (const size of [
      { width: 80, height: 24 },
      { width: 120, height: 40 },
      { width: 40, height: 12 },
      { width: 200, height: 60 },
    ]) {
      const rows = renderApp(state(), frame(size))
      expect(rows.length).toBe(size.height)
      for (const row of rows) expect(visibleWidth(row)).toBe(size.width)
    }
  })

  it('stays whole when an agent screen is wider and taller than the window', () => {
    const screen = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(300)} line ${i}`).join('\n')
    const rows = renderApp(state(), frame({ screen }))
    expect(rows.length).toBe(24)
    for (const row of rows) expect(visibleWidth(row)).toBe(80)
  })

  it('survives a window too small to be reasonable', () => {
    const rows = renderApp(state(), frame({ width: 10, height: 3 }))
    expect(rows.length).toBeGreaterThan(0)
    const width = visibleWidth(rows[0] ?? '')
    for (const row of rows) expect(visibleWidth(row)).toBe(width)
  })
})

describe('the tabs', () => {
  it('has a tab for every project, and lists the tasks of the one you are in', () => {
    const text = renderApp(state(), frame()).join('\n')
    expect(text).toContain('checkout')
    expect(text).toContain('search')
    expect(text).toContain('stripe-v15')
    expect(text).toMatch(/▌.*stripe-v15/)
    // The other project's tasks are behind its tab, not mixed in with these.
    expect(text).not.toContain('pagination')
  })

  it('shows a project with no tasks in it yet, because that is where you start one', () => {
    const empty = withProjects(initialState(), ['checkout', 'infra'])
    const text = renderApp(empty, frame()).join('\n')
    expect(text).toContain('infra')
    expect(text).toContain('+')
  })

  it('follows the focus into the other project', () => {
    const text = renderApp(focusTask(state(), 'search/pagination'), frame()).join('\n')
    expect(text).toMatch(/▌.*pagination/)
    expect(text).not.toContain('stripe-v15')
  })
})

describe('what is clickable', () => {
  it('puts a hit on every tab, task, file and button', () => {
    const { rows, hits } = draw(state(), { ...frame(), files: ['src/', 'README.md'] })
    const at = (target: string) => hits.filter((hit) => hit.target.kind === target)
    expect(at('project').length).toBe(2)
    expect(at('task').length).toBe(2)
    expect(at('file').length).toBe(2)
    expect(at('action').length).toBeGreaterThan(BUTTONS.length - 1)
    // Every hit has to land on a row that exists, or it is a click into space.
    for (const hit of hits) expect(hit.row).toBeLessThan(rows.length)
  })

  it('reads back what is under a click', () => {
    const { hits } = draw(state(), frame())
    const task = hits.find((hit) => hit.target.kind === 'task')
    expect(task).toBeDefined()
    if (task) expect(hitAt(hits, task.from, task.row)).toEqual(task.target)
    expect(hitAt(hits, 0, 9_000)).toBeNull()
  })

  it('puts the button where its label is written', () => {
    const { rows, hits } = draw(state(), frame())
    for (const hit of hits) {
      if (hit.target.kind !== 'action' || !hit.target.name.startsWith('/set')) continue
      const row = rows[hit.row] ?? ''
      // Compared without colour: the hit is a position, and a painted row has
      // more bytes than columns.
      expect(plain(row).slice(hit.from, hit.to + 1)).toContain('settings')
    }
  })
})

describe('the focused agent', () => {
  it('shows the newest output, not the oldest', () => {
    const screen = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const text = renderApp(state(), frame({ screen })).join('\n')
    // Tailing is the whole point: what an agent just said is what you need.
    expect(text).toContain('line 99')
    expect(text).not.toContain('line 0\n')
  })

  it('says so when there is no screen to show', () => {
    const text = renderApp(focusTask(state(), 'search/pagination'), frame()).join('\n')
    expect(text).toContain('no screen attached')
  })

  it('says when it is waiting on you', () => {
    const text = renderApp(state(), frame()).join('\n')
    expect(text).toContain('waiting on you')
  })
})

describe('the orchestrator strip', () => {
  it('is always there, even with nothing said yet', () => {
    const text = renderApp(state(), frame()).join('\n')
    expect(text).toContain('orchestrator')
    expect(text).toContain('ctrl+space')
  })

  it('shows what was heard, where it went and why', () => {
    const text = renderApp(addTurn(state(), turn()), frame()).join('\n')
    expect(text).toContain('park the stripe one')
    expect(text).toContain('checkout/stripe-v15')
    expect(text).toContain('you mentioned it last')
    expect(text).toContain('parked stripe-v15')
  })

  it('keeps the most recent exchange when there are many', () => {
    let current = state()
    for (let i = 0; i < 30; i++) current = addTurn(current, turn({ utterance: `said ${i}` }))
    const text = renderApp(current, frame()).join('\n')
    expect(text).toContain('said 29')
    expect(text).not.toContain('said 0 ')
  })

  it('puts a question where you cannot miss it', () => {
    const asked = setQuestion(state(), {
      question: 'which one did you mean?',
      candidates: ['checkout/refunds', 'checkout/stripe-v15'],
    })
    const text = renderApp(asked, frame()).join('\n')
    expect(text).toContain('which one did you mean?')
    expect(text).toContain('checkout/refunds')
  })

  it('shows what is being dictated as it is typed', () => {
    const rows = renderApp(setDictation(state(), 'park the stripe'), frame())
    const text = rows.join('\n')
    expect(text).toContain('park the stripe')
    // Still exactly the window's width, cursor and all.
    for (const row of rows) expect(visibleWidth(row)).toBe(80)
  })

  it('shows the line the moment it opens, before anything is said', () => {
    expect(renderApp(setDictation(state(), ''), frame()).join('\n')).toContain('❯')
  })

  it('marks the line differently while the microphone is open', () => {
    // The same line either way, but one of them is recording you, and that is
    // not a thing to have to infer.
    const talking = setListening(setDictation(state(), ''), true)
    expect(renderApp(talking, frame()).join('\n')).toContain('◉')
  })

  it('offers the commands as you type a slash', () => {
    const rows = renderApp(setDictation(state(), '/t'), frame()).join('\n')
    expect(rows).toContain('/task')
    // Narrowed: a list that does not shrink as you type is a list you scroll.
    expect(rows).not.toContain('/settings')
  })

  it('says what to do when there is nothing to show yet', () => {
    const empty = { ...state(), panes: [], focused: null }
    const rows = renderApp(empty, frame()).join('\n')
    // The window everybody sees first has to say what to do next.
    expect(rows).toContain('/task')
    expect(rows).not.toContain('nothing to show')
  })

  it('shows keystrokes held back at an agent prompt', () => {
    // Held, not dropped: they have to be visible or they look like lost input.
    const rows = renderApp(setHeld(state(), 'wilco par'), frame())
    expect(rows.join('\n')).toContain('wilco par')
    for (const row of rows) expect(visibleWidth(row)).toBe(80)
  })

  it('shows that it is listening', () => {
    expect(renderApp(setListening(state(), true), frame()).join('\n')).toContain('listening')
  })

  it('shows the latest news', () => {
    expect(renderApp(notice(state(), 'refunds needs you'), frame()).join('\n')).toContain(
      'refunds needs you',
    )
  })
})

describe('renderTurn', () => {
  it('reads as one exchange', () => {
    expect(renderTurn(turn(), 80)).toEqual([
      ' ❯ park the stripe one',
      '   → park · checkout/stripe-v15 · "you mentioned it last"',
      '   parked stripe-v15',
    ])
  })

  it('leaves out what it does not have', () => {
    expect(renderTurn(turn({ task: null, why: null, reply: '' }), 80)).toEqual([
      ' ❯ park the stripe one',
      '   → park',
    ])
  })
})
