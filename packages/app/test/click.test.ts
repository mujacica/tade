import { describe, expect, it } from 'vitest'
import type { Hit } from '../src/hits.ts'
import { hitAt } from '../src/hits.ts'
import type { AppState } from '../src/model.ts'
import { Painted, type PointerEvent } from '../src/pointer.ts'
import { screenRows } from '../src/view/lane.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// Whose a click inside a lane is.
//
// A lane that took the whole screen and asked for the mouse draws its own
// controls, and the window cannot press them for you: the bytes have to reach
// the program. But then Tade cannot also use that region — its click to focus,
// its drag to select, its reading of the paths in the text — so the split has
// to be one somebody can state, because a click that goes to the wrong one
// feels broken in both directions.
//
// What was chosen: the cells the program drew are the program's, the cells
// Tade drew around them stay Tade's, and a pane that has not got the keyboard
// answers a click the way it always has — so one click always lands in Tade.

const found = SCENARIOS.find((one) => one.name === 'watching-an-agent')
if (!found) throw new Error('the scenario is gone')
const scenario = found

/** The same window, differing only in what the driver says about the lane. */
function window(
  over: {
    scrolling?: 'window' | 'lane' | 'nobody'
    pointing?: 'nobody' | 'press' | 'drag'
    keyboard?: AppState['keyboard']
    paneScroll?: number
  } = {},
) {
  const state: AppState = {
    ...scenario.state,
    keyboard: over.keyboard ?? 'pane',
    paneScroll: over.paneScroll ?? 0,
  }
  const paneScreen = {
    lines: 180,
    cursor: { back: 0, column: 25 },
    ...(over.scrolling ? { scrolling: over.scrolling } : {}),
    ...(over.pointing ? { pointing: over.pointing } : {}),
  }
  const frame = { ...scenario.frame, paneScreen }
  const drawn = draw(state, frame)
  return {
    state,
    frame,
    hits: drawn.hits,
    rows: drawn.rows,
    of: (kind: Hit['target']['kind']) => drawn.hits.filter((hit) => hit.target.kind === kind),
  }
}

/** A lane that draws its own interface and wants every part of the pointer. */
const claudeish = { scrolling: 'lane', pointing: 'drag' } as const

describe('whose a click inside a lane is', () => {
  it('gives the cells the program drew to the program', () => {
    const drawn = window(claudeish)
    const screen = drawn.of('screen')
    expect(screen.length).toBeGreaterThan(0)
    for (const hit of screen) {
      expect(hit.target).toMatchObject({ kind: 'screen', lane: 'checkout/stripe-v15/agent' })
    }
  })

  // Both halves of the reported bug, from the other side: a lane nobody handed
  // the pointer to is a control nobody can press, and a window that handed it
  // over where the program never asked would be typing at it.
  it('gives them to nobody where the program did not ask, or did not take the screen', () => {
    expect(window({ scrolling: 'window', pointing: 'drag' }).of('screen')).toEqual([])
    expect(window({ scrolling: 'lane', pointing: 'nobody' }).of('screen')).toEqual([])
    expect(window({ scrolling: 'nobody', pointing: 'nobody' }).of('screen')).toEqual([])
    // What every lane is until a driver says otherwise.
    expect(window().of('screen')).toEqual([])
  })

  // The way out, and the reason nobody can be shut out of their own window: a
  // pane that has not got the keyboard answers a click by taking it, exactly
  // as it always has.
  it('leaves the first click on an unfocused pane to the window', () => {
    expect(window({ ...claudeish, keyboard: 'terminal' }).of('screen')).toEqual([])
    const focused = window(claudeish)
    const idle = window({ ...claudeish, keyboard: 'terminal' })
    const cell = focused.of('screen')[0]
    if (!cell) throw new Error('nothing was handed over')
    expect(hitAt(idle.hits, cell.from, cell.row)).toEqual({ kind: 'pane' })
  })

  // What is drawn *around* the screen is Tade's, and stays pressable: the
  // header above it, the column down its side, and the card an agent waiting
  // on you puts over the bottom of it.
  it('keeps everything Tade drew around it', () => {
    const drawn = window(claudeish)
    const rows = new Set(drawn.of('screen').map((hit) => hit.row))
    const columns = new Set(drawn.of('screen').map((hit) => hit.to))
    expect(columns.size).toBe(1)
    for (const kind of ['action', 'pane-tab', 'lane', 'menu'] as const) {
      for (const hit of drawn.of(kind)) {
        // Either off the screen's rows entirely, or drawn over them — and
        // either way the hit map answers with the control, not with the lane.
        expect(hitAt(drawn.hits, hit.from, hit.row)).toEqual(hit.target)
      }
    }
    // The column beside it is never the lane's, whatever is drawn in it.
    const gutter = Math.max(...columns) + 1
    for (const row of rows)
      expect(hitAt(drawn.hits, gutter, row)).not.toMatchObject({
        kind: 'screen',
      })
  })

  // A path lit under the pointer and then handed to the program is a worse
  // lie than not offering it at all, so on such a lane Tade's own reading of
  // the text steps aside — and only on such a lane.
  it('stops reading the text for paths on a lane it has handed the pointer to', () => {
    // Only on the screen itself: the same paths under CHANGES down the side
    // are Tade's own rows, and go on opening what they name.
    const onScreen = (over: NonNullable<Parameters<typeof window>[0]>) => {
      const drawn = window({ ...over, scrolling: over.scrolling ?? 'window' })
      const rows = new Set(
        window(claudeish)
          .of('screen')
          .map((hit) => hit.row),
      )
      return drawn.of('place').filter((hit) => rows.has(hit.row))
    }
    expect(onScreen({}).length).toBeGreaterThan(0)
    expect(onScreen(claudeish)).toEqual([])
    // Only there: the same file under CHANGES down the side is a row Tade
    // drew, and goes on opening what it names.
    expect(window(claudeish).of('change').length).toBeGreaterThan(0)
  })

  // A screen scrolled back is not the screen the program has, so there is no
  // row of it to name and nothing is handed over.
  it('hands over nothing while the screen is scrolled back', () => {
    expect(window({ ...claudeish, paneScroll: 12 }).of('screen')).toEqual([])
  })
})

describe('where in the program’s own screen a cell is', () => {
  // A lane is made the size of the pane and then read back in however many
  // rows are left for it — an approval card takes five — so what is on show is
  // the bottom of its screen and a click told otherwise lands above what was
  // pressed.
  it('counts from the bottom of the screen, not from the top of the region', () => {
    expect(screenRows(40, 40)).toEqual({ from: 0, rows: 40 })
    expect(screenRows(40, 35)).toEqual({ from: 5, rows: 35 })
    // A screen with fewer rows written than the region has: the rows above it
    // are on no row of it, and are not handed over.
    expect(screenRows(30, 40)).toEqual({ from: 0, rows: 30 })
  })
})

/** Drive the real component, as the terminal drives it. */
function pressing(over: NonNullable<Parameters<typeof window>[0]> = claudeish) {
  const drawn = window(over)
  const said: PointerEvent[] = []
  const painted = new Painted(
    () => ({ state: drawn.state, frame: drawn.frame }),
    (event) => {
      said.push(event)
      return false
    },
    () => {},
    () => 0,
  )
  painted.render(drawn.rows[0]?.length ?? 120)
  const cells = drawn.of('screen')
  const first = cells[0]
  if (!first) throw new Error('nothing was handed over')
  const mouse = (type: 'press' | 'drag' | 'release' | 'click', x: number, y: number) =>
    painted.handleMouse({
      type,
      button: 'left',
      x,
      y,
      screenX: x,
      screenY: y,
      width: 120,
      height: 40,
      shift: false,
      alt: false,
      ctrl: false,
      ...(type === 'click' ? { clickCount: 1 } : {}),
    })
  return { said, mouse, first, cells, points: () => said.filter((one) => one.kind === 'point') }
}

describe('what reaches the program', () => {
  it('reports the press, the drag and the release, in its own cells', () => {
    const at = pressing()
    const target = at.first.target
    if (target.kind !== 'screen') throw new Error('not a screen')
    at.mouse('press', at.first.from + 3, at.first.row)
    at.mouse('drag', at.first.from + 5, at.first.row + 2)
    at.mouse('release', at.first.from + 5, at.first.row + 2)
    expect(at.points().map((one) => one.kind === 'point' && one.report)).toEqual([
      {
        did: 'press',
        button: 'left',
        column: 3,
        row: target.from,
        shift: false,
        alt: false,
        ctrl: false,
      },
      {
        did: 'drag',
        button: 'left',
        column: 5,
        row: target.from + 2,
        shift: false,
        alt: false,
        ctrl: false,
      },
      {
        did: 'release',
        button: 'left',
        column: 5,
        row: target.from + 2,
        shift: false,
        alt: false,
        ctrl: false,
      },
    ])
  })

  // A terminal makes a click out of the press and the release it already
  // reported. Passed on as well, it would be the same click twice.
  it('does not say the click a terminal makes out of the two it already said', () => {
    const at = pressing()
    at.mouse('press', at.first.from + 1, at.first.row)
    at.mouse('release', at.first.from + 1, at.first.row)
    at.mouse('click', at.first.from + 1, at.first.row)
    expect(at.points()).toHaveLength(2)
    expect(at.said.some((one) => one.kind === 'click')).toBe(false)
  })

  // A drag let out over the sidebar is a pointer dragged off the edge of the
  // program's window, which every terminal reports as the edge.
  it('clamps a drag that left the region to the edge of the screen', () => {
    const at = pressing()
    const target = at.first.target
    if (target.kind !== 'screen') throw new Error('not a screen')
    at.mouse('press', at.first.from + 1, at.first.row)
    at.mouse('drag', 0, 0)
    const [, dragged] = at.points()
    expect(dragged?.kind === 'point' && dragged.report).toMatchObject({
      did: 'drag',
      column: 0,
      row: target.from,
    })
  })

  // A program that asked only about presses is told nothing about movement,
  // because bytes it cannot read as a pointer it reads as somebody typing.
  it('sends no movement to a lane that asked only about presses', () => {
    const at = pressing({ scrolling: 'lane', pointing: 'press' })
    at.mouse('press', at.first.from + 1, at.first.row)
    at.mouse('drag', at.first.from + 4, at.first.row + 1)
    at.mouse('release', at.first.from + 4, at.first.row + 1)
    expect(at.points().map((one) => one.kind === 'point' && one.report.did)).toEqual([
      'press',
      'release',
    ])
  })
})
