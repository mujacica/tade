import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { noRuntime } from '@tade/core'
import type { Turn } from '@tade/voice-core'
import { describe, expect, it } from 'vitest'
import type { ActionsView, CheckView, CommitView } from '../src/frame.ts'
import { type Hit, hitAt, sameTarget, type Target } from '../src/hits.ts'
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
import { NOT_HERE } from '../src/view/actions.ts'
import { wrapPath } from '../src/view/text.ts'
import { BUTTONS, draw, renderApp } from '../src/view.ts'

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
    chosen: null,
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
    unread: [],
    source: 'read from .github/workflows/ci.yml',
    running: null,
    notes: [],
    ...over,
  })
  const page = (view: ActionsView, size: { width?: number; height?: number } = {}) =>
    renderApp(viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'), {
      ...frame(size),
      actions: view,
    }).join('\n')
  /** The same page with its `tests` check opened: what it ran, and what it printed. */
  const opened = (view: ActionsView, size: { width?: number; height?: number } = {}) =>
    renderApp(
      toggleCheck(
        viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
        'checkout/refunds',
        'tests',
      ),
      { ...frame(size), actions: view },
    ).join('\n')

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

  it('says how long it took and what it counted, and keeps the command for when it is asked for', () => {
    const view = actions({
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
    })
    const text = page(view, { width: 140, height: 30 })
    expect(text).toContain('1m 04s')
    expect(text).toContain('4 failed')
    // What failed is what the page is opened for, so a red check keeps the
    // first file it named without being asked.
    expect(text).toContain('test/view.test.ts:37:5')
    // The command is a row every check would spend, and nobody reads it until
    // they are asking what actually ran.
    expect(text).not.toContain('pnpm vitest run')
    expect(opened(view, { width: 140, height: 30 })).toContain('pnpm vitest run')
  })

  it('shows a run as it goes, and what it printed when a check is opened', () => {
    const going = page(
      actions({
        running: { since: 0, by: 'you', done: 1, total: 3 },
        checks: [aCheck({ state: 'running', startedAt: 0 })],
      }),
    )
    expect(going).toContain('going now')
    expect(going).toContain('1 of 3')

    const view = actions({
      checks: [aCheck({ state: 'failed', tail: ['the last thing it printed'] })],
    })
    const shut = renderApp(
      viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
      { ...frame({ width: 140, height: 40 }), actions: view },
    ).join('\n')
    expect(shut).not.toContain('the last thing it printed')
    const open = opened(view, { width: 140, height: 40 })
    expect(open).toContain('the last thing it printed')
  })

  // Two categories, and what Tade does not run here is folded away: every row
  // of it carried a sentence about why, and together they were a wall.
  it('folds away what it does not run here, with the reason a click from being read', () => {
    const view = actions({
      checks: [
        aCheck({ id: 'format', state: 'passed', seconds: 2, at: 0 }),
        aCheck({ id: 'integration', skip: 'its job needs service containers' }),
      ],
      unread: ['release › publish is the action actions/setup-node, which only the runner can run'],
    })
    const shut = page(view, { width: 140, height: 30 })
    expect(shut).toContain('NOT RUN HERE')
    // Two in it: the check nothing here can run, and the step that is not a
    // check at all — named, because Tade checking less than CI does is only
    // safe while it says so.
    expect(shut).not.toContain('service containers')
    expect(shut).not.toContain('setup-node')
    const open = renderApp(
      toggleSection(
        viewActions(focusTask(state(), 'checkout/refunds'), 'checkout/refunds'),
        NOT_HERE,
        true,
      ),
      { ...frame({ width: 140, height: 30 }), actions: view },
    ).join('\n')
    expect(open).toContain('service containers')
    expect(open).toContain('setup-node')
    // And the one act that moves it across, on the row itself.
    expect(open).toContain('run here')
  })

  it('offers turning a check off where somebody has opened it, and never on a row of the list', () => {
    const view = actions({ checks: [aCheck({ state: 'passed', seconds: 2, at: 0 })] })
    expect(page(view, { width: 140, height: 30 })).not.toContain('don’t run here')
    expect(opened(view, { width: 140, height: 30 })).toContain('don’t run here')
  })

  it('says a run that carried over where it ran, rather than when', () => {
    const text = page(
      actions({
        checks: [
          aCheck({
            state: 'passed',
            seconds: 2,
            at: 0,
            carried: true,
            commit: '9f0e1d2c3b4a5968777869',
          }),
        ],
      }),
      { width: 140, height: 30 },
    )
    expect(text).toContain('ran at 9f0e1d2')
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
    const text = renderApp(state(), frame({ width: 160 })).join('\n')
    expect(text).toContain('! 1 waiting')
  })

  it('says which project it is waiting in, where there is no room for the total', () => {
    // The tab carries its own project's mark, which is the answer a total at
    // the right cannot give — so that is what a narrow window keeps.
    const text = plain(renderApp(state(), frame()).join('\n'))
    expect(text).toContain('checkout !')
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

    // Nobody pointing: the buttons are there anyway, drawn and pressable, so
    // reaching for one never has to go through the tab to find it.
    const away = at(null)
    expect(away.box(close)).not.toBe(null)
    expect(away.box(menu)).not.toBe(null)
    expect(away.text).toContain(COLOUR.icon('×', 'rest'))
    expect(away.text).toContain(COLOUR.icon('≡', 'rest'))
    expect(away.text).toContain(COLOUR.tabbed('tests', false, false))

    // On the tab, on its close, on its menu: the same three are there either
    // way, and the tab is lit under all three.
    for (const hover of [tab, close, menu]) {
      const here = at(hover)
      expect(here.box(close)).not.toBe(null)
      expect(here.box(menu)).not.toBe(null)
      // Lit, whichever of the three it is on: a tab at rest has no ground.
      expect(here.text).toContain(COLOUR.tabbed('tests', false, true))
      // Nothing moved: pointing at a tab takes no room it did not already have.
      expect(here.box(other)?.from).toBe(away.box(other)?.from)
      expect(here.box(tab)?.from).toBe(away.box(tab)?.from)
      expect(here.box(close)?.from).toBe(away.box(close)?.from)
      expect(here.box(menu)?.from).toBe(away.box(menu)?.from)
    }

    // And each button answers the pointer on its own, on top of that: the
    // close in the colour of what it does, the menu in the ordinary lit one,
    // and neither of them lit by the pointer being on the other.
    expect(at(close).text).toContain(COLOUR.icon('×', 'danger'))
    expect(at(close).text).not.toContain(COLOUR.icon('≡', 'hover'))
    expect(at(menu).text).toContain(COLOUR.icon('≡', 'hover'))
    expect(at(menu).text).not.toContain(COLOUR.icon('×', 'danger'))
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
  it('says how long the agents have run, just before what they cost', () => {
    const rows = renderApp(state(), {
      ...frame(),
      spend: {
        tokens: 1_500,
        usd: 0.351,
        hasCost: true,
        byTask: {},
        runtime: { ...noRuntime(), ms: 80 * 60_000, runs: 2, running: true },
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
        runtime: { ...noRuntime(), ms: 0, runs: 0, running: false },
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
        runtime: { ...noRuntime(), ms: 80 * 60_000, runs: 2, running: true },
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
    runtime: { ...noRuntime(), ms: 80 * 60_000, runs: 2, running: true },
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

  it('marks a terminal whose program took the screen, and offers no bar on it', () => {
    // A shell with an editor open in it is an agent drawing its own
    // conversation: what scrolled off was never kept, the program answers the
    // wheel itself, and the panel says so in the same column the pane does.
    const terminals = {
      ...withTerminals(state(), [{ id: 'checkout/terminals/1', project: 'checkout', name: 'x' }]),
      bottom: 'checkout/terminals/1',
      keyboard: 'terminal' as const,
    }
    const drawn = draw(terminals, {
      ...tall(),
      terminal: {
        screen: '~/src/checkout/src/refunds.ts\n  1 export function refund() {',
        view: { lines: 400, cursor: { back: 0, column: 2 }, scrolling: 'lane' },
      },
    })
    expect(
      drawn.hits.filter((hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'terminal'),
    ).toEqual([])
    const marked = drawn.rows.filter((row) => plain(row)[99] === '\u2506')
    expect(marked.length).toBeGreaterThan(0)
    expect(drawn.rows.every((row) => plain(row)[99] !== '\u2588')).toBe(true)
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
