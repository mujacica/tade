import { visibleWidth } from '@earendil-works/pi-tui'
import type { Turn } from '@tade/voice-core'
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
  withTerminals,
  withTranscript,
} from '../src/model.ts'
import { youSaid } from '../src/transcript.ts'
import { BUTTONS, draw, renderApp, wrapPath } from '../src/view.ts'

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
    // Tall enough for FILES: agents are two-line tabs, and the sidebar scrolls.
    const { rows, hits } = draw(state(), {
      ...frame({ height: 40 }),
      files: [
        { path: 'src', name: 'src', depth: 0, folder: true, open: false },
        { path: 'README.md', name: 'README.md', depth: 0, folder: false, open: false },
      ],
    })
    // Counted by what they are, not by how many regions a control spans.
    const kinds = (kind: string) =>
      new Set(
        hits.filter((hit) => hit.target.kind === kind).map((hit) => JSON.stringify(hit.target)),
      )
    expect(kinds('project').size).toBe(2)
    expect(kinds('task').size).toBe(2)
    // The headings in view: the sidebar scrolls, and a short one has notes and git below it.
    for (const section of ['agents', 'changes', 'files']) {
      expect(kinds('section').has(JSON.stringify({ kind: 'section', section }))).toBe(true)
    }
    expect(kinds('folder').size).toBe(1)
    // Every button in the footer is there.
    for (const button of BUTTONS) {
      expect(kinds('action').has(JSON.stringify({ kind: 'action', name: button.action }))).toBe(
        true,
      )
    }
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
    expect(text).toContain('no agent is running')
  })

  it('says when it is waiting on you, by the mark the list uses for it', () => {
    const text = renderApp(state(), frame()).join('\n')
    expect(text).toContain('! 1')
  })
})

describe('the orchestrator strip', () => {
  it('is always there, even with nothing said yet', () => {
    const text = renderApp(state(), frame()).join('\n')
    expect(text).toContain('orchestrator')
    // The key you talk with, as keys you press.
    expect(text).toContain('[ ctrl ]+[ space ]')
  })

  it('shows what was heard, where it went and why', () => {
    const said = withTranscript(state(), youSaid(state().transcript, 'park the stripe one', 0))
    const text = renderApp(addTurn(said, turn()), frame()).join('\n')
    expect(text).toContain('park the stripe one')
    expect(text).toContain('checkout/stripe-v15')
    expect(text).toContain('you mentioned it last')
    expect(text).toContain('parked stripe-v15')
  })

  it('keeps the most recent exchange when there are many', () => {
    let current = state()
    for (let i = 0; i < 30; i++) {
      current = withTranscript(current, youSaid(current.transcript, `said ${i}`, 0))
      current = addTurn(current, turn({ utterance: `said ${i}` }))
    }
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
    expect(renderApp(setDictation(state(), ''), frame()).join('\n')).toContain(' ▏')
  })

  it('marks the line differently while the microphone is open', () => {
    // The same line either way, but one of them is recording you, and that is
    // not a thing to have to infer.
    const talking = setListening(setDictation(state(), ''), true)
    expect(renderApp(talking, frame()).join('\n')).toContain('◉')
  })

  it('offers the commands as you type a slash', () => {
    const rows = renderApp(setDictation(state(), '/n'), frame()).join('\n')
    expect(rows).toContain('/new')
    // Narrowed: a list that does not shrink as you type is a list you scroll.
    expect(rows).not.toContain('/settings')
  })

  it('says what to do when there is nothing to show yet', () => {
    const empty = { ...state(), panes: [], focused: null }
    const rows = renderApp(empty, frame()).join('\n')
    // The window everybody sees first has to say what to do next.
    expect(rows).toContain('[ + New agent ]')
    expect(rows).toContain('[ Open project ]')
  })

  it('shows keystrokes held back at an agent prompt', () => {
    // Held, not dropped: they have to be visible or they look like lost input.
    const rows = renderApp(setHeld(state(), 'tade par'), frame())
    expect(rows.join('\n')).toContain('tade par')
    for (const row of rows) expect(visibleWidth(row)).toBe(80)
  })

  it('shows that it is listening', () => {
    expect(renderApp(setListening(setDictation(state(), ''), true), frame()).join('\n')).toContain(
      '◉',
    )
  })

  it('shows the latest news', () => {
    expect(renderApp(notice(state(), 'refunds needs you'), frame()).join('\n')).toContain(
      'refunds needs you',
    )
  })
})

describe('the path under GIT', () => {
  it('breaks after a slash, and inside a name only when the name is longer than a line', () => {
    expect(wrapPath('/Users/me/src/checkout', 14)).toEqual(['/Users/me/src/', 'checkout'])
    expect(wrapPath('/a/averyveryverylongname', 8)).toEqual([
      '/a/',
      'averyver',
      'yverylon',
      'gname',
    ])
  })

  it('is whole, from your home, and opens its folder when clicked', () => {
    const where = {
      repo: '~/tade',
      branch: 'main',
      base: null,
      worktree: null,
      path: '/Users/me/tade',
      shownPath: '~/tade',
    }
    const { rows, hits } = draw(
      { ...state(), folded: ['agents', 'changes', 'files', 'notes'] },
      { ...frame({ width: 140 }), where },
    )
    expect(rows.join('\n')).toMatch(/path +~\/tade/)
    expect(
      hits.some((hit) => hit.target.kind === 'action' && hit.target.name === 'open-path'),
    ).toBe(true)
  })
})

describe('an agent pane', () => {
  it('sits at the bottom, like a conversation, however little the agent has drawn', () => {
    const screen = ['pi v0.85', '', '> fix the refunds', '', '', ''].join('\n')
    const { rows } = draw(state(), { ...frame({ height: 30 }), screen })
    const body = rows.slice(4, 26).map((row) => row.split('│')[1] ?? '')
    const last = body.map((row) => row.trim()).filter((row) => row !== '')
    expect(last.at(-1)).toContain('> fix the refunds')
    // Nothing drawn under it: the blank lines pi left below were not kept.
    const at = body.findIndex((row) => row.includes('> fix the refunds'))
    expect(
      body.slice(at + 1).every((row) => row.trim() === '' || row.includes('orchestrator')),
    ).toBe(true)
  })
})

describe('the bottom panel and its handles', () => {
  it('has a tab for the orchestrator and each terminal, + for another, and a rule to drag', () => {
    const terminals = withTerminals(state(), [
      { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
    ])
    const { rows, hits } = draw(
      { ...terminals, bottom: 'checkout/terminals/1' },
      {
        ...frame({ width: 120, height: 30 }),
        terminal: { screen: '$ pnpm test\n ok' },
      },
    )
    const tabs = hits
      .filter((hit) => hit.target.kind === 'bottom-tab')
      .map((hit) => JSON.stringify(hit.target))
    expect(new Set(tabs)).toEqual(
      new Set([
        JSON.stringify({ kind: 'bottom-tab', tab: 'orchestrator' }),
        JSON.stringify({ kind: 'bottom-tab', tab: 'checkout/terminals/1' }),
      ]),
    )
    expect(hits.some((hit) => hit.target.kind === 'divider' && hit.target.edge === 'bottom')).toBe(
      true,
    )
    expect(hits.some((hit) => hit.target.kind === 'divider' && hit.target.edge === 'sidebar')).toBe(
      true,
    )
    expect(
      hits.some((hit) => hit.target.kind === 'action' && hit.target.name === 'new-terminal'),
    ).toBe(true)
    // The terminal's screen is what shows, and clicking it is for typing into.
    expect(rows.join('\n')).toContain('$ pnpm test')
    expect(hits.some((hit) => hit.target.kind === 'terminal')).toBe(true)
  })

  it('folds to its tabs and fills the window when asked', () => {
    const folded = draw({ ...state(), bottomMode: 'min' }, frame({ width: 120, height: 30 }))
    const opened = draw(state(), frame({ width: 120, height: 30 }))
    const tabRow = (rows: string[]) => rows.findIndex((row) => row.includes('orchestrator'))
    expect(tabRow(folded.rows)).toBeGreaterThan(tabRow(opened.rows))
    expect(tabRow(folded.rows)).toBe(30 - 3)
  })
})

describe('agent spend', () => {
  it('shows in the status bar when money was spent, even with zero tokens', () => {
    const rows = renderApp(state(), {
      ...frame(),
      spend: { tokens: 0, usd: 0.351, hasCost: true, byTask: {} },
    })
    const footer = plain(rows[rows.length - 1] ?? '')
    expect(footer).toContain('today')
    expect(footer).toContain('$0.35')
  })

  it('shows in the task list when an agent has spent money', () => {
    const focused = focusTask(state(), 'search/pagination')
    const rows = renderApp(focused, {
      ...frame(),
      spend: {
        tokens: 1_500,
        usd: 0.351,
        hasCost: true,
        byTask: { 'search/pagination': { tokens: 1_500, usd: 0.351 } },
      },
    })
    const text = plain(rows.join('\n'))
    expect(text).toContain('pagination')
    expect(text).toContain('$0.35')
  })
})
