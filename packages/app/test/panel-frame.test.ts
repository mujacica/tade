import { ConfigSchema, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { listStart, panelSize, startOf } from '../src/panels/frame.ts'
import { modelPanel } from '../src/panels/models/state.ts'
import { openProjectPanel } from '../src/panels/project/state.ts'
import { searchPanel } from '../src/panels/search/state.ts'
import { settingsPanel } from '../src/panels/settings/state.ts'
import { panelKey } from '../src/panels.ts'
import type { SearchEntry } from '../src/search.ts'

// The shell every panel is drawn in.
//
// The goldens say what one panel looks like on the terminal it was drawn on;
// these say what holds on all the others — that a panel takes the room there
// is, that it never takes the strip at the foot, and that walking a list with
// the keyboard and scrolling it with the wheel are two different things.

describe('how big a panel is', () => {
  /**
   * The rows a panel may never take: the window's own strip along the bottom
   * is four of them, and a panel drawn over it is a panel whose foot — Done,
   * and what it last said — is underneath it.
   */
  const STRIP = 4

  it('grows with the terminal instead of stopping at a number somebody typed', () => {
    // What "the Settings window is too small" was: it was capped at 28 rows
    // however tall the terminal, so half a tall window was the work behind it.
    const short = panelSize({ width: 120, height: 34 }, { max: 104 })
    const tall = panelSize({ width: 120, height: 60 }, { max: 104 })
    expect(tall.height).toBeGreaterThan(short.height)
    expect(tall.height).toBeGreaterThan(40)
  })

  it('never covers the strip at the foot, at any height worth drawing on', () => {
    for (const height of [12, 14, 20, 24, 34, 50, 80]) {
      const size = panelSize({ width: 120, height }, { max: 104 })
      expect(size.height, `at ${height}`).toBeLessThanOrEqual(height - STRIP)
    }
    // Below that the floor wins and the panel is clipped instead, which is the
    // honest answer on a terminal with room for neither: a panel shrunk to two
    // rows says nothing at all.
    expect(panelSize({ width: 120, height: 8 }, { max: 104 }).rows).toBe(6)
  })

  it('is as wide as it is worth being, and never wider than the window', () => {
    expect(panelSize({ width: 300, height: 40 }, { max: 104 }).width).toBe(104)
    expect(panelSize({ width: 60, height: 40 }, { max: 104 }).width).toBe(54)
    // A terminal nobody should be using still gets a box rather than a line.
    expect(panelSize({ width: 20, height: 40 }, { max: 104 }).width).toBeGreaterThan(10)
  })

  it('takes the room it needs where it said how much, up to the room there is', () => {
    // A menu's items are fixed the whole time it is open, so it is drawn its
    // own height; a body that changes under you takes the window instead, or
    // the panel moves between the click that chose a row and the one that
    // presses it.
    expect(panelSize({ width: 80, height: 40 }, { max: 46, needs: 9, least: 1 }).rows).toBe(9)
    expect(panelSize({ width: 80, height: 14 }, { max: 46, needs: 40, least: 1 }).rows).toBe(
      panelSize({ width: 80, height: 14 }, { max: 46, least: 1 }).rows,
    )
  })
})

describe('where a body is scrolled to', () => {
  it('leaves it where it was put when the row in view is already in view', () => {
    expect(startOf(4, 30, 10, { from: 5, to: 6 })).toBe(4)
    expect(startOf(4, 30, 10, null)).toBe(4)
  })

  it('follows a row that is several lines, whole rather than by its last line', () => {
    // A setting is a name, its control, its radios and the sentence under it,
    // and half of one in view is a setting you cannot use.
    expect(startOf(0, 40, 10, { from: 12, to: 16 })).toBe(7)
    // Coming back up, its first line is what the body is brought to.
    expect(startOf(20, 40, 10, { from: 12, to: 16 })).toBe(12)
  })

  it('never goes past either end', () => {
    expect(startOf(999, 30, 10)).toBe(20)
    expect(startOf(-5, 30, 10)).toBe(0)
    expect(startOf(3, 4, 10)).toBe(0)
  })

  it('is what a one-line list asks, said the short way', () => {
    for (const at of [0, 3, 9, 11])
      expect(listStart(4, 12, 5, at)).toBe(startOf(4, 12, 5, { from: at, to: at }))
  })
})

describe('walking a list and scrolling it', () => {
  // Two halves of one rule: the keyboard moving brings the body back to the
  // row it is on, and scrolling yourself leaves the keyboard where it was.
  // `atOffset` turns `following` off; these are the presses that turn it on,
  // and without them a panel you scrolled would snap back on the next frame.
  const keyed = (panel: Parameters<typeof panelKey>[0], key: string, inputs = {}) =>
    panelKey({ ...panel, following: false } as typeof panel, key, '', inputs).panel as {
      following: boolean
    }

  const settings = settingsOf(ConfigSchema.parse({}))
  const entries: SearchEntry[] = [
    { kind: 'agent', id: 'a', label: 'refunds', mark: '●' },
    { kind: 'agent', id: 'b', label: 'stripe-v15', mark: '●' },
  ]
  const models = [
    { id: 'anthropic/claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5' },
    { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', name: 'Claude Sonnet 5' },
  ]
  const rows = [
    { kind: 'here' as const, name: 'src', path: '/src', git: true },
    { kind: 'folder' as const, name: 'pay', path: '/src/pay', git: true },
  ]

  it('follows again as soon as a key moves what is chosen', () => {
    expect(keyed(settingsPanel('voice'), 'down', { settings }).following).toBe(true)
    expect(keyed(searchPanel(), 'down', { entries }).following).toBe(true)
    expect(keyed(modelPanel('the orchestrator'), 'down', { models }).following).toBe(true)
    expect(keyed(openProjectPanel('/src'), 'down', { rows }).following).toBe(true)
  })

  it('reads on without following, for the key that is the wheel said with a key', () => {
    const page = panelKey(settingsPanel('voice'), 'pageDown', '', { settings }).panel as {
      following: boolean
      scroll: number
    }
    expect(page.following).toBe(false)
    expect(page.scroll).toBeGreaterThan(0)
  })
})
