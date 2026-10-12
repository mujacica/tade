import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Hit } from '../src/hits.ts'
import { menuPanel, thinkingMenuItems } from '../src/panels/menu/state.ts'
import { draw } from '../src/view.ts'
import { base, frame } from './screens/scenarios/fixtures.ts'

// A dropdown hangs off the control that opened it: under it where the window
// has room, over it where it has none — the strip, which is the last row — and
// starting at its column, pulled back only as far as the right edge makes it.
// The strip's thinking level used to open pinned to the right edge of the
// window, over the conversation and over the strip itself, nowhere near the
// control it belonged to.

/** The control a click pressed: its row and its first column, as drawn. */
function control(hits: readonly Hit[], action: string): { row: number; col: number } {
  const hit = hits.find((one) => one.target.kind === 'action' && one.target.name === action)
  if (!hit) throw new Error(`no ${action} on screen`)
  return { row: hit.row, col: hit.from }
}

/** Where the Thinking menu landed: its top and bottom rows, its left column and its width. */
function menuIn(rows: readonly string[]): {
  top: number
  bottom: number
  left: number
  wide: number
} {
  const plain = rows.map((row) => stripTerminalSequences(row))
  const top = plain.findIndex((row) => row.includes('╭─ Thinking'))
  const line = plain[top] ?? ''
  const at = line.indexOf('╭─ Thinking')
  const left = visibleWidth(line.slice(0, at))
  const wide = visibleWidth(line.slice(at, line.indexOf('╮', at) + 1))
  const bottom = plain.findIndex(
    (row, i) => i > top && stripTerminalSequences(row).slice(at).startsWith('╰'),
  )
  return { top, bottom, left, wide }
}

const thinking = (task: string, from: { row: number; col: number }) =>
  menuPanel({ kind: 'thinking', task, current: 'high' }, 'Thinking', { ...from, control: true })

const SIZES = [
  { width: 120, height: 34 },
  { width: 160, height: 45 },
  { width: 120, height: 24 },
]

describe('a dropdown opened from a control', () => {
  it.each(SIZES)(
    'opens over the strip’s thinking level at its column, at $width×$height',
    ({ width, height }) => {
      const before = draw(base(), frame({ width, height }))
      const level = control(before.hits, 'thinking:orchestrator')
      // The strip is the foot of the window: nothing is under it.
      expect(level.row).toBe(height - 1)
      const opened = draw(
        { ...base(), panel: thinking('orchestrator', level) },
        frame({ width, height, panel: { items: thinkingMenuItems('high') } }),
      )
      const menu = menuIn(opened.rows)
      expect(menu.top).toBeGreaterThan(0)
      // Its last row is the one right above the control, so the strip is not covered...
      expect(menu.bottom).toBe(level.row - 1)
      expect(stripTerminalSequences(opened.rows[level.row] ?? '')).toBe(
        stripTerminalSequences(before.rows[level.row] ?? ''),
      )
      // ...and it starts where the control starts, not at the window's right edge.
      expect(menu.left).toBe(Math.min(level.col, width - menu.wide))
      expect(menu.left + menu.wide).toBeLessThanOrEqual(width)
      for (const row of opened.rows) expect(visibleWidth(row)).toBe(width)
    },
  )

  it('starts at the control’s own column where the window has room beside it', () => {
    const before = draw(base(), frame({ width: 160, height: 45 }))
    const level = control(before.hits, 'thinking:orchestrator')
    const opened = draw(
      { ...base(), panel: thinking('orchestrator', level) },
      frame({ width: 160, height: 45, panel: { items: thinkingMenuItems('high') } }),
    )
    const menu = menuIn(opened.rows)
    // Not clamped at this width: the box's corner is the control's first cell.
    expect(level.col + menu.wide).toBeLessThan(160)
    expect(menu.left).toBe(level.col)
  })

  it('drops under an agent’s thinking level, pulled back from the right edge', () => {
    const width = 120
    const before = draw(base(), frame({ width }))
    const level = control(before.hits, 'thinking:checkout/stripe-v15')
    const opened = draw(
      { ...base(), panel: thinking('checkout/stripe-v15', level) },
      frame({ width, panel: { items: thinkingMenuItems('high') } }),
    )
    const menu = menuIn(opened.rows)
    // The pane's header has the whole pane under it.
    expect(menu.top).toBe(level.row + 1)
    // Its control is nearer the edge than the menu is wide, so the edge is
    // the one thing that moves it.
    expect(level.col + menu.wide).toBeGreaterThan(width)
    expect(menu.left).toBe(width - menu.wide)
  })

  it('leaves a menu opened where a click landed with its corner there', () => {
    const opened = draw(
      {
        ...base(),
        panel: menuPanel({ kind: 'thinking', task: 'orchestrator', current: 'high' }, 'Thinking', {
          row: 4,
          col: 10,
        }),
      },
      frame({ panel: { items: thinkingMenuItems('high') } }),
    )
    const menu = menuIn(opened.rows)
    expect(menu.top).toBe(4)
    expect(menu.left).toBe(10)
  })
})
