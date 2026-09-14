import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { highlighted, ordered, selectedText } from '../src/app.ts'

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
