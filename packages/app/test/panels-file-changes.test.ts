import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { changesIn, drawnRow, type InlineRow, inlineRows } from '../src/panels/file/inline.ts'
import { type FilePanel, filePanel, firstChange } from '../src/panels/file/state.ts'
import { fileBodySize, fileView } from '../src/panels/file/view.ts'
import { type PanelInputs, panelKey } from '../src/panels.ts'
import { marksAlong } from '../src/scrollbar.ts'
import { COLOUR, PLAIN, type Skin } from '../src/skin.ts'
import { editFrom, type ViewedFile } from '../src/viewer.ts'

// A changed file, read for what changed: it opens on the first change, the bar
// down its side says where the others are, and `n` and `p` go through them.
// What git says is laid into the file by `inline-diff.test.ts`; this is about
// finding your way through it once it is there.

/** Two hundred lines, as the base has them. */
const BEFORE = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)

/**
 * And as the task left them: line 120 rewritten, a line put in after line 150,
 * and line 181 taken out — a change, an addition and a removal, each on a
 * different screen of the file.
 */
const AFTER = (() => {
  const lines = [...BEFORE]
  lines[119] = 'line 120 changed'
  lines.splice(150, 0, 'line new')
  lines.splice(181, 1)
  return lines
})()

const DIFF = parseDiff(
  [
    '@@ -119,3 +119,3 @@',
    ' line 119',
    '-line 120',
    '+line 120 changed',
    ' line 121',
    '@@ -150,2 +150,3 @@',
    ' line 150',
    '+line new',
    ' line 151',
    '@@ -180,3 +181,2 @@',
    ' line 180',
    '-line 181',
    ' line 182',
  ].join('\n'),
)

const ROWS = inlineRows(DIFF, null, AFTER.length) as InlineRow[]
const BODY = 20

const inputs = (over: PanelInputs = {}): PanelInputs => ({
  text: AFTER,
  body: BODY,
  columns: 80,
  diffRows: ROWS,
  ...over,
})

const changed = (over: Partial<FilePanel> = {}): FilePanel => ({
  ...filePanel('/r/ledger.ts', null, false, true),
  ...over,
})

/** A key pressed while the panel has the keyboard, as the window hands it over. */
const press = (panel: FilePanel, key: string, given: PanelInputs = inputs()): FilePanel =>
  panelKey(panel, key, key.length === 1 ? key : '', given).panel as FilePanel

/** The first row of the body in view: the row the view is scrolled to. */
const top = (panel: FilePanel) => panel.scroll

describe('the changes in a file, as runs of rows', () => {
  it('finds each run once, and says which kind of change it is', () => {
    expect(changesIn(ROWS)).toEqual([
      { from: 119, to: 121, kind: 'change' },
      { from: 151, to: 152, kind: 'add' },
      { from: 182, to: 183, kind: 'remove' },
    ])
  })

  it('is nothing where git has not been asked, and nothing where nothing changed', () => {
    expect(changesIn(null)).toEqual([])
    expect(changesIn(inlineRows(parseDiff(''), null, 3))).toEqual([])
  })

  it('is worked out once for the rows it was made from, not once a frame', () => {
    // The very same list, so the frame that reads it twice is the frame that
    // costs nothing the second time — and a region kept over it stays kept.
    expect(changesIn(ROWS)).toBe(changesIn(ROWS))
    const many = inlineRows(DIFF, null, AFTER.length)
    expect(changesIn(many)).not.toBe(changesIn(ROWS))
    expect(changesIn(many)).toEqual(changesIn(ROWS))
  })
})

describe('opening a changed file', () => {
  it('lands on the first change, with a few rows of what comes before it above', () => {
    const landing = firstChange(ROWS, BODY)
    expect(landing?.offset).toBe(119 - 3)
    expect(landing?.atChange).toMatchObject({ index: 0, wrapped: null })
  })

  it('is nowhere in particular where nothing changed: the file opens at its top', () => {
    expect(firstChange(inlineRows(parseDiff(''), null, 3), BODY)).toBeNull()
    expect(firstChange(null, BODY)).toBeNull()
  })

  it('never puts the view past the end of the file to land on a change near it', () => {
    const last = inlineRows(
      parseDiff(['@@ -200,1 +200,1 @@', '-line 200', '+the last'].join('\n')),
      null,
      200,
    )
    expect(firstChange(last, BODY)?.offset).toBe((last?.length ?? 0) - BODY)
  })
})

describe('going through the changes', () => {
  it('goes to each in turn with n, and back with p', () => {
    let panel = changed()
    panel = press(panel, 'n')
    expect(top(panel)).toBe(119 - 3)
    panel = press(panel, 'n')
    expect(top(panel)).toBe(151 - 3)
    panel = press(panel, 'n')
    expect(top(panel)).toBe(182 - 3)
    panel = press(panel, 'p')
    expect(top(panel)).toBe(151 - 3)
  })

  it('goes round past the last to the first, and says that it did', () => {
    let panel = changed()
    for (const _ of [1, 2, 3]) panel = press(panel, 'n')
    panel = press(panel, 'n')
    expect(top(panel)).toBe(119 - 3)
    expect(panel.atChange).toMatchObject({ index: 0, wrapped: 'top' })
    expect(foot(panel)).toContain('change 1 of 3, wrapped')
    // And before the first to the last.
    panel = press(panel, 'p')
    expect(panel.atChange).toMatchObject({ index: 2, wrapped: 'bottom' })
    expect(foot(panel)).toContain('change 3 of 3, wrapped')
  })

  it('goes from where the view is once it has been moved some other way', () => {
    // Scrolled past the first change by hand: the next one is the one under
    // the view, not the one after the change it was last sent to.
    let panel = press(changed(), 'n')
    panel = { ...panel, scroll: 160 }
    expect(top(press(panel, 'n'))).toBe(182 - 3)
    expect(top(press(panel, 'p'))).toBe(151 - 3)
  })

  it('takes a change at the very top as the first one, rather than stepping over it', () => {
    const early = inlineRows(
      parseDiff(['@@ -1,2 +1,2 @@', '-line 1', '+the first', ' line 2'].join('\n')),
      null,
      200,
    ) as InlineRow[]
    const panel = press(changed(), 'n', inputs({ diffRows: early }))
    expect(panel.atChange).toMatchObject({ index: 0, wrapped: null })
  })

  it('does not stick on a change the end of the file stops the view short of', () => {
    // Three changes on the last screen: the view cannot scroll down to any of
    // them, so it is where it is for all three, and each press is still the
    // next one rather than the same one again.
    const end = inlineRows(
      parseDiff(
        [
          '@@ -190,1 +190,1 @@',
          '-line 190',
          '+190',
          '@@ -195,1 +195,1 @@',
          '-line 195',
          '+195',
          '@@ -199,1 +199,1 @@',
          '-line 199',
          '+199',
        ].join('\n'),
      ),
      null,
      200,
    ) as InlineRow[]
    const given = inputs({ diffRows: end })
    let panel = press(changed(), 'n', given)
    const scroll = top(panel)
    expect(scroll).toBe(end.length - BODY)
    panel = press(panel, 'n', given)
    expect(panel.atChange?.index).toBe(1)
    panel = press(panel, 'n', given)
    expect(panel.atChange?.index).toBe(2)
    expect(top(panel)).toBe(scroll)
  })

  it('takes the caret with it while typing, on ctrl+n and ctrl+p', () => {
    // Every letter is a letter once the caret is down, so the keys are the chords.
    const typing = changed({ edit: editFrom(AFTER, 0, 0) })
    let panel = press(typing, 'ctrl+n')
    expect(panel.edit?.row).toBe(119)
    expect(top(panel)).toBe(119 - 3)
    expect(press(panel, 'n').edit?.lines[119]).toBe('nline 120 changed')
    panel = press(panel, 'ctrl+n')
    // The added line, which is line 151 of the file and drawn a row lower for
    // the line gone above it.
    expect(panel.edit?.row).toBe(150)
    expect(drawnRow(ROWS, 150)).toBe(151)
    panel = press(panel, 'ctrl+p')
    expect(panel.edit?.row).toBe(119)
  })

  it('puts the caret on the line that stands where a removal was', () => {
    let panel = changed({ edit: editFrom(AFTER, 160, 0) })
    panel = press(panel, 'ctrl+n')
    // Line 181 is gone; line 182 of the base is line 182 of the file now.
    expect(panel.edit?.row).toBe(181)
  })

  it('says why it cannot go anywhere, rather than doing nothing', () => {
    expect(press(changed({ inline: false }), 'n').said).toMatch(/ctrl\+d/)
    const none = inlineRows(parseDiff(''), null, AFTER.length)
    expect(press(changed(), 'n', inputs({ diffRows: none })).said).toBe('No changes to go to.')
    expect(press(changed(), 'p', inputs({ diffRows: null })).said).toBe('No changes to go to.')
  })
})

/** The file as the viewer is handed it. */
const VIEWED: ViewedFile = {
  path: '/r/ledger.ts',
  text: AFTER.join('\n'),
  size: AFTER.join('\n').length,
  binary: false,
  truncated: false,
  language: 'typescript',
  mtimeMs: 0,
  error: null,
}

function draw(panel: FilePanel, skin: Skin = PLAIN, width = 120, height = 34) {
  const ctx = {
    width,
    height,
    skin,
    pointer: { hover: null, pressed: null },
    homeDir: '/home/me',
    diff: DIFF,
    viewing: { file: VIEWED, source: AFTER, text: AFTER, formatted: null, inline: ROWS },
  } as unknown as PanelContext
  return fileView(panel, ctx).rows
}

/** The footer of the panel as drawn: its second row from the bottom, in words. */
const foot = (panel: FilePanel, width = 120) => {
  const rows = draw(panel, PLAIN, width).map((row) => stripTerminalSequences(row))
  return rows[rows.length - 2] ?? ''
}

/** The bar down the right of the body, top to bottom, one glyph a row. */
function barOf(panel: FilePanel, skin: Skin = PLAIN): string[] {
  const rows = draw(panel, skin)
  const body = fileBodySize(120, 34, ROWS.length, false, true).rows
  // The head, its rule, then the body: the bar is the last cell before the border.
  return rows.slice(3, 3 + body).map((row) => [...stripTerminalSequences(row)].at(-2) ?? '')
}

describe('the bar down the side of a changed file', () => {
  it('marks where each change is, in the sign the line itself wears', () => {
    const bar = barOf(changed())
    const body = bar.length
    const cell = (row: number) => Math.floor((row * body) / ROWS.length)
    expect(bar[cell(119)]).toBe('±')
    expect(bar[cell(151)]).toBe('+')
    expect(bar[cell(182)]).toBe('−')
    // And nothing anywhere else but the track and the thumb at the top: a
    // change across a cell's edge marks both cells, so runs of one are one.
    const marked = bar.filter((one, i) => one !== '▕' && one !== '█' && one !== bar[i - 1])
    expect(marked).toEqual(['±', '+', '−'])
  })

  it('lets the thumb keep its cells where there is no colour to lay a mark on it', () => {
    // The addition in view, under the thumb: what is under the thumb is on
    // screen with its own sign in front of it. The other two are not.
    const bar = barOf(changed({ scroll: 145 }))
    expect(bar).not.toContain('+')
    expect(bar).toContain('±')
    expect(bar).toContain('−')
    // And at the first change, which the thumb's own rounding would have put
    // a cell outside it: in view is under the thumb.
    expect(barOf(changed({ scroll: 116 }))).not.toContain('±')
  })

  it('paints a mark in the tone the line is drawn in, on the ground it sits on', () => {
    const tones = barOf(changed(), COLOUR)
    expect(new Set(tones)).toContain('▐')
    const painted = draw(changed(), COLOUR).join('\n')
    expect(painted).toContain(COLOUR.scrollMark('add', false, false))
    expect(painted).toContain(COLOUR.scrollMark('remove', false, false))
    expect(painted).toContain(COLOUR.scrollMark('change', false, false))
    // On the thumb too: a change in view leaves the thumb a thumb, half of it.
    expect(draw(changed({ scroll: 116 }), COLOUR).join('\n')).toContain(
      COLOUR.scrollMark('change', true, false),
    )
  })

  it('is worked out once for the view it is drawn for, not once a frame', () => {
    const runs = changesIn(ROWS)
    const view = { total: ROWS.length, shown: 20, offset: 0, rows: 20 }
    expect(marksAlong(runs, view)).toBe(marksAlong(runs, { ...view }))
    expect(marksAlong(runs, { ...view, rows: 21 })).toHaveLength(21)
  })
})

describe('the keys, where the panel says its keys', () => {
  it('says n and p while reading a changed file, ahead of everything else', () => {
    expect(foot(changed())).toContain('n/p')
    // At eighty columns there is room for little else, and it is still there.
    expect(foot(press(changed(), 'n'), 80)).toContain('n/p change')
  })

  it('says the chords while typing', () => {
    expect(foot(changed({ edit: editFrom(AFTER, 0, 0) }))).toContain('ctrl+n/p')
  })

  it('says which change the view is on, until the view is moved some other way', () => {
    const panel = press(press(changed(), 'n'), 'n')
    expect(foot(panel)).toContain('change 2 of 3')
    expect(foot(panel, 80)).toContain('change 2 of 3')
    expect(foot({ ...panel, scroll: panel.scroll + 1 })).not.toContain('change 2 of 3')
  })

  it('says nothing of n and p in a file that is not drawn with its changes', () => {
    expect(foot(changed({ inline: false }))).not.toContain('n/p')
  })
})
