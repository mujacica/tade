import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { PlanStanding } from '@tade/core'
import type { Turn } from '@tade/voice-core'
import { describe, expect, it } from 'vitest'
import { type Hit, hitAt, sameTarget, type Target } from '../src/hits.ts'
import {
  type AppState,
  addTurn,
  focusTask,
  initialState,
  notice,
  queueEmptySays,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  showPlan,
  type TaskSnapshot,
  toggleCheck,
  toggleDone,
  toggleSection,
  viewActions,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { youSaid } from '../src/transcript.ts'
import {
  type ActionsView,
  BUTTONS,
  type CheckView,
  type CommitView,
  draw,
  type Frame,
  renderApp,
  wrapPath,
} from '../src/view.ts'

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

describe('the AGENTS heading', () => {
  const finished: TaskSnapshot[] = [...tasks, { task: 'checkout/shipped', state: 'review' }]
  const here = (over: Partial<AppState> = {}): AppState => ({
    ...withTasks(withProjects(initialState(), ['checkout', 'search']), finished),
    ...over,
  })
  /** A heading control, by what pressing it would do. */
  const control = (hits: readonly Hit[], name: string): Hit | undefined =>
    hits.find((hit) => hit.target.kind === 'action' && hit.target.name === name)
  const columns = (hit: Hit | undefined) => (hit ? hit.to - hit.from + 1 : 0)

  it('has nothing to clean up or hide while no agent has finished', () => {
    const { hits } = draw(state(), frame({ height: 40 }))
    expect(control(hits, 'new-agent')).toBeDefined()
    expect(control(hits, 'close-done')).toBeUndefined()
    expect(control(hits, 'toggle-done')).toBeUndefined()
  })

  it('offers H and X as smaller controls beside the + , on its row', () => {
    const { rows, hits } = draw(here(), frame({ height: 40 }))
    const plus = control(hits, 'new-agent')
    const hide = control(hits, 'toggle-done')
    const close = control(hits, 'close-done')
    expect(plus).toBeDefined()
    // Part of the same set: the same row, side by side, with the + last.
    expect(hide?.row).toBe(plus?.row)
    expect(close?.row).toBe(plus?.row)
    expect(plain(rows[plus?.row ?? 0] ?? '')).toContain('AGENTS')
    expect(hide?.to).toBeLessThan(close?.from ?? 0)
    expect(close?.to).toBeLessThan(plus?.from ?? 0)
    // Smaller: narrower than the button they sit beside, not as wide as it.
    expect(columns(hide)).toBeLessThan(columns(plus))
    expect(columns(close)).toBeLessThan(columns(plus))
  })

  it('draws them as the letters H and X, and nothing a font can lose', () => {
    // Glyphs that came out as a blob and a box on the machine of the person
    // who has to press them: letters are the one thing every font draws.
    const { rows, hits } = draw(here(), frame({ height: 40 }))
    const at = (hit: Hit | undefined) =>
      plain(rows[hit?.row ?? 0] ?? '').slice(hit?.from ?? 0, (hit?.to ?? -1) + 1)
    expect(at(control(hits, 'toggle-done'))).toContain('H')
    expect(at(control(hits, 'close-done'))).toContain('X')
  })

  it('fills H in while the finished agents are hidden, so pressed is plain to see', () => {
    const coloured = (state: AppState) =>
      draw(state, { ...frame({ height: 40 }), skin: COLOUR }).rows.find((row) =>
        row.includes('AGENTS'),
      ) ?? ''
    // On is the amber every other switch in the window is on in, and off is
    // as quiet as the rest of the heading — the same letter either way.
    expect(coloured(toggleDone(here()))).toContain(COLOUR.chip('H', 'primary'))
    expect(coloured(here())).toContain(COLOUR.chip('H', 'rest'))
    // And it still says which it is where there is no colour to say it with,
    // in the same columns: a terminal with NO_COLOR set is not a terminal
    // that has to guess whether its agents are hidden.
    const bare = (state: AppState) =>
      plain(draw(state, frame({ height: 40 })).rows.find((row) => row.includes('AGENTS')) ?? '')
    expect(bare(toggleDone(here()))).toContain('<H>')
    expect(bare(here())).toContain('[H]')
  })

  it('takes the finished agents out of the list when H is pressed, and keeps H', () => {
    const { rows, hits } = draw(toggleDone(here()), frame({ height: 40 }))
    expect(rows.join('\n')).not.toContain('shipped')
    expect(rows.join('\n')).toContain('refunds')
    expect(control(hits, 'toggle-done')).toBeDefined()
  })

  it('says how many of the agents it is showing while they are hidden', () => {
    // Wide enough for the badge: a narrow heading gives up its count first.
    const wide = (over: Partial<AppState> = {}) => here({ sizes: { sidebarWidth: 36 }, ...over })
    const heading = (state: AppState) =>
      plain(draw(state, frame({ height: 40 })).rows.find((row) => row.includes('AGENTS')) ?? '')
    // Nothing hidden: the count on its own, and no fraction to read.
    expect(heading(wide())).toContain('(3)')
    expect(heading(wide())).not.toContain('/')
    // Hidden: two of the three, so the badge says which two, and of what.
    expect(heading(toggleDone(wide()))).toContain('(2/3)')
  })

  it('gives up what the count is out of before the count itself', () => {
    const heading = (state: AppState) =>
      plain(draw(state, frame({ height: 40 })).rows.find((row) => row.includes('AGENTS')) ?? '')
    // Too narrow for the fraction, wide enough for the count: hiding them
    // must narrow the list, never look like the agents have gone away.
    const narrow = heading(toggleDone(here({ sizes: { sidebarWidth: 30 } })))
    expect(narrow).toContain('(2)')
    expect(narrow).not.toContain('/')
  })

  it('gives up the small controls before the button, where the sidebar is narrow', () => {
    const narrow = draw(here({ sizes: { sidebarWidth: 23 } }), frame({ height: 40 }))
    expect(control(narrow.hits, 'new-agent')).toBeDefined()
    expect(control(narrow.hits, 'close-done')).toBeUndefined()
    const wide = draw(here({ sizes: { sidebarWidth: 30 } }), frame({ height: 40 }))
    expect(control(wide.hits, 'close-done')).toBeDefined()
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

describe("what an agent's harness offers", () => {
  const route = { harness: 'claude-code', model: 'opus', provider: null }
  const vitals = { model: 'opus', thinking: 'high', contextPercent: 20 }
  const controls = (offers: Parameters<typeof draw>[1]['offers']) =>
    draw(focusTask(state(), 'checkout/refunds'), {
      ...frame({ width: 140, height: 30 }),
      route,
      vitals,
      offers,
    }).hits.flatMap((hit) => (hit.target.kind === 'action' ? [hit.target.name] : []))

  it('offers every control while nothing is known of it, as it always did', () => {
    expect(controls(null)).toContain('model:checkout/refunds')
    expect(controls(null)).toContain('thinking:checkout/refunds')
  })

  it('draws no button for what its harness cannot change', () => {
    const none = { support: 'none' as const, shown: false, note: 'cannot' }
    const shown = controls({
      harness: 'claude-code',
      accounts: true,
      model: none,
      thinking: none,
      rename: { support: 'live', shown: true, note: null },
      levels: [],
    })
    expect(shown).not.toContain('model:checkout/refunds')
    expect(shown).not.toContain('thinking:checkout/refunds')
    // The harness is still a control: moving the agent is always possible.
    expect(shown).toContain('harness:checkout/refunds')
  })
})

describe('the ACTIONS tab', () => {
  const aCommit = (over: Partial<CommitView> = {}): CommitView => ({
    sha: 'a1b2c3d4e5f6000000000000000000000000abcd',
    subject: 'move to the stripe v15 payment intents API',
    at: 0,
    task: 'checkout/refunds',
    files: 3,
    added: 48,
    removed: 12,
    ...over,
  })
  const aCheck = (over: Partial<CheckView> = {}): CheckView => ({
    id: 'tests',
    title: 'The tests',
    run: 'pnpm vitest run',
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
  })
  const actions = (over: Partial<ActionsView> = {}): ActionsView => ({
    task: 'checkout/refunds',
    branch: 'tade/refunds',
    base: 'main',
    ahead: 1,
    behind: 0,
    dirty: 0,
    shared: true,
    commit: 'a1b2c3d4e5f6000000000000000000000000abcd',
    mine: [aCommit()],
    others: [],
    review: null,
    checks: [aCheck()],
    rollup: 'unknown',
    source: 'from .tade/checks.yaml',
    adoptable: false,
    running: null,
    notes: [],
    ...over,
  })
  const page = (view: ActionsView, size: { width?: number; height?: number } = {}) =>
    renderApp(viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'), {
      ...frame(size),
      actions: view,
    }).join('\n')

  it('keeps this agent’s commits apart from everybody else’s', () => {
    const text = page(
      actions({
        others: [aCommit({ sha: '9999999', subject: 'somebody else’s work', task: 'checkout/x' })],
      }),
      { width: 140, height: 40 },
    )
    expect(text).toContain('THIS AGENT’S COMMITS')
    expect(text).toContain('ALSO ON THIS BRANCH')
    expect(text).toContain('+48')
  })

  it('says it cannot tell whose the uncommitted files are in a shared checkout', () => {
    expect(page(actions({ dirty: 4 }))).toContain('4 files not committed')
    expect(page(actions({ dirty: 4 }))).toContain('shared checkout')
    // In a worktree of its own there is nobody else to confuse it with.
    expect(page(actions({ dirty: 4, shared: false }))).toContain('its own worktree')
  })

  it('never lets a check nobody ran read as one that passed', () => {
    const text = page(actions(), { width: 140, height: 30 })
    expect(text).toContain('nobody has run these')
    expect(text).not.toContain('green')
  })

  it('says what ran, how long it took and what it counted', () => {
    const text = page(
      actions({
        rollup: 'fail',
        checks: [
          aCheck({
            state: 'failed',
            seconds: 64,
            at: 0,
            counts: [
              { label: 'failed', count: 4, tone: 'bad' },
              { label: 'passed', count: 20, tone: 'good' },
            ],
            places: [{ path: 'test/view.test.ts', at: '37:5', note: 'a name' }],
          }),
        ],
      }),
      { width: 140, height: 30 },
    )
    expect(text).toContain('pnpm vitest run')
    expect(text).toContain('1m 04s')
    expect(text).toContain('4 failed')
    expect(text).toContain('test/view.test.ts:37:5')
  })

  it('shows a run as it goes, and what it printed when a check is opened', () => {
    const going = page(
      actions({
        running: { since: 0, by: 'you', done: 1, total: 3 },
        checks: [aCheck({ state: 'running', startedAt: 0 })],
      }),
    )
    expect(going).toContain('running')
    expect(going).toContain('1 of 3')

    const view = actions({
      checks: [aCheck({ state: 'failed', tail: ['the last thing it printed'] })],
    })
    const shut = renderApp(
      viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
      { ...frame({ width: 140, height: 40 }), actions: view },
    ).join('\n')
    expect(shut).not.toContain('the last thing it printed')
    const open = renderApp(
      toggleCheck(
        viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
        'checkout/refunds',
        'tests',
      ),
      { ...frame({ width: 140, height: 40 }), actions: view },
    ).join('\n')
    expect(open).toContain('the last thing it printed')
  })

  it('fills the window exactly, however long the page is', () => {
    const view = actions({
      dirty: 12,
      mine: Array.from({ length: 9 }, (_, i) => aCommit({ sha: `${i}`.repeat(8) })),
      others: Array.from({ length: 4 }, (_, i) => aCommit({ sha: `${i}`.repeat(8), task: 'x/y' })),
      checks: [
        aCheck({ id: 'format', state: 'passed', seconds: 2 }),
        aCheck({ state: 'failed', tail: Array.from({ length: 40 }, (_, i) => `line ${i}`) }),
      ],
      notes: ['a note about what a local run does not prove'],
    })
    for (const size of [
      { width: 80, height: 24 },
      { width: 140, height: 40 },
      { width: 60, height: 14 },
      { width: 46, height: 12 },
    ]) {
      const rows = renderApp(
        toggleCheck(
          viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
          'checkout/refunds',
          'tests',
        ),
        { ...frame(size), actions: view },
      )
      expect(rows.length).toBe(size.height)
      for (const row of rows) expect(visibleWidth(row)).toBe(size.width)
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
    // The key you talk with, as keys you press: a cap has ground before it
    // and the `+` has ground either side, so a combination reads as two keys
    // rather than as one long block.
    expect(text).toContain('[ ctrl ] + [ space ]')
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

describe('notes down the side', () => {
  const at = '2026-09-03T09:00:00.000Z'
  /** The side with NOTES open: it is the one section that starts folded. */
  const side = (
    notes: readonly {
      text: string
      at: string
      summary?: string
      scope?: string | null
      by?: string
    }[],
    sidebarWidth = 40,
  ) =>
    draw(
      { ...state(), folded: ['agents', 'changes', 'files', 'where'], project: 'checkout' },
      { ...frame({ width: 120, height: 40 }), notes, layout: { sidebarWidth } },
    ).rows.map((row) => plain(row).slice(0, sidebarWidth - 1))

  it('says what a note is about over the words it was told in', () => {
    const rows = side([
      {
        text: 'refunds go through the ledger service, never the gateway',
        summary: 'Refunds via the ledger',
        at,
        scope: 'checkout',
        by: 'orchestrator',
      },
    ])
    const headline = rows.findIndex((row) => row.includes('Refunds via the ledger'))
    expect(headline).toBeGreaterThan(0)
    // The note itself, in its own words, on the line under its headline.
    expect(rows[headline + 1]).toContain('refunds go through')
    expect(rows[headline + 1]).toContain('…')
  })

  it('draws a note nobody wrote a headline for in its own words', () => {
    const rows = side([
      { text: 'the staging key rotates on the 1st', at, scope: 'checkout', by: 'window' },
    ])
    const first = rows.findIndex((row) => row.includes('the staging key'))
    expect(first).toBeGreaterThan(0)
    // Its own first words on top and the rest carrying on under them —
    // nothing here invents a headline out of what was said.
    expect(rows[first + 1]).toContain('the 1st')
    expect(rows.join('\n')).not.toContain('the staging key rotates on the 1st the staging')
  })

  it('cuts what it shows at a word, never through the middle of one', () => {
    const said = 'hovering over the purple buttons does not change them, which makes them look dead'
    const rows = side([{ text: said, summary: 'Purple buttons look dead', at, scope: 'checkout' }])
    const shown = rows.find((row) => row.includes('hovering over')) ?? ''
    expect(shown).toContain('…')
    // Every word before the ellipsis is a whole word of the note.
    const words = shown.replace('…', '').trim().split(/\s+/)
    for (const word of words) expect(said.split(/\s+/)).toContain(word)
  })

  it('says which task a note is about, where the side has room to say it', () => {
    const note = {
      text: 'the webhook retries twice',
      summary: 'Webhook retries',
      at,
      scope: 'checkout/refunds',
      by: 'orchestrator',
    }
    const wide = side([note], 44).find((row) => row.includes('the webhook retries')) ?? ''
    expect(wide).toContain('· refunds')
    // Narrow, its own words are worth more than what it is about.
    const narrow = side([note], 26).find((row) => row.includes('the webhook retries')) ?? ''
    expect(narrow).not.toContain('refunds')
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

  it('is one thing to point at: a tab, its close and its menu, and no tab moves', () => {
    const terminals = withTerminals(state(), [
      { id: 'checkout/terminals/1', project: 'checkout', name: 'tests' },
      { id: 'checkout/terminals/2', project: 'checkout', name: 'server' },
    ])
    const at = (hover: Target | null) => {
      const { rows, hits } = draw(
        { ...terminals, hover },
        { ...frame({ width: 120, height: 30 }), skin: COLOUR },
      )
      const row = rows.findIndex((each) => each.includes('orchestrator'))
      const box = (target: Target) =>
        hits.find((hit) => hit.row === row && sameTarget(hit.target, target)) ?? null
      return { text: rows[row] ?? '', box }
    }
    const tab: Target = { kind: 'bottom-tab', tab: 'checkout/terminals/1' }
    const close: Target = { kind: 'action', name: 'close-terminal:checkout/terminals/1' }
    const menu: Target = { kind: 'menu', subject: { kind: 'terminal', id: 'checkout/terminals/1' } }
    const other: Target = { kind: 'bottom-tab', tab: 'checkout/terminals/2' }

    // Nobody pointing: the buttons are not drawn, so they cannot be pressed.
    const away = at(null)
    expect(away.box(close)).toBe(null)
    expect(away.box(menu)).toBe(null)

    // On the tab, on its close, on its menu: the same three are there either
    // way, and the tab is lit under all three.
    for (const hover of [tab, close, menu]) {
      const here = at(hover)
      expect(here.box(close)).not.toBe(null)
      expect(here.box(menu)).not.toBe(null)
      // Lit, whichever of the three it is on: a tab at rest has no ground.
      expect(here.text).toContain(COLOUR.tabbed('tests', false, true))
      expect(away.text).toContain(COLOUR.tabbed('tests', false, false))
      // Nothing moved: the room the buttons take was kept while they were away.
      expect(here.box(other)?.from).toBe(away.box(other)?.from)
      expect(here.box(tab)?.from).toBe(away.box(tab)?.from)
    }
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

  it('says how long the agents have run, just before what they cost', () => {
    const rows = renderApp(state(), {
      ...frame(),
      spend: {
        tokens: 1_500,
        usd: 0.351,
        hasCost: true,
        byTask: {},
        runtime: { ms: 80 * 60_000, runs: 2, running: true },
      },
    })
    const footer = plain(rows[rows.length - 1] ?? '')
    expect(footer).toContain('1h 20m')
    // Before the cost, which is the last thing the strip gives up.
    expect(footer.indexOf('1h 20m')).toBeLessThan(footer.indexOf('$0.35'))
  })

  it('says nothing about runtime when nothing has run', () => {
    const rows = renderApp(state(), {
      ...frame(),
      spend: {
        tokens: 1_500,
        usd: 0.351,
        hasCost: true,
        byTask: {},
        runtime: { ms: 0, runs: 0, running: false },
      },
    })
    expect(plain(rows[rows.length - 1] ?? '')).not.toContain('0s')
  })

  it('keeps the cost and the runtime when the window is too narrow for the rest', () => {
    const rows = renderApp(state(), {
      ...frame({ width: 64 }),
      spend: {
        tokens: 1_500,
        usd: 0.351,
        hasCost: true,
        byTask: {},
        runtime: { ms: 80 * 60_000, runs: 2, running: true },
      },
    })
    const footer = plain(rows[rows.length - 1] ?? '')
    // The tokens go first, the time and the money stay.
    expect(footer).not.toContain('tok')
    expect(footer).toContain('1h 20m')
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

describe('the status strip', () => {
  const spending = {
    tokens: 1_500,
    usd: 0.351,
    hasCost: true,
    byTask: {},
    runtime: { ms: 80 * 60_000, runs: 2, running: true },
  }
  const strip = (over: Partial<AppState> = {}) =>
    draw(
      { ...state(), ...over },
      {
        ...frame({ width: 120 }),
        skin: COLOUR,
        spend: spending,
        orchestratorModel: 'openrouter/anthropic/claude-opus-5',
        orchestratorThinking: 'high',
      },
    )
  const foot = (drawn: { rows: string[] }) => drawn.rows[drawn.rows.length - 1] ?? ''
  /** What a link looks like: amber, and underlined right up to the words. */
  const linked = (row: string, text: string) =>
    new RegExp(`\u001b\\[4m${text.replace(/[$.]/g, '\\$&')}`).test(row)

  it('lights what today cost under the pointer, because clicking it opens the overview', () => {
    const at = strip()
    const cost = at.hits.find((hit) => hit.target.kind === 'action' && hit.target.name === 'spend')
    expect(cost).toBeDefined()
    // Quiet until pointed at — and then lit and underlined, the way the model
    // beside it says it can be clicked.
    expect(linked(foot(at), '$0.35')).toBe(false)
    const pointed = strip({ hover: { kind: 'action', name: 'spend' } })
    expect(linked(foot(pointed), '$0.35')).toBe(true)
    // The whole group is one control, so the time and the tokens light with it.
    expect(linked(foot(pointed), '1h 20m')).toBe(true)
    expect(linked(foot(pointed), 'today')).toBe(true)
  })

  it('offers the orchestrator a thinking level, lit under the pointer like its model', () => {
    const at = strip()
    expect(plain(foot(at))).toContain('high ▾')
    const level = at.hits.find(
      (hit) => hit.target.kind === 'action' && hit.target.name === 'thinking:orchestrator',
    )
    expect(level).toBeDefined()
    expect(linked(foot(at), 'high')).toBe(false)
    const pointed = strip({ hover: { kind: 'action', name: 'thinking:orchestrator' } })
    expect(linked(foot(pointed), 'high')).toBe(true)
    // Pointing at one control does not light the other.
    expect(linked(foot(pointed), 'claude-opus-5')).toBe(false)
  })

  it('says a level can be chosen even where none has been', () => {
    const drawn = draw(state(), {
      ...frame({ width: 120 }),
      orchestratorModel: 'openrouter/anthropic/claude-opus-5',
      orchestratorThinking: null,
    })
    expect(plain(foot(drawn))).toContain('thinking ▾')
  })

  it('says nothing about thinking where there is no orchestrator', () => {
    const drawn = draw(state(), frame({ width: 120 }))
    expect(plain(foot(drawn))).not.toContain('thinking ▾')
    expect(
      drawn.hits.some(
        (hit) => hit.target.kind === 'action' && hit.target.name === 'thinking:orchestrator',
      ),
    ).toBe(false)
  })
})

describe('what a subscription has left, in the strip', () => {
  const NOW = 1_800_000_000_000
  const HOUR = 3_600_000
  const spending = {
    tokens: 1_500,
    usd: 0.351,
    hasCost: true,
    byTask: {},
    runtime: { ms: 80 * 60_000, runs: 2, running: true },
  }
  const standing = (over: Partial<PlanStanding> = {}): PlanStanding => ({
    harness: 'claude-code',
    account: null,
    at: NOW - 60_000,
    cannotTell: null,
    windows: [{ label: '5h', used: 78.4, resetsAt: NOW + 2 * HOUR }],
    ...over,
  })
  const strip = (over: Partial<Frame> = {}, appState: Partial<AppState> = {}) =>
    draw(
      { ...state(), ...appState },
      {
        ...frame({ width: 120 }),
        skin: COLOUR,
        now: NOW,
        spend: spending,
        plan: [standing()],
        ...over,
      },
    )
  const foot = (drawn: { rows: string[] }) => drawn.rows[drawn.rows.length - 1] ?? ''
  /** What a link looks like: underlined right up to the words. */
  const linked = (row: string, text: string) =>
    new RegExp(`${String.fromCharCode(27)}\\[4m${text.replace(/[$.%]/g, '\\$&')}`).test(row)

  it('says how much of the window is gone and when it comes back', () => {
    const text = plain(foot(strip()))
    expect(text).toContain('5h 78%')
    expect(text).toContain('↻ 2h')
    // Its own figure, in front of the money and never folded into it.
    expect(text.indexOf('5h 78%')).toBeLessThan(text.indexOf('$0.35'))
  })

  it('opens the same overview as the money beside it, and lights with it', () => {
    const pointed = strip({}, { hover: { kind: 'action', name: 'spend' } })
    const row = foot(pointed)
    expect(linked(row, '5h 78%')).toBe(true)
    const hit = pointed.hits.find(
      (one) => one.target.kind === 'action' && one.target.name === 'spend',
    )
    expect(hit).toBeDefined()
  })

  it('says nothing at all when no harness has said', () => {
    const quiet = plain(
      foot(strip({ plan: [standing({ windows: [], at: null, cannotTell: 'has not said yet' })] })),
    )
    expect(quiet).not.toContain('5h')
    // The reason belongs on the page that has room for a sentence, not here.
    expect(quiet).not.toContain('has not said')
  })

  it('names whose plan it is only when more than one account has one', () => {
    expect(plain(foot(strip()))).not.toContain('claude-code 5h')
    const two = plain(
      foot(
        strip({
          plan: [
            standing(),
            standing({
              harness: 'codex',
              account: 'work',
              windows: [{ label: '5h', used: 91, resetsAt: NOW + HOUR }],
            }),
          ],
        }),
      ),
    )
    // The fullest is the one that stops somebody working, and it is named.
    expect(two).toContain('codex @work 5h 91%')
  })

  it('is the last figure it gives up as the window narrows', () => {
    const narrow = plain(foot(strip({ width: 64 })))
    expect(narrow).not.toContain('tok')
    // When it comes back goes before the share does: a share on its own is
    // still true, and the page it opens says the rest.
    expect(narrow).not.toContain('↻')
    expect(narrow).toContain('5h 78%')
    expect(narrow).toContain('$0.35')
  })
})

describe('the bar down the right of what scrolls', () => {
  const tall = () => ({ ...frame({ width: 100, height: 18 }), skin: COLOUR })

  it('says where in the sidebar you are, and can be taken hold of there', () => {
    const { rows, hits } = draw(state(), tall())
    const sidebar = hits.find((hit) => hit.target.kind === 'scroll')
    const width = sidebar ? sidebar.to + 1 : 0
    const bar = hits.filter(
      (hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar',
    )
    // One column of it, one hit per row, and the column it claims is the one
    // it draws in: a bar you can take hold of where it is not is worse than none.
    expect(bar.length).toBeGreaterThan(5)
    for (const hit of bar) {
      expect(hit.from).toBe(width - 1)
      expect(hit.to).toBe(width - 1)
      expect(plain(rows[hit.row] ?? '')[hit.from]).toMatch(/[\u2588\u2595]/)
    }
    // Short of room for everything the sidebar holds, it says how much is in view.
    expect(plain(rows.join('\n'))).toContain('\u2588')
  })

  it('leaves a row of room under the sidebar, and only where it scrolls', () => {
    const scrolled = draw(state({ scroll: 500 }), tall())
    const sidebar = scrolled.hits.find((hit) => hit.target.kind === 'scroll')
    const width = sidebar ? sidebar.to + 1 : 0
    // Read to the end, the last section has a blank row under it rather than
    // sitting against the strip below.
    const drawnRows = scrolled.hits
      .filter((hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar')
      .map((hit) => plain(scrolled.rows[hit.row] ?? ''))
    const text = drawnRows.map((row) => row.slice(0, width - 1))
    expect(text.at(-1)?.trim()).toBe('')
    expect(text.at(-2)?.trim()).not.toBe('')
    // The thumb is at the foot of its track: the room is part of what scrolls.
    expect(drawnRows.at(-1)?.[width - 1]).toBe('█')
    // Nothing to scroll, nothing to add: a bar that says "there is more" when
    // the more is a blank row is worse than no room at all.
    const roomy = draw(state({ folded: ['changes', 'files', 'notes', 'where'] }), {
      ...frame({ width: 100, height: 40 }),
      skin: COLOUR,
    })
    expect(plain(roomy.rows.join('\n'))).not.toContain('█')
  })

  it('says how far back a terminal goes, and marks where typing lands in it', () => {
    const terminals = {
      ...withTerminals(state(), [{ id: 'checkout/terminals/1', project: 'checkout', name: 'x' }]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal' as const,
    }
    const drawn = draw(terminals, {
      ...tall(),
      terminal: {
        screen: '$ pnpm test\n \u2713 48 tests\n$ ',
        view: { lines: 400, cursor: { back: 0, column: 2 } },
      },
    })
    const bar = drawn.hits.filter(
      (hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'terminal',
    )
    expect(bar.length).toBeGreaterThan(0)
    expect(bar.every((hit) => hit.to === 99)).toBe(true)
    // Nearly all of it is behind you, so the thumb is at the foot of its track.
    const thumb = bar.filter((hit) => plain(drawn.rows[hit.row] ?? '')[99] === '\u2588')
    expect(thumb).toHaveLength(1)
    expect(thumb[0]?.row).toBe(bar.at(-1)?.row)
    // The cursor is a block laid on the cell after the prompt, and what was
    // under it is still there.
    const row = drawn.rows.find((one) => one.includes('48;5;255'))
    expect(stripTerminalSequences(row ?? '').slice(0, 3)).toBe('$  ')
  })

  it('draws no cursor where typing would not go there', () => {
    const terminals = {
      ...withTerminals(state(), [{ id: 'checkout/terminals/1', project: 'checkout', name: 'x' }]),
      bottom: 'checkout/terminals/1',
      keyboard: 'pane' as const,
    }
    const drawn = draw(terminals, {
      ...tall(),
      terminal: { screen: '$ ', view: { lines: 40, cursor: { back: 0, column: 2 } } },
    })
    expect(drawn.rows.some((row) => row.includes('48;5;255'))).toBe(false)
  })
})

describe('the smart queue', () => {
  // A plan under way: one held, what waits on it, and one that only needs room.
  const plan: TaskSnapshot[] = [
    { task: 'checkout/fix-charge', state: 'failed', reason: 'tests failed twice' },
    {
      task: 'checkout/add-refunds',
      state: 'queued',
      queued: {
        state: { kind: 'held', on: 'checkout/fix-charge', because: 'checkout/fix-charge failed' },
        after: [{ task: 'checkout/fix-charge', why: 'both change charge.ts' }],
        prompt: 'add refunds',
        touches: [],
        at: null,
      },
    },
    {
      task: 'checkout/refund-emails',
      state: 'queued',
      queued: {
        state: { kind: 'waiting', on: ['checkout/add-refunds'] },
        after: [{ task: 'checkout/add-refunds', why: 'it emails what refund() returns' }],
        prompt: 'email the customer',
        touches: [],
        at: null,
      },
    },
    {
      task: 'checkout/docs-typos',
      state: 'queued',
      queued: { state: { kind: 'ready' }, after: [], prompt: 'fix typos', touches: [], at: null },
    },
  ]

  const queued = (over: Partial<AppState> = {}): AppState => ({
    ...withTasks(withProjects(initialState(), ['checkout']), plan),
    project: 'checkout',
    folded: ['changes', 'files', 'notes', 'where'],
    ...over,
  })

  it('shifts each piece right of what it waits on, and joins them with a line', () => {
    const rows = renderApp(queued(), frame({ width: 100, height: 40 })).map(plain)
    const side = (name: string) => rows.findIndex((row) => row.includes(name))
    // Down the side in the order the tree gives: the held one, what waits on
    // it under it, then the work that only waits for room.
    expect(side('add-refunds')).toBeLessThan(side('refund-emails'))
    expect(side('refund-emails')).toBeLessThan(side('docs-typos'))
    const child = rows[side('refund-emails')] ?? ''
    // Hanging off what it waits on, and further right than it.
    expect(child).toContain('╰─')
    expect(child.indexOf('refund-emails')).toBeGreaterThan(
      (rows[side('add-refunds')] ?? '').indexOf('add-refunds'),
    )
    // The line carries on through the room between the two tabs.
    expect(
      rows.slice(side('add-refunds'), side('refund-emails')).some((row) => row.includes('│')),
    ).toBe(true)
  })

  it('puts a piece in the column its priority gives it, however deep the chain', () => {
    // Six deep, in a side too narrow for the indent alone.
    const deep: TaskSnapshot[] = [
      { task: 'keys/one', state: 'working', lane: 'keys/one/agent' },
      ...['two', 'three', 'four', 'five', 'six'].map((task, i) => ({
        task: `keys/${task}`,
        state: 'queued' as const,
        queued: {
          state: {
            kind: 'waiting' as const,
            on: [`keys/${['one', 'two', 'three', 'four', 'five'][i]}`],
          },
          after: [
            { task: `keys/${['one', 'two', 'three', 'four', 'five'][i]}`, why: 'it follows' },
          ],
          prompt: 'do it',
          touches: [],
          at: null,
        },
      })),
    ]
    const state: AppState = {
      ...withTasks(withProjects(initialState(), ['keys']), deep),
      project: 'keys',
      folded: ['changes', 'files', 'notes', 'where'],
    }
    const drawn = draw(state, frame({ width: 96, height: 44 }))
    const rows = drawn.rows.map(plain)
    const at = (name: string) => {
      const row = rows.find((one) => one.includes(`◌ ${name}`)) ?? ''
      return row.indexOf(`◌ ${name}`)
    }
    // A column each, all the way down: never two of them folded into one.
    const columns = ['two', 'three', 'four', 'five', 'six'].map(at)
    for (const column of columns) expect(column).toBeGreaterThan(0)
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i]).toBe((columns[i - 1] ?? 0) + 2)
    }
    // Which means the tree reaches past the side, so there is a bar to reach
    // the rest of it — and it lies along the bottom of the side.
    const bar = drawn.hits.filter(
      (hit) =>
        hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar' && hit.target.across,
    )
    expect(bar.length).toBe(1)

    // Dragged sideways, every row moves by the same columns: the tree keeps
    // its shape, and the names the indent had pushed off the edge arrive.
    const moved = draw({ ...state, across: 8 }, frame({ width: 96, height: 44 })).rows.map(plain)
    const rowOf = (name: string) => rows.findIndex((one) => one.includes(`◌ ${name}`))
    // The deepest one, which the indent had pushed furthest right, is eight
    // columns further left — mark, stem and all.
    const last = rowOf('six')
    expect((rows[last] ?? '').indexOf('◌ six') - (moved[last] ?? '').indexOf('◌ six')).toBe(8)
    // And nothing went the other way: the whole tree moved together.
    for (const name of ['two', 'three', 'four', 'five']) {
      const row = rowOf(name)
      const before = (rows[row] ?? '').indexOf(name)
      const after = (moved[row] ?? '').indexOf(name)
      expect(after).toBeLessThan(before)
    }
  })

  it('never puts a bar along the bottom of a side whose tree already fits', () => {
    const drawn = draw(queued(), frame({ width: 140, height: 44 }))
    expect(
      drawn.hits.some(
        (hit) =>
          hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar' && hit.target.across,
      ),
    ).toBe(false)
  })

  it('draws the chain a piece of queued work is in, and lets you click along it', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 140, height: 44 }),
    })
    const text = drawn.rows.map(plain).join('\n')
    expect(text).toContain('THE CHAIN IT IS IN')
    // A box per piece of the path, the one in front of you drawn heavier.
    expect(text).toContain('┏')
    expect(text).toContain('fix-charge')
    expect(text).toContain('WHY IT WAITS')
    expect(text).toContain('it emails what refund() returns')
    // Every box in the chain is a way to go to what it is a box of.
    const drawnBoxes = new Set(
      drawn.rows
        .map((row, i) => (/[╭┏][─━]{3}/.test(plain(row)) ? i : -1))
        .filter((row) => row >= 0),
    )
    expect(drawnBoxes.size).toBeGreaterThan(0)
    const clicks = drawn.hits.filter(
      (hit) =>
        hit.target.kind === 'task' &&
        hit.target.task === 'checkout/fix-charge' &&
        drawnBoxes.has(hit.row),
    )
    expect(clicks.length).toBeGreaterThan(0)
  })

  it('says why it waits as the chain it is, in the order it runs', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 140, height: 44 }),
    })
    // What the middle of the window holds, without the sidebar beside it.
    const rows = drawn.rows.map((row) => plain(row).replace(/^.*?[▕█]│/, ''))
    const from = rows.findIndex((row) => row.includes('WHY IT WAITS'))
    const why = rows.slice(from + 1, from + 6).map((row) => row.slice(2).trimEnd())
    // The front of the chain first, then what waits on it, shifted right of it
    // and joined to it — never a flat list in whatever order the names fell in.
    expect(why.slice(0, 5)).toEqual([
      '✕ fix-charge',
      '╰─! add-refunds  after fix-charge',
      '  │ both change charge.ts',
      '  ╰─◌ refund-emails  after add-refunds',
      '      it emails what refund() returns',
    ])
    // Each name in it goes to the work it names.
    const at = drawn.hits.filter(
      (hit) =>
        hit.row === from + 2 &&
        hit.target.kind === 'task' &&
        hit.target.task === 'checkout/add-refunds',
    )
    expect(at.length).toBeGreaterThan(0)
  })

  it('wraps a wait’s reason into a narrow panel rather than off the edge', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 74, height: 44 }),
    })
    const rows = drawn.rows.map(plain)
    const from = rows.findIndex((row) => row.includes('WHY IT WAITS'))
    expect(from).toBeGreaterThan(0)
    // It is still the tree, and every row of it still fits the window.
    expect(rows.slice(from).some((row) => row.includes('╰─◌ refund-emails'))).toBe(true)
    for (const row of drawn.rows) expect(visibleWidth(row)).toBe(74)
  })

  it('keeps the boxes when the chain is wider than the pane, and a bar to reach the rest', () => {
    const state = focusTask(queued(), 'checkout/refund-emails')
    const drawn = draw(state, { ...frame({ width: 74, height: 44 }) })
    const rows = drawn.rows.map(plain)
    // Three tight boxes and the room between them are more than this pane
    // has — and they are drawn anyway, heading, arrows and all.
    expect(rows.some((row) => row.includes('THE CHAIN IT IS IN'))).toBe(true)
    expect(rows.some((row) => row.includes('╭───'))).toBe(true)
    // Never the flat list of names it used to fall back to.
    expect(rows.some((row) => row.includes('WAITS ON'))).toBe(false)
    const bar = drawn.hits.filter(
      (hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'plan',
    )
    expect(bar.length).toBe(1)
    expect(bar[0]?.target).toMatchObject({ across: true })

    // Dragged sideways, the picture moves and the far end of the chain arrives.
    const far = draw({ ...state, planAcross: 40 }, { ...frame({ width: 74, height: 44 }) })
    const seen = far.rows.map(plain)
    expect(seen.some((row) => row.includes('refund-emails'))).toBe(true)
    expect(seen.join('\n')).not.toBe(rows.join('\n'))
    for (const row of far.rows) expect(visibleWidth(row)).toBe(74)
  })

  it('offers the plan on its heading, and only where there is a plan', () => {
    // The whole route into the plan view, held to end to end: the heading
    // offers `queue-plan`, and `queue-plan` is what shows the plan. It was
    // built as `action` where `Section` has `actions` — a key a spread let
    // through unchecked — so the button was never drawn and the view behind
    // it could not be reached at all.
    const plan: Target = { kind: 'action', name: 'queue-plan' }
    const drawn = draw(queued(), frame({ width: 160, height: 40 }))
    const offered = drawn.hits.find((hit) => sameTarget(hit.target, plan))
    expect(offered).toBeDefined()
    // On the heading, where the section it belongs to is.
    const heading = drawn.rows.findIndex((row) => plain(row).includes('SMART QUEUE'))
    expect(offered?.row).toBe(heading)
    expect(plain(drawn.rows[heading] ?? '')).toContain('plan')

    // Pressed, it draws the plan where an agent's screen was.
    const rows = renderApp(showPlan(queued()), frame({ width: 160, height: 40 })).map(plain)
    expect(rows.some((row) => row.includes('checkout › plan'))).toBe(true)

    // Work that waits on nothing and that nothing waits on is not a plan, and
    // then there is nothing to offer.
    const alone = draw(
      queued({
        ...withTasks(withProjects(initialState(), ['checkout']), [
          { task: 'checkout/docs-typos', state: 'working', lane: 'checkout/docs-typos/agent' },
        ]),
      }),
      frame({ width: 160, height: 40 }),
    )
    expect(alone.hits.some((hit) => sameTarget(hit.target, plan))).toBe(false)
  })

  it('is there with nothing in it, folded, and its heading says why', () => {
    // Nothing queued and nothing scheduled: the section used to be missing
    // altogether, which is the thing a person cannot find when they look.
    const quiet = { ...state(), folded: ['changes', 'files', 'notes', 'where'] }
    const rows = renderApp(quiet, frame({ width: 160, height: 40 })).map(plain)
    const heading = rows.find((row) => row.includes('SMART QUEUE')) ?? ''
    expect(heading).toContain('▸ SMART QUEUE')
    // In the words of the reason it actually is, not one sentence for every case.
    expect(heading).toContain(queueEmptySays(quiet))
    // Folded is one row and no more: nothing of the list under it.
    expect(rows.filter((row) => row.includes('SMART QUEUE')).length).toBe(1)
  })

  it('says as much of why as a narrow side has room for, never nothing at all', () => {
    const quiet = { ...state(), folded: ['changes', 'files', 'notes', 'where'] }
    const heading = (width: number) =>
      renderApp(quiet, frame({ width, height: 40 }))
        .map(plain)
        .find((row) => row.includes('SMART QUEUE')) ?? ''
    // A side too narrow for the sentence still says the count in words.
    expect(heading(100)).toMatch(/SMART QUEUE +none/)
    expect(heading(160)).toContain('nothing is queued')
  })

  it('opens where it is pressed, and what it opened stays open with nothing in it', () => {
    const quiet = { ...state(), folded: ['changes', 'files', 'notes', 'where'] }
    const drawn = draw(quiet, frame({ width: 160, height: 40 }))
    const at = drawn.hits.find(
      (hit) => hit.target.kind === 'section' && hit.target.section === 'queue',
    )
    // The heading carries what the drawing found, so the press and the paint
    // can never read the emptiness differently.
    expect(at?.target).toEqual({ kind: 'section', section: 'queue', quiet: true })
    const open = toggleSection(quiet, 'queue', true)
    expect(open.opened).toContain('queue')
    const after = renderApp(open, frame({ width: 160, height: 40 })).map(plain)
    expect(after.some((row) => row.includes('▾ SMART QUEUE'))).toBe(true)
    // And the reason is the whole of what the open section is for.
    expect(after.some((row) => row.includes('nothing is queued'))).toBe(true)
  })

  it('stays folded when you fold it with work waiting in it', () => {
    const shut = toggleSection(queued(), 'queue', false)
    expect(shut.folded).toContain('queue')
    const rows = renderApp(shut, frame({ width: 100, height: 40 })).map(plain)
    // The count stays on the heading: what was put away is still there.
    expect(rows.find((row) => row.includes('SMART QUEUE'))).toMatch(/▸ SMART QUEUE +\(?3\)?/)
    expect(rows.some((row) => row.includes('add-refunds'))).toBe(false)
  })
})
