import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Hit } from '../src/hits.ts'
import { draggedInFile, highlighted, ordered, selectedText } from '../src/pointer.ts'

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
