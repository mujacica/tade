import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { barRows, offsetAt, type Scrolled, thumbOf } from '../src/scrollbar.ts'
import { COLOUR, PLAIN } from '../src/skin.ts'

// The bar has one job a person checks by eye and one they check by hand: that
// where the thumb is says where you are, and that dragging it there takes you
// there. The second is the first run backwards, so they are tested together.

const view = (over: Partial<Scrolled> = {}): Scrolled => ({
  total: 100,
  shown: 10,
  offset: 0,
  rows: 10,
  ...over,
})

describe('where the thumb goes', () => {
  it('is nothing at all when everything already fits', () => {
    expect(thumbOf(view({ total: 8, shown: 10 }))).toBeNull()
    expect(thumbOf(view({ total: 10, shown: 10 }))).toBeNull()
  })

  it('is at the top at the top, and at the bottom at the end', () => {
    const top = thumbOf(view({ offset: 0 }))
    expect(top).toMatchObject({ from: 0 })
    const end = thumbOf(view({ offset: 90 }))
    expect(end?.from ?? 0).toBe(10 - (end?.size ?? 0))
  })

  it('is as tall as the share in view, and never the whole track', () => {
    expect(thumbOf(view({ total: 20, shown: 10, rows: 10 }))?.size).toBe(5)
    // A hundred thousand lines still leaves something to take hold of.
    expect(thumbOf(view({ total: 100_000, shown: 10, rows: 10 }))?.size).toBe(1)
    // One line more than fits is still one line to scroll: the bar must say so.
    expect(thumbOf(view({ total: 11, shown: 10, rows: 10 }))?.size).toBe(9)
  })

  it('takes a row of the track back to the line it stands for', () => {
    const one = view({ total: 200, shown: 20, rows: 20 })
    for (const offset of [0, 37, 90, 180]) {
      const thumb = thumbOf({ ...one, offset })
      expect(thumb).not.toBeNull()
      // Where it was drawn, read back, is where it was — give or take the
      // rounding a row of track costs.
      expect(Math.abs(offsetAt(one, thumb?.from ?? 0) - offset)).toBeLessThanOrEqual(
        Math.ceil((one.total - one.shown) / one.rows),
      )
    }
  })

  it('stops at both ends, however far the pointer is dragged past them', () => {
    const one = view({ total: 100, shown: 10, rows: 10 })
    expect(offsetAt(one, -50)).toBe(0)
    expect(offsetAt(one, 500)).toBe(90)
  })
})

describe('the bar itself', () => {
  it('is exactly as many rows as it was given, each one column wide', () => {
    const rows = barRows(view(), PLAIN, false)
    expect(rows).toHaveLength(10)
    for (const row of rows) expect(row).toHaveLength(1)
  })

  it('is a track with nothing on it when there is nothing to scroll', () => {
    expect(new Set(barRows(view({ total: 5 }), PLAIN, false))).toEqual(new Set(['▕']))
  })

  it('marks where you are, and nowhere else', () => {
    const rows = barRows(view({ total: 100, shown: 10, offset: 45, rows: 10 }), PLAIN, false)
    expect(rows.filter((row) => row === '█')).toHaveLength(1)
    expect(rows.indexOf('█')).toBe(5)
  })

  // The bug this guards: a thumb drawn as a glyph on the window's own ground
  // is a separate little box on every row, and in a font that draws the block
  // short of the cell there is a hairline between each of them. One object,
  // one cell repeated — so every row of it has to be the same painted cell.
  it('is the very same painted cell all the way down the thumb, and down the track', () => {
    const rows = barRows(view({ total: 100, shown: 40, offset: 30, rows: 10 }), COLOUR, false)
    const thumb = rows.filter((row) => stripTerminalSequences(row) === '█')
    const track = rows.filter((row) => stripTerminalSequences(row) !== '█')
    expect(thumb.length).toBeGreaterThan(1)
    expect(track.length).toBeGreaterThan(1)
    expect(new Set(thumb).size).toBe(1)
    expect(new Set(track).size).toBe(1)
    // Painted cells, not ink on the window: a filled cell has no gap in it
    // whatever the font does with the glyph.
    const ground = new RegExp(`${String.fromCharCode(27)}\\[48;5;\\d+m`)
    for (const row of rows) expect(row).toMatch(ground)
    // And the two are told apart by their tone, not by one of them being blank.
    expect(thumb[0]).not.toBe(track[0])
  })

  it('is one run of thumb, never two, wherever you are in what it stands for', () => {
    for (const offset of [0, 1, 17, 44, 80]) {
      const rows = barRows(view({ total: 100, shown: 20, offset, rows: 12 }), COLOUR, false)
      const cells = rows.map((row) => stripTerminalSequences(row)).join('')
      // Track, thumb, track: the thumb is a single span with nothing in it.
      expect(cells).toMatch(/^▕*█+▕*$/)
    }
  })

  it('lights without coming apart: still one cell, still filled', () => {
    const held = barRows(view({ total: 100, shown: 40, offset: 30, rows: 10 }), COLOUR, true)
    const rest = barRows(view({ total: 100, shown: 40, offset: 30, rows: 10 }), COLOUR, false)
    const thumbOfBar = (rows: string[]) => rows.filter((row) => stripTerminalSequences(row) === '█')
    expect(new Set(thumbOfBar(held)).size).toBe(1)
    // The same rows, a brighter cell: taking hold of it must not move it.
    expect(thumbOfBar(held)).not.toEqual(thumbOfBar(rest))
    expect(thumbOfBar(held)).toHaveLength(thumbOfBar(rest).length)
  })
})
