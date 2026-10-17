import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.ts'
import { grabBar, initialState, panelMoved, scrollBy } from '../src/model.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { type DiffPanel, diffPanel } from '../src/panels/diff/state.ts'
import { diff, diffBody } from '../src/panels/diff/view.ts'
import { changesIn } from '../src/panels/file/inline.ts'
import { startOf } from '../src/panels/frame.ts'
import { type PanelInputs, panelKey } from '../src/panels.ts'
import { reachOf } from '../src/scroll.ts'
import { thumbOf } from '../src/scrollbar.ts'
import { COLOUR, PLAIN, type Skin } from '../src/skin.ts'
import type { Drawn } from '../src/ui.ts'

// The patch reader, read for what changed: the bar down its side says where
// each change is, and `n` and `p` take the line the keyboard is on from one to
// the next — as the file panel a changed file opens in does
// (`panels-file-changes.test.ts`). Writing on a line is `panels-comments.test.ts`'s.

/** Lines of the file left as they were, from `from` on: git's context. */
const kept = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ` line ${from + i}`)

/**
 * Three hunks, each a screen apart: a line changed, a line put in and a line
 * taken out — more of git's answer than the reader shows at once.
 */
const PATCH = parseDiff(
  [
    '@@ -1,20 +1,20 @@',
    ...kept(1, 9),
    '-line 10',
    '+line 10 changed',
    ...kept(11, 10),
    '@@ -40,20 +40,21 @@',
    ...kept(40, 10),
    '+line new',
    ...kept(50, 10),
    '@@ -80,19 +81,18 @@',
    ...kept(80, 10),
    '-line 90',
    ...kept(91, 9),
  ].join('\n'),
)

const WIDTH = 120
const HEIGHT = 34
const BODY = diffBody(WIDTH, HEIGHT)

const inputs = (over: PanelInputs = {}): PanelInputs => ({ patch: PATCH, body: BODY, ...over })

const reader = (over: Partial<DiffPanel> = {}): DiffPanel => ({
  ...diffPanel('shop/pay', ['a.ts', 'b.ts']),
  ...over,
})

/**
 * A key pressed while the reader has the keyboard, as the window hands it over
 * — and the move it asks for made as the window makes it: against the bar the
 * reader was drawn with, from where it was drawn (`panelMoved`).
 */
const press = (panel: DiffPanel, key: string, given: PanelInputs = inputs()): DiffPanel => {
  const answer = panelKey(panel, key, key.length === 1 ? key : '', given)
  const reach = reachOf(drawing(panel, PLAIN, given.patch ?? PATCH).hits, 'panel')
  return panelMoved({ ...initialState(), panel }, answer, reach).panel as DiffPanel
}

describe('the changes in git’s answer', () => {
  it('are the runs of lines added or taken out, a hunk’s own line ending one', () => {
    expect(changesIn(PATCH.lines)).toEqual([
      { from: 10, to: 12, kind: 'change' },
      { from: 33, to: 34, kind: 'add' },
      { from: 55, to: 56, kind: 'remove' },
    ])
    // A hunk's `@@` line between two changes keeps them two.
    const two = parseDiff(['@@ -1,1 +1,1 @@', '+one', '@@ -5,1 +5,1 @@', '+five'].join('\n'))
    expect(changesIn(two.lines)).toEqual([
      { from: 1, to: 2, kind: 'add' },
      { from: 3, to: 4, kind: 'add' },
    ])
  })
})

describe('going through the changes in the patch reader', () => {
  it('puts the keyboard on each in turn with n, and back with p', () => {
    let panel = press(reader(), 'n')
    expect(panel).toMatchObject({ at: 10, following: true, scroll: 10 - 3, wrapped: null })
    panel = press(panel, 'n')
    expect(panel).toMatchObject({ at: 33, scroll: 33 - 3 })
    panel = press(panel, 'n')
    // Never past the end: the last screen is as far as the view goes.
    expect(panel).toMatchObject({ at: 55, scroll: PATCH.lines.length - BODY })
    panel = press(panel, 'p')
    expect(panel).toMatchObject({ at: 33, scroll: 33 - 3 })
  })

  it('does the same on ctrl+n and ctrl+p', () => {
    const panel = press(reader(), 'ctrl+n')
    expect(panel.at).toBe(10)
    expect(press(press(panel, 'ctrl+n'), 'ctrl+p').at).toBe(10)
  })

  it('goes round past the last to the first, and before the first to the last', () => {
    let panel = reader()
    for (const _ of [1, 2, 3]) panel = press(panel, 'n')
    panel = press(panel, 'n')
    expect(panel).toMatchObject({ at: 10, wrapped: 10 })
    panel = press(panel, 'p')
    expect(panel).toMatchObject({ at: 55, wrapped: 55 })
    // Anything else that moves the keyboard is not a press that went round.
    expect(press(panel, 'up').wrapped).toBeNull()
    expect(press(panel, 'right')).toMatchObject({ file: 1, at: null, wrapped: null })
  })

  it('goes back to the start of the change the keyboard is in the middle of', () => {
    expect(press(reader({ at: 11, following: true }), 'p').at).toBe(10)
    expect(press(reader({ at: 11, following: true }), 'n').at).toBe(33)
  })

  it('goes from the top of the view before the keyboard has been on a line', () => {
    // Scrolled past the first change by the wheel: the next one is under the view.
    expect(press(reader({ scroll: 20 }), 'n').at).toBe(33)
    expect(press(reader({ scroll: 20 }), 'p').at).toBe(10)
    // And a change on the first line in view is the next one, not stepped over.
    expect(press(reader({ scroll: 10 }), 'n').at).toBe(10)
  })

  it('does nothing where git says nothing changed, or that the file is binary', () => {
    const none = reader()
    expect(press(none, 'n', inputs({ patch: parseDiff('') }))).toBe(none)
    expect(press(none, 'p', inputs({ patch: { ...parseDiff(''), binary: true } }))).toBe(none)
  })
})

describe('paging through the patch reader', () => {
  /** The last screen: as far down as the drawing ever shows. */
  const END = PATCH.lines.length - BODY

  it('goes no further than the last screen, so a page back from the end is a whole page', () => {
    let panel = reader()
    for (const _ of Array(8)) panel = press(panel, 'pageDown')
    expect(panel.scroll).toBe(END)
    expect(press(panel, 'space').scroll).toBe(END)
    expect(press(panel, 'pageUp').scroll).toBe(END - 10)
  })

  it('pages back from the last screen when where it was kept is past it', () => {
    // A taller window, or a shorter patch, since it was scrolled there.
    expect(press(reader({ scroll: END + 30 }), 'pageUp').scroll).toBe(END - 10)
  })

  /**
   * The keyboard's line past the foot of the view: the drawing brings it into
   * view, and the scroll the reader was left at is above all of it.
   */
  const followed = (): DiffPanel => {
    const panel = reader({ at: BODY + 10, following: true })
    expect(inView(panel)[0]).not.toBe(inView(reader())[0])
    return panel
  }

  it('follows the line down a press at a time, from where the view is drawn', () => {
    let panel = reader()
    for (const _ of Array(BODY + 10)) panel = press(panel, 'down')
    // The view went down with the line, and the reader's own scroll did not.
    expect(inView(panel)[0]).not.toBe(inView(reader())[0])
    expect(panel.scroll).toBe(0)
    expect(inView(press(panel, 'pageDown'))[0]).toBe(inView(panel)[10])
  })

  it('pages from where the view is drawn while it follows the line the keyboard is on', () => {
    const panel = followed()
    const shown = inView(panel)
    // A page on puts the row ten down at the top — not the top of where it was left.
    expect(inView(press(panel, 'pageDown'))[0]).toBe(shown[10])
    // And a page back puts the top ten rows down.
    expect(inView(press(panel, 'pageUp'))[10]).toBe(shown[0])
  })

  it('moves under the wheel from where it is drawn, as a page key does', () => {
    const panel = followed()
    const shown = inView(panel)
    const reach = reachOf(drawing(panel).hits, 'panel')
    const notched = scrollBy({ ...initialState(), panel }, 'panel', 3, reach).panel as DiffPanel
    expect(inView(notched)[0]).toBe(shown[3])
  })

  it('keeps the thumb under the pointer that takes hold of it where it is drawn', () => {
    const panel = followed()
    const reach = reachOf(drawing(panel).hits, 'panel')
    // Where the drawing put the view, and so the thumb, by the drawing's own rule.
    const top = startOf(panel.scroll, PATCH.lines.length, BODY, { from: BODY + 10, to: BODY + 10 })
    expect(inView(panel)[0]).toBe(inView(reader({ scroll: top }))[0])
    const thumb = thumbOf({ ...reach, offset: top, rows: BODY })
    const bar = { area: 'panel' as const, ...reach }
    const held = grabBar(
      { ...initialState(), panel },
      bar,
      { top: 0, rows: BODY },
      thumb?.from ?? 0,
    )
    const now = held.panel as DiffPanel
    const at = thumbOf({ ...reach, offset: now.scroll, rows: BODY })
    // Taken on the thumb, it stays where it was taken: the grab is not the track's.
    expect(at?.from).toBe(thumb?.from)
  })
})

function draw(panel: DiffPanel, skin: Skin = PLAIN, patch = PATCH): string[] {
  return drawing(panel, skin, patch).rows
}

function drawing(panel: DiffPanel, skin: Skin = PLAIN, patch = PATCH): Drawn {
  const ctx = {
    width: WIDTH,
    height: HEIGHT,
    skin,
    pointer: { hover: null, pressed: null },
    homeDir: '/home/me',
    diff: patch,
  } as unknown as PanelContext
  return diff(panel, ctx)
}

/**
 * The lines the reader has in view, top to bottom, in words: its border, the
 * bar and the mark on the keyboard's line left off, so a row reads the same
 * wherever the view is.
 */
function inView(panel: DiffPanel): string[] {
  return draw(panel)
    .slice(1, 1 + BODY)
    .map((row) => stripTerminalSequences(row).slice(1, -2).replace('▶', ' ').trimEnd())
}

/** The bar down the right of the body, top to bottom, one glyph a row. */
function barOf(panel: DiffPanel, skin: Skin = PLAIN, patch = PATCH): string[] {
  // The border, then the body: the bar is the last cell before the border.
  return draw(panel, skin, patch)
    .slice(1, 1 + BODY)
    .map((row) => [...stripTerminalSequences(row)].at(-2) ?? '')
}

/** The marks on the bar, in order, a run of the same mark counted once. */
const marksOn = (bar: string[]) =>
  bar.filter((one, i) => one !== '▕' && one !== '█' && one !== bar[i - 1])

/** The foot of the reader, in words: what the marked line says, then the keys. */
function foot(panel: DiffPanel, patch = PATCH): { said: string; keys: string } {
  const rows = draw(panel, PLAIN, patch).map((row) => stripTerminalSequences(row))
  return { said: rows[rows.length - 3] ?? '', keys: rows[rows.length - 2] ?? '' }
}

describe('the bar down the side of the patch reader', () => {
  it('marks where each change is, in the sign its lines wear', () => {
    // At the top, the line changed is in view and under the thumb, which keeps
    // its cells where there is no colour to lay a mark on it.
    expect(marksOn(barOf(reader()))).toEqual(['+', '−'])
    // At the end, the removal is the one in view.
    expect(marksOn(barOf(reader({ scroll: 41 })))).toEqual(['±', '+'])
  })

  it('paints a mark in the tone the line is drawn in, on the ground it sits on', () => {
    const painted = draw(reader({ scroll: 41 }), COLOUR).join('\n')
    expect(painted).toContain(COLOUR.scrollMark('change', false, false))
    expect(painted).toContain(COLOUR.scrollMark('add', false, false))
    // And on the thumb: a change in view leaves the thumb a thumb, half of it.
    expect(painted).toContain(COLOUR.scrollMark('remove', true, false))
  })

  it('marks nothing where nothing changed', () => {
    expect(marksOn(barOf(reader(), PLAIN, parseDiff('')))).toEqual([])
  })
})

describe('what the foot of the patch reader says of the changes', () => {
  it('says n and p where there are changes to go through, and not where there are none', () => {
    expect(foot(reader()).keys).toContain('n/p change')
    expect(foot(reader(), parseDiff('')).keys).not.toContain('n/p')
  })

  it('says which change the keyboard is on, and when getting there went round an end', () => {
    let panel = press(press(reader(), 'n'), 'n')
    expect(foot(panel).said).toContain('change 2 of 3')
    expect(foot(panel).said).not.toContain('wrapped')
    for (const _ of [1, 2]) panel = press(panel, 'n')
    expect(foot(panel).said).toContain('change 1 of 3, wrapped')
    // Still in the change a line on, and no longer the press that went round.
    expect(foot(press(panel, 'down')).said).toContain('change 1 of 3')
    expect(foot(press(panel, 'down')).said).not.toContain('wrapped')
    // And nothing on a line that is not a change.
    expect(foot(press(press(panel, 'down'), 'down')).said).not.toContain('change')
  })
})
