import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { draw } from '../src/view.ts'
import { base, frame } from './screens/scenarios/fixtures.ts'

// CHANGES and FILES before they have looked at what is in front of you.
//
// Both used to draw an empty answer until the first look came back — "nothing
// changed", `—` — and then push NOTES down under the real one: a claim about a
// checkout nobody had asked git about, and a side that moved twice. Not looked
// is `…` now, in the room the section last took (`roomHeld`).

/** The side's rows as text, tall enough that nothing scrolls. */
function side(over: Partial<Frame>): string[] {
  const { rows } = draw(
    { ...base(), folded: [] },
    { ...frame({ height: 80 }), layout: { sidebarWidth: 40 }, ...over },
  )
  return rows.map((row) => stripTerminalSequences(row).slice(0, 39))
}

/** The row a section's heading is on, and the row under it. */
function under(rows: readonly string[], label: string): { at: number; first: string } {
  const at = rows.findIndex((row) => row.includes(`▾ ${label}`))
  expect(at, `${label} is drawn open`).toBeGreaterThanOrEqual(0)
  return { at, first: rows[at + 1] ?? '' }
}

describe('a section that has not looked yet', () => {
  it('says so, rather than that nothing changed or that the folder is empty', () => {
    const rows = side({ changes: null, files: null })
    expect(under(rows, 'CHANGES').first.trim()).toBe('…')
    expect(under(rows, 'FILES').first.trim()).toBe('…')
    expect(rows.some((row) => row.includes('nothing changed'))).toBe(false)
    // And an answer that is empty still says what it is.
    const looked = side({ changes: [], files: [] })
    expect(under(looked, 'CHANGES').first).toContain('nothing changed')
    expect(under(looked, 'FILES').first.trim()).toBe('—')
  })

  it('holds the room the last answer took, so NOTES under it stays where it was', () => {
    const answered = side({})
    const changes = frame().changes?.length ?? 0
    const files = frame().files?.length ?? 0
    expect(changes).toBeGreaterThan(1)
    expect(files).toBeGreaterThan(1)
    const notLooked = side({ changes: null, files: null, roomHeld: { changes, files } })
    expect(under(notLooked, 'NOTES').at).toBe(under(answered, 'NOTES').at)
    // With nothing to hold, one row each: the `…`, and nothing below it moved.
    const first = side({ changes: null, files: null })
    expect(under(first, 'NOTES').at).toBe(under(side({ changes: [], files: [] }), 'NOTES').at)
  })

  it('says there is no checkout where there is none, looked at or not', () => {
    const rows = side({ changes: null, where: null })
    expect(under(rows, 'CHANGES').first).toContain('no checkout here')
  })
})
