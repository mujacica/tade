import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { Hit } from '../src/hits.ts'
import {
  type AppState,
  initialState,
  showTerminal,
  withProjects,
  withTerminals,
  withTranscript,
} from '../src/model.ts'
import { draggedInFile, Painted, type PointerEvent } from '../src/pointer.ts'
import type { HeldLines } from '../src/scroll.ts'
import {
  cellsIn,
  type End,
  highlighted,
  lineAt,
  ordered,
  type Region,
  selectedText,
  spanText,
  type Within,
} from '../src/selection.ts'
import { emptyTranscript, said, type Transcript } from '../src/transcript.ts'
import { draw } from '../src/view.ts'

// Selecting text by dragging over it: the window reports the mouse, so the
// terminal cannot select for itself, and without this nothing on screen could
// be copied at all.

// Every row exactly as wide as the window, as the window draws them.
const rows = [
  `\x1b[1m❯ why is refunds slow\x1b[0m${' '.repeat(14)}`,
  '● because the webhook retries twice',
  '  and each retry charges again     ',
]

describe('a selection', () => {
  it('reads the same whichever way it was dragged', () => {
    const forward = ordered({ from: { x: 2, y: 0 }, to: { x: 8, y: 1 } })
    expect(ordered({ from: { x: 8, y: 1 }, to: { x: 2, y: 0 } })).toEqual(forward)
  })

  it('copies what it covers, a line per row, without colour or the padding', () => {
    expect(selectedText(rows, { from: { x: 2, y: 0 }, to: { x: 4, y: 0 } })).toBe('why')
    expect(selectedText(rows, { from: { x: 10, y: 1 }, to: { x: 13, y: 2 } })).toBe(
      'the webhook retries twice\n  and each ret',
    )
  })

  it('is shown reversed, and moves nothing', () => {
    const lit = highlighted(rows, { from: { x: 2, y: 0 }, to: { x: 4, y: 1 } }, 35)
    expect(lit[0]).toContain('\x1b[7m')
    expect(lit[2]).toBe(rows[2])
    for (const row of lit) expect(visibleWidth(row)).toBe(35)
  })
})

// The window is regions side by side, not one flow of text: a selection that
// took whole rows between its two ends took whatever else was drawn on them
// with it. Dragging over an agent came back with the sidebar's queue and its
// agents down the left of every line but the first and the last.
describe('a selection dragged inside one region', () => {
  const beside = [
    'QUEUE       ● because the webhook  ',
    'refunds     retries twice and each ',
    'checkout    retry charges again    ',
  ]
  // The columns the agent's screen was drawn in, as the map says.
  const within = { from: 12, to: 34 }

  it('never reaches into what is drawn beside it', () => {
    const chosen = { from: { x: 14, y: 0 }, to: { x: 20, y: 2 } }
    expect(selectedText(beside, chosen, within)).toBe(
      'because the webhook\nretries twice and each\nretry cha',
    )
  })

  it('takes the whole row where it was started on nothing in particular', () => {
    const chosen = { from: { x: 14, y: 0 }, to: { x: 20, y: 2 } }
    expect(selectedText(beside, chosen)).toBe(
      'because the webhook\nrefunds     retries twice and each\ncheckout    retry cha',
    )
  })

  it('lights only its own columns, and moves nothing', () => {
    const lit = highlighted(beside, { from: { x: 14, y: 0 }, to: { x: 20, y: 2 } }, 35, within)
    expect(stripTerminalSequences(lit[1] ?? '')).toBe(beside[1])
    expect(sliceByColumn(lit[1] ?? '', 0, 12)).not.toContain('\x1b[7m')
    for (const row of lit) expect(visibleWidth(row)).toBe(35)
  })
})

// Dragging in a file you have open selects in its own lines, not in the rows
// of the window: the rows its text was drawn on are the rows a caret can be
// put in, so where they stop is where the file stops.
describe('a drag in the file you have open', () => {
  // Four lines of a file, drawn from row 6 down, its text from column 20.
  const hits: Hit[] = [0, 1, 2, 3].map((line) => ({
    row: 6 + line,
    from: 20,
    to: 60,
    target: { kind: 'caret', line: 40 + line },
  }))

  it('is the line the pointer is on, and how far along it', () => {
    expect(draggedInFile(hits, 26, 7)).toEqual({ line: 41, cell: 6 })
    expect(draggedInFile(hits, 60, 9)).toEqual({ line: 43, cell: 40 })
  })

  it('takes the near end of the line where the pointer is off to the side of it', () => {
    // Over the line numbers, and over the bar beside the text.
    expect(draggedInFile(hits, 3, 8)).toEqual({ line: 42, cell: 0 })
    expect(draggedInFile(hits, 90, 8)).toEqual({ line: 42, cell: 40 })
  })

  it('is how far past the top or the bottom it has gone, where it has left them', () => {
    expect(draggedInFile(hits, 26, 4)).toEqual({ rows: -2, cell: 6 })
    expect(draggedInFile(hits, 26, 12)).toEqual({ rows: 3, cell: 6 })
  })

  it('is nothing where no file is drawn at all', () => {
    expect(draggedInFile([], 26, 7)).toBeNull()
  })
})

// A selection anchored in a region's own lines rather than in the rows on
// screen. An offset into the rows is meaningless once those rows scroll away,
// which is what "selecting over more than a page does not work" was: the
// selection was made of cells, and the cells stopped meaning anything.
describe('a selection anchored in a region', () => {
  /** Twelve lines of something, six of them drawn from row 4 down, at columns 2..21. */
  const region: Region = {
    lines: Array.from({ length: 12 }, (_, i) => `line ${i} of it`),
    first: 0,
    offset: 3,
    row: 4,
    rows: 6,
  }
  const within: Within = { from: 2, to: 21 }
  const end = (x: number, y: number, line: number | null): End => ({ x, y, line })

  it('reads a cell of the window as a line of the region', () => {
    expect(lineAt(region, 4)).toBe(3)
    expect(lineAt(region, 7)).toBe(6)
    // Off its rows either way is the nearest one it drew: a drag held past the
    // edge is still pointing at the end it is being held towards.
    expect(lineAt(region, 1)).toBe(3)
    expect(lineAt(region, 40)).toBe(8)
  })

  it('takes an end that has scrolled out of view at the edge it went past', () => {
    // Started on line 1, which is two lines above the top of what is drawn.
    const cells = cellsIn({ from: end(9, 4, 1), to: end(14, 6, null) }, region, within)
    expect(cells.from).toEqual({ x: 2, y: 4 })
    expect(cells.to).toEqual({ x: 14, y: 6 })
    // And below it, at the last row it drew rather than at the pane's foot.
    const below = cellsIn({ from: end(9, 4, 2), to: end(14, 6, 11) }, region, within)
    expect(below.to).toEqual({ x: 21, y: 9 })
  })

  it('copies the whole span, including the lines that are off screen', () => {
    // From the middle of line 1 — long gone above — to the middle of line 9,
    // which is two below the last row drawn.
    const text = spanText(region, { from: end(9, 4, 1), to: end(9, 9, 9) }, within)
    expect(text.split('\n')).toEqual([
      'of it',
      'line 2 of it',
      'line 3 of it',
      'line 4 of it',
      'line 5 of it',
      'line 6 of it',
      'line 7 of it',
      'line 8 of it',
      'line 9 o',
    ])
  })

  it('reads the same whichever way it was dragged', () => {
    const down = spanText(region, { from: end(4, 4, 2), to: end(9, 9, 5) }, within)
    const up = spanText(region, { from: end(9, 9, 5), to: end(4, 4, 2) }, within)
    expect(up).toBe(down)
  })

  it('reaches no further back than the window holds of the region', () => {
    // A lane's scrollback goes back as far as it has been read and no further:
    // the lines here are 40 to 51 of it, and nothing invents line 12.
    const lane: Region = { ...region, first: 40, offset: 43 }
    const text = spanText(lane, { from: end(2, 4, 0), to: end(6, 5, 44) }, within)
    expect(text.split('\n')[0]).toBe('line 0 of it')
    expect(text.split('\n').length).toBe(5)
  })
})

// And the whole of it through the component the terminal drives: pressed on
// one page, scrolled, let go on another, and copied. This is the half that
// could not be tested as a function — what makes it work is that the drawing
// declares the region and the selection is projected back through it on every
// frame, so it takes a real window to say whether it does.
describe('a selection dragged over more than a screen', () => {
  // One of them a URL, because a line with a link in it is a line you have to
  // be able to start a selection at, and once was not.
  const LINES = Array.from({ length: 60 }, (_, i) =>
    i === 55 ? 'see https://example.com/x' : `line ${i}`,
  )

  /** A window showing a terminal whose lane has sixty lines, all of them held. */
  function window() {
    let state: AppState = withTerminals(withProjects(initialState(), ['checkout']), [
      { id: 'checkout/shell', project: 'checkout', name: 'shell' },
    ])
    state = showTerminal(state, 'checkout/shell')
    const held: HeldLines = { lane: 'checkout/shell', lines: LINES, at: 60, asked: 200 }
    /** The frame as it is once the wheel has taken the screen `scroll` lines back. */
    const frame = (scroll: number): Frame => {
      const first = LINES.length - scroll - ROWS
      return {
        width: 100,
        height: 30,
        screen: '',
        terminal: {
          screen: LINES.slice(first, first + ROWS).join('\n'),
          view: { lines: LINES.length, cursor: { back: 0, column: 0 } },
        },
        held: new Map([['terminal', held]]),
      } as unknown as Frame
    }
    return { state, frame }
  }
  /** How many lines of the lane the panel is read back in, as the window sizes it. */
  const ROWS = 8

  function dragging() {
    const { state, frame } = window()
    let scroll = 0
    const copied: string[] = []
    const said: PointerEvent[] = []
    const painted = new Painted(
      () => ({ state: { ...state, terminalScroll: scroll }, frame: frame(scroll) }),
      (event) => {
        said.push(event)
        return false
      },
      (text) => copied.push(text),
      () => 0,
    )
    const mouse = (type: 'press' | 'drag' | 'release' | 'click', x: number, y: number) =>
      painted.handleMouse({
        type,
        button: 'left',
        x,
        y,
        screenX: x,
        screenY: y,
        width: 100,
        height: 30,
        shift: false,
        alt: false,
        ctrl: false,
      } as never)
    return {
      copied,
      said,
      mouse,
      draw: () => painted.render(100),
      scrollTo: (lines: number) => {
        scroll = lines
      },
    }
  }

  it('copies the lines that scrolled away, not only the ones still on screen', () => {
    const drag = dragging()
    drag.draw()
    // Started on the newest line, at the foot of the panel.
    drag.mouse('press', 1, 27)
    drag.mouse('drag', 6, 27)
    // Five lines back, as the wheel would take it, and the drag goes on.
    drag.scrollTo(5)
    drag.draw()
    drag.mouse('drag', 6, 21)
    drag.mouse('release', 6, 21)
    const lines = (drag.copied[0] ?? '').split('\n')
    // Eleven lines, from a panel that only ever showed seven of them.
    expect(lines.length).toBe(11)
    expect(lines[1]).toBe('line 50')
    expect(lines.at(-2)).toBe('line 58')
  })

  it('is the scroll that makes it longer: the same drag without one takes a screenful', () => {
    const still = dragging()
    still.draw()
    still.mouse('press', 1, 27)
    still.mouse('drag', 6, 21)
    still.mouse('release', 6, 21)
    // The wheel during a drag extends the selection rather than cancelling it,
    // and this is the same gesture with the wheel left alone.
    expect((still.copied[0] ?? '').split('\n').length).toBe(7)
  })

  it('stays over the words it took while they move under it', () => {
    const drag = dragging()
    drag.draw()
    // The top row of the panel down to the row before the last: lines 53 to 58.
    drag.mouse('press', 1, 21)
    drag.mouse('drag', 6, 26)
    expect(lit(drag.draw())).toEqual([21, 22, 23, 24, 25, 26])
    // Two lines back, and line 53 is a row further down than it was — one of
    // the two, because a screen scrolled back gives its last row to the way
    // back. The selection goes with it rather than staying where it was made.
    drag.scrollTo(2)
    expect(lit(drag.draw())).toEqual([22, 23, 24, 25, 26])
  })

  it('never reaches out of the region it was started in', () => {
    const drag = dragging()
    drag.draw()
    drag.mouse('press', 1, 27)
    drag.mouse('drag', 6, 22)
    drag.scrollTo(20)
    drag.draw()
    drag.mouse('drag', 6, 21)
    drag.mouse('release', 6, 21)
    // Every whole line of it is the terminal's own — the two ends are cut
    // where the pointer was — and nothing came from the sidebar or the agent's
    // pane, which are drawn on the very same rows.
    const lines = (drag.copied[0] ?? '').split('\n')
    expect(lines.length).toBeGreaterThan(7)
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^line \d+$|^see https/)
  })

  // Held off the edge, the region scrolls under the selection: the pointer
  // sitting still reports nothing at all, so a drag that stopped at the edge
  // could never reach past one screen with a mouse.
  it('asks for the region to be scrolled while it is held off an edge', () => {
    const drag = dragging()
    drag.draw()
    drag.mouse('press', 1, 25)
    drag.mouse('drag', 6, 24)
    expect(drag.said.filter((event) => event.kind === 'drag-region').at(-1)).toMatchObject({
      area: 'terminal',
      rows: 0,
    })
    // Three rows above the top of the panel, which is where it stops being a
    // row of it and starts being a request to go further back.
    drag.mouse('drag', 6, 18)
    expect(drag.said.filter((event) => event.kind === 'drag-region').at(-1)).toMatchObject({
      area: 'terminal',
      rows: -3,
    })
    // And back inside it, which is what stops it.
    drag.mouse('drag', 6, 23)
    expect(drag.said.filter((event) => event.kind === 'drag-region').at(-1)).toMatchObject({
      rows: 0,
    })
  })

  // A link is text Tade found in somebody else's words, so a press on one has
  // to be able to mean either thing: still, it opens; moved, it selects. A
  // line with a URL in it used to be a line no selection could be started at.
  it('starts a selection on a link, and opens it only where the press never moved', () => {
    const drag = dragging()
    drag.draw()
    // Line 55 is the URL, and the third of the seven rows drawn.
    drag.mouse('press', 4, 23)
    drag.mouse('drag', 6, 24)
    drag.mouse('release', 6, 24)
    expect(drag.copied[0]).toContain('https://example.com/x')
    expect(drag.said.some((event) => event.kind === 'click')).toBe(false)

    const press = dragging()
    press.draw()
    press.mouse('press', 4, 23)
    press.mouse('release', 4, 23)
    press.mouse('click', 4, 23)
    expect(press.copied).toEqual([])
    expect(press.said).toContainEqual(
      expect.objectContaining({
        kind: 'click',
        target: { kind: 'link', url: 'https://example.com/x' },
      }),
    )
  })
})

/** Which rows of a frame a selection is shown on: reversed, as a terminal shows one. */
function lit(rows: readonly string[]): number[] {
  return rows.flatMap((row, i) => (row.includes('\x1b[7m') ? [i] : []))
}

// And the same of the conversation, which is the other place people select
// more than a screenful: its lines are the transcript's own, laid out at the
// width once and windowed, so the region is the whole conversation and the
// rows on screen are a view onto it.
describe('a selection dragged over the conversation', () => {
  function talking() {
    let transcript: Transcript = emptyTranscript()
    for (let i = 0; i < 40; i++) transcript = said(transcript, `answer number ${i}`, i)
    const state: AppState = {
      ...withTranscript(withProjects(initialState(), ['checkout']), transcript),
      bottomMode: 'max',
    }
    const frame = { width: 100, height: 30, screen: '' } as unknown as Frame
    return { state, frame, region: draw(state, frame).regions?.transcript }
  }

  it('is the whole conversation, not the part of it on screen', () => {
    const { region } = talking()
    expect(region?.lines.length).toBe(40)
    // The last of them is at the foot of the panel, which is where it starts.
    expect(region?.offset).toBe(40 - (region?.rows ?? 0))
  })

  it('copies what scrolled past, and only the conversation', () => {
    const { state, frame, region } = talking()
    if (!region) throw new Error('the conversation is not a region')
    let scroll = 0
    const copied: string[] = []
    const painted = new Painted(
      () => ({ state: { ...state, transcriptScroll: scroll }, frame }),
      () => false,
      (text) => copied.push(text),
      () => 0,
    )
    const mouse = (type: 'press' | 'drag' | 'release', y: number) =>
      painted.handleMouse({
        type,
        button: 'left',
        x: 10,
        y,
        screenX: 10,
        screenY: y,
        width: 100,
        height: 30,
        shift: false,
        alt: false,
        ctrl: false,
      } as never)
    painted.render(100)
    const bottom = region.row + region.rows - 1
    mouse('press', bottom)
    mouse('drag', bottom)
    // Ten lines back, and the drag goes on from the top of what is now shown.
    scroll = 10
    painted.render(100)
    mouse('drag', region.row)
    mouse('release', region.row)
    const lines = (copied[0] ?? '').split('\n')
    expect(lines.length).toBeGreaterThan(region.rows)
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^● answer number \d+$/)
  })
})
