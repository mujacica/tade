import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { drawPanel } from '../src/panels/context.ts'
import { type IntakePanel, intakePanel } from '../src/panels/intake/state.ts'
import { type WorkflowPanel, workflowPanel } from '../src/panels/workflow/state.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import { PLAIN } from '../src/skin.ts'

// The two pages the software factory adds, as presses: one request in front of
// you, and writing a stored workflow.
//
// Its own file because `panels.test.ts` is at the size a file is allowed to
// be. What is tested here is only what a key or a click *means* — the drawing
// is in the golden screens, and what the presses actually do is in
// `test/wire/`.

const open = (over: Partial<IntakePanel> = {}): IntakePanel => ({
  ...intakePanel('cli:req-1', 'req-1'),
  busy: false,
  ...over,
})

const press = (panel: IntakePanel, key: string | undefined, data = '') => panelKey(panel, key, data)

describe('one request in front of you', () => {
  it('reads with the arrows and closes with escape', () => {
    expect(press(open(), 'down').panel).toMatchObject({ scroll: 1 })
    expect(press(open({ scroll: 4 }), 'up').panel).toMatchObject({ scroll: 3 })
    // Never past the top: a page is read from its first row.
    expect(press(open(), 'up').panel).toMatchObject({ scroll: 0 })
    expect(press(open(), 'escape').panel).toBeNull()
  })

  it('asks before the two acts that are not reversible, and never before reading', () => {
    expect(press(open(), undefined, 'a').panel).toMatchObject({ asking: 'approve' })
    expect(press(open(), undefined, 's').panel).toMatchObject({ asking: 'start' })
    expect(press(open(), undefined, 'r').panel).toMatchObject({ asking: 'refuse' })
    // Trying one again asks nothing: it hands the request to its source again,
    // which is what already failed, and nothing is started by it.
    const retry = press(open(), undefined, 't')
    expect(retry.submit).toBe(true)
    expect(retry.choice).toBe('retry')
  })

  it('says what the question is about rather than "are you sure"', () => {
    const asked = press(open(), undefined, 'a').panel as IntakePanel
    expect(asked.asking).toBe('approve')
    // Escape answers the question and nothing else: it is always exactly one
    // thing, and a page that closed as well would lose where somebody was.
    const no = press(asked, 'escape')
    expect(no.panel).toMatchObject({ kind: 'intake', asking: null })
    expect(no.submit).toBe(false)
    const yes = press(asked, 'y')
    expect(yes.submit).toBe(true)
    expect(yes.choice).toBe('approve')
    expect(yes.panel).toMatchObject({ busy: true, asking: null })
  })

  it('answers nothing while it is reading or acting', () => {
    const busy = open({ busy: true })
    expect(press(busy, undefined, 'a').panel).toMatchObject({ asking: null })
    expect(panelClick(busy, 'approve').panel).toMatchObject({ asking: null })
    // Escape still closes it: a page that could not be left while something
    // was going is a page that traps you on a failed request.
    expect(press(busy, 'escape').panel).toBeNull()
  })

  it('offers no act for opening it at its source: the url is the link it is', () => {
    expect(press(open(), undefined, 'o').submit).toBe(false)
    expect(panelClick(open(), 'open').submit).toBe(false)
  })

  it('answers a click exactly as it answers the key', () => {
    for (const [control, asking] of [
      ['approve', 'approve'],
      ['start', 'start'],
      ['refuse', 'refuse'],
    ] as const) {
      expect(panelClick(open(), control).panel).toMatchObject({ asking })
    }
    expect(panelClick(open({ asking: 'refuse' }), 'no').panel).toMatchObject({ asking: null })
    expect(panelClick(open({ asking: 'refuse' }), 'yes').choice).toBe('refuse')
    expect(panelClick(open(), 'close').panel).toBeNull()
  })
})

const fields = [
  { id: 'title', label: 'Title', value: 'A bug', kind: 'text' as const },
  {
    id: 'done',
    label: 'Finished when',
    value: 'said',
    kind: 'choice' as const,
    options: ['said', 'committed'],
  },
  { id: 'after:fix', label: 'After fix', value: 'false', kind: 'check' as const },
  { id: 'prompt', label: 'Told', value: 'one', kind: 'text' as const, off: 'edited in the file' },
]

const rows = [
  { id: 'template:mine', template: 'mine', step: -1 },
  { id: 'mine:0', template: 'mine', step: 0 },
]

const editing = (over: Partial<WorkflowPanel> = {}): WorkflowPanel => ({
  ...workflowPanel('mine'),
  ...over,
})

const key = (panel: WorkflowPanel, k: string | undefined, data = '') =>
  panelKey(panel, k, data, { workflowFields: fields, workflowRows: rows })
const clicked = (panel: WorkflowPanel, control: string) =>
  panelClick(panel, control, { workflowFields: fields, workflowRows: rows })

describe('writing a stored workflow', () => {
  it('walks the list sideways and the form downwards, which are the two columns', () => {
    expect(key(editing(), 'right').panel).toMatchObject({ row: 0 })
    expect(key(editing({ row: 0 }), 'left').panel).toMatchObject({ row: -1 })
    // Never off either end: the list has a first row and a last one.
    expect(key(editing(), 'left').panel).toMatchObject({ row: -1 })
    expect(key(editing(), 'tab').panel).toMatchObject({ index: 1 })
    expect(key(editing({ index: 1 }), 'shift+tab').panel).toMatchObject({ index: 0 })
  })

  it('types into a text field without saving a keystroke at a time', () => {
    const typed = key(editing(), undefined, 'X')
    expect(typed.submit).toBe(false)
    expect(typed.panel).toMatchObject({ typing: { id: 'title', value: 'A bugX' } })
    // And saves it when the keyboard leaves the field, which is a field at a
    // time rather than a keystroke at a time.
    const left = key(typed.panel as WorkflowPanel, 'tab')
    expect(left.submit).toBe(true)
    expect(left.choice).toBe('save')
  })

  it('saves what was typed rather than dropping it when the page is left', () => {
    const typed = key(editing(), undefined, 'X').panel as WorkflowPanel
    const out = key(typed, 'escape')
    expect(out.submit).toBe(true)
    expect(out.choice).toBe('save')
    // With nothing typed, escape is the way out and nothing else.
    expect(key(editing(), 'escape').panel).toBeNull()
  })

  it('submits a tick and a choice at once, because there is nothing to finish typing', () => {
    const tick = key(editing({ index: 2 }), 'space')
    expect(tick.submit).toBe(true)
    expect(tick.choice).toBe('press:after:fix')
    const choice = key(editing({ index: 1 }), 'enter')
    expect(choice.choice).toBe('press:done')
  })

  it('will not touch a field that says why it cannot be changed here', () => {
    const off = key(editing({ index: 3 }), undefined, 'X')
    expect(off.submit).toBe(false)
    expect(off.panel).toMatchObject({ typing: null })
  })

  it('asks before publishing, because a published version never changes', () => {
    const asked = clicked(editing(), 'publish').panel as WorkflowPanel
    expect(asked.asking).toBe('publish')
    expect(key(asked, 'escape').panel).toMatchObject({ asking: null })
    const yes = key(asked, 'y')
    expect(yes.submit).toBe(true)
    expect(yes.choice).toBe('publish')
  })

  it('moves to a row that was clicked, saving a field it was in the middle of', () => {
    const typed = key(editing(), undefined, 'X').panel as WorkflowPanel
    const moved = clicked(typed, 'row:mine:0')
    expect(moved.panel).toMatchObject({ template: 'mine', row: 0 })
    expect(moved.choice).toBe('save')
  })

  it('adds and removes a step as presses the subject carries out', () => {
    expect(clicked(editing(), 'add').choice).toBe('add')
    expect(clicked(editing({ row: 0 }), 'remove').choice).toBe('remove')
  })
})

// A panel is read over the work behind it, so every row it draws has to be
// exactly as wide as it says it is — at every width, including the ones
// nobody designs for.

/** What a panel is handed, with only the fields these two read filled in. */
function context(width: number, height: number, over: Partial<Frame['panel']> = {}) {
  return {
    width,
    height,
    skin: PLAIN,
    pointer: { hover: null, pressed: null },
    scrolling: null,
    home: '~/.tade',
    date: () => 'Mon 7 Sep 09:00',
    route: null,
    spend: null,
    panes: [],
    project: null,
    items: [],
    changes: [],
    ahead: null,
    branch: null,
    base: null,
    diff: null,
    choices: [],
    settings: [],
    accounts: [],
    updates: null,
    updatesBusy: false,
    lanesSurvive: false,
    configPath: '~/.tade/config.yaml',
    releases: false,
    budgetWarnings: 0,
    levels: [],
    openRows: [],
    browsing: null,
    homeDir: '/home/me',
    entries: [],
    searching: false,
    viewing: null,
    talkKey: 'ctrl+space',
    talkMode: 'hold' as const,
    bindings: {},
    running: 0,
    branches: [],
    checkout: null,
    found: 0,
    terminalName: 'terminal',
    extensions: [],
    harnessExtensions: [],
    servers: [],
    written: [],
    extensionsRoot: '~/.tade/extensions',
    models: [],
    modelsFrom: null,
    modelTarget: 'the orchestrator',
    currentModel: null,
    setup: null,
    extensionView: null,
    summary: null,
    intake: null,
    workflow: null,
    away: null,
    ...over,
  }
}

describe('both pages, in the room there is', () => {
  it('draws rows exactly as wide as they say they are, at every width', () => {
    for (const width of [24, 32, 48, 64, 80, 120, 200]) {
      for (const height of [10, 24, 60]) {
        for (const panel of [open(), editing()]) {
          const drawn = drawPanel(panel, context(width, height))
          const wide = Math.max(0, ...drawn.panel.rows.map((row) => visibleWidth(row)))
          for (const row of drawn.panel.rows) {
            // Every row the same width as the widest, which is the box: a row
            // off by one corrupts the whole screen it is drawn over.
            expect(visibleWidth(row), `${panel.kind} at ${width}x${height}`).toBe(wide)
          }
          // And never wider than the window, however little room there is.
          expect(wide, `${panel.kind} at ${width}x${height}`).toBeLessThanOrEqual(
            Math.max(24, width),
          )
          expect(drawn.panel.rows.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('says it is reading rather than looking empty, before it has anything', () => {
    const drawn = drawPanel(open({ busy: true }), context(80, 24))
    expect(drawn.panel.rows.join('\n')).toContain('Reading…')
    // And the reason, where there is one, instead of a page with nothing on it.
    const failed = drawPanel(open({ problem: 'the journal could not be read' }), context(80, 24))
    expect(failed.panel.rows.join('\n')).toContain('could not be read')
  })

  it('offers no control a page with nothing on it could not carry out', () => {
    // Nothing read yet, so no act is offered: a button that refuses when
    // pressed is worse than a button that is not there.
    const drawn = drawPanel(open({ busy: true }), context(80, 24))
    const controls = drawn.panel.hits
      .map((hit) => (hit.target.kind === 'control' ? hit.target.id : ''))
      .filter(Boolean)
    expect(controls).not.toContain('approve')
    expect(controls).toContain('close')
  })
})
