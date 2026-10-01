import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { ListRowView, RowSummaryView } from '../src/frame.ts'
import { hitAt, sameTarget, type Target } from '../src/hits.ts'
import type { PanelContext } from '../src/panels/context.ts'
import { drawPanel } from '../src/panels/context.ts'
import { rowSummaryPanel } from '../src/panels/summary/state.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import { COLOUR } from '../src/skin.ts'
import { NO_POINTER } from '../src/ui.ts'
import { ageOf, listItem, reviewRows, rowTarget } from '../src/view/list.ts'

// A row an extension keeps, drawn in two, and the window a click on it opens.
//
// One file rather than corners of `view.test.ts` and `panels.test.ts`, because
// the two halves are one subject: what the two rows down the side leave out is
// exactly what the window says in full, and a change to either is a change to
// both.

const plain = (text: string) => stripTerminalSequences(text)

const NOW = Date.parse('2026-09-13T14:00:04Z')

const review = (over: Partial<ListRowView> = {}): ListRowView => ({
  section: 'review.open',
  id: 'github.com/acme/checkout#412',
  label: '#412',
  title: 'retry refunds once',
  note: 'acme/checkout  retry-refunds',
  marks: [
    { text: 'open', tone: 'quiet' },
    { text: 'ready', tone: 'good' },
  ],
  figures: [
    { text: '✓ checks', tone: 'good' },
    { text: 'approved', tone: 'good' },
  ],
  age: { since: NOW - 26 * 3_600_000, says: 'open' },
  links: [{ title: 'review #412', url: 'https://github.com/acme/checkout/pull/412' }],
  ...over,
})

describe('a row an extension keeps, down the side', () => {
  it('is two rows, both exactly as wide as the side, at every width', () => {
    for (const width of [20, 24, 29, 40, 64]) {
      const item = listItem(width, COLOUR, NO_POINTER, review(), NOW)
      expect(item.rows).toHaveLength(2)
      for (const row of item.rows) expect(visibleWidth(plain(row.text))).toBe(width)
    }
  })

  it('keeps the number whole and the title readable when the marks want the columns', () => {
    // The whole bug: the marks took what they wanted and the title whatever was
    // left, so `retry refunds once` came out `retr…` to make room for `open`.
    const [top] = listItem(29, COLOUR, NO_POINTER, review(), NOW).rows
    const text = plain(top?.text ?? '')
    expect(text).toContain('#412')
    expect(text).toContain('retry refu')
    // And the marks give ground at their own left: `ready` is the reason to
    // look, `open` is what a section called REVIEWS says of everything in it.
    expect(text).toContain('ready')
    expect(text).not.toContain('open ·')
  })

  it('says both halves were cut, and never silently', () => {
    const text = plain(listItem(29, COLOUR, NO_POINTER, review(), NOW).rows[0]?.text ?? '')
    expect(text).toContain('…ready')
    expect(text).toContain('refu…')
  })

  it('works out how long it has been open as it draws, from the moment it was given', () => {
    // Never a figure worked out at the poll: the side draws four times a second
    // and a list is asked once a minute.
    expect(ageOf(review(), NOW)).toBe('1d 2h open')
    expect(ageOf(review(), NOW + 3_600_000)).toBe('1d 3h open')
    // A row that does not say when has no figure rather than a nought, which
    // would read as "opened just now".
    expect(ageOf(review({ age: undefined }), NOW)).toBe('')
  })

  it('shortens the one figure that matters rather than drawing a bare ellipsis', () => {
    // A single mark wider than the room used to leave `…` and nothing else,
    // which says less than no mark at all.
    const one = review({ figures: [{ text: 'changes requested', tone: 'warning' }] })
    const under = plain(listItem(24, COLOUR, NO_POINTER, one, NOW).rows[1]?.text ?? '')
    expect(under).toMatch(/chan\S*…/)
    expect(under.trim()).not.toMatch(/^…/)
  })

  it('draws the whole of both rows as one thing to click', () => {
    const item = listItem(29, COLOUR, NO_POINTER, review(), NOW)
    const target = rowTarget(review())
    for (const row of item.rows) {
      expect(sameTarget(hitAt(row.hits, 2, 0), target)).toBe(true)
      expect(sameTarget(hitAt(row.hits, 20, 0), target)).toBe(true)
    }
  })

  it('offers where it lives under the pointer, in place of the age', () => {
    const target = rowTarget(review())
    const pointed = { hover: target, pressed: null }
    const [, under] = listItem(29, COLOUR, pointed, review(), NOW).rows
    expect(plain(under?.text ?? '')).toContain('↗')
    expect(plain(under?.text ?? '')).not.toContain('1d 2h open')
    const link = under?.hits.find((hit) => hit.target.kind === 'link')
    expect(link?.target).toEqual({
      kind: 'link',
      url: 'https://github.com/acme/checkout/pull/412',
    })
  })
})

describe('the same row on the ACTIONS page', () => {
  it('is two rows the width of the pane, both opening the review in front of you', () => {
    const rows = reviewRows(88, COLOUR, NO_POINTER, review(), NOW)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(visibleWidth(plain(row.text))).toBe(88)
    // The same two acts as the row down the side: the number used to be the
    // link here and nowhere else, so one blue thing meant two acts on two
    // pages.
    for (const row of rows) {
      expect(sameTarget(hitAt(row.hits, 3, 0), rowTarget(review()))).toBe(true)
    }
  })

  it('offers where it lives under the pointer, as the side does', () => {
    const pointed = { hover: rowTarget(review()), pressed: null }
    const [top] = reviewRows(88, COLOUR, pointed, review(), NOW)
    expect(plain(top?.text ?? '')).toContain('↗')
    expect(top?.hits.find((hit) => hit.target.kind === 'link')?.target).toEqual({
      kind: 'link',
      url: 'https://github.com/acme/checkout/pull/412',
    })
  })

  it('has room for where it lives as well as what it counts, and drops that first', () => {
    const wide = plain(reviewRows(100, COLOUR, NO_POINTER, review(), NOW)[1]?.text ?? '')
    expect(wide).toContain('✓ checks')
    expect(wide).toContain('acme/checkout')
    expect(wide).toContain('1d 2h open')
    // A narrow pane keeps the checks and the figure and gives up the branch: a
    // branch is one `git` away and a red check is not.
    const narrow = plain(reviewRows(44, COLOUR, NO_POINTER, review(), NOW)[1]?.text ?? '')
    expect(narrow).toContain('✓ checks')
    expect(narrow).not.toContain('acme/checkout')
  })
})

const summary = (over: Partial<RowSummaryView> = {}): RowSummaryView => ({
  title: 'review #412 — retry refunds once',
  marks: [
    { text: 'open', tone: 'quiet' },
    { text: '✓ checks', tone: 'good' },
  ],
  groups: [
    {
      label: 'CHECKS',
      note: '1 passed · 1 failed · 2 ran',
      marks: [
        { text: '✓ format', tone: 'good' },
        { text: '✗ tests', tone: 'bad' },
      ],
    },
    { label: 'VERDICTS', note: 'nobody has said anything yet', marks: [] },
  ],
  facts: [{ label: 'Branch', value: 'retry-refunds → main' }],
  links: [{ title: 'review #412', url: 'https://github.com/acme/checkout/pull/412' }],
  ...over,
})

const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 120,
    height: 40,
    skin: COLOUR,
    pointer: NO_POINTER,
    scrolling: null,
    summary: summary(),
    ...over,
  }) as PanelContext

describe('the window a row opens in', () => {
  it('is drawn in the shared shell, every row as wide as the box', () => {
    const panel = rowSummaryPanel('review.open', 'github.com/acme/checkout#412', '#412', 'u')
    for (const [width, height] of [
      [60, 20],
      [120, 40],
      [200, 60],
    ]) {
      const drawn = drawPanel(panel, context({ width, height })).panel
      const wide = visibleWidth(plain(drawn.rows[0] ?? ''))
      for (const row of drawn.rows) expect(visibleWidth(plain(row))).toBe(wide)
    }
  })

  it('says what it is, every mark of every group, and the facts under them', () => {
    const panel = rowSummaryPanel('review.open', 'github.com/acme/checkout#412', '#412', 'u')
    const text = drawPanel(panel, context()).panel.rows.map(plain).join('\n')
    expect(text).toContain('review #412 — retry refunds once')
    expect(text).toContain('✓ format')
    expect(text).toContain('✗ tests')
    expect(text).toContain('1 passed · 1 failed · 2 ran')
    // A group with nothing in it says so rather than going: an absent heading
    // and "nothing has run" read identically, and only one of them is true.
    expect(text).toContain('VERDICTS')
    expect(text).toContain('nobody has said anything yet')
    expect(text).toContain('retry-refunds → main')
    expect(text).toContain('https://github.com/acme/checkout/pull/412')
  })

  it('says it is looking rather than looking empty, and then says why there is nothing', () => {
    const panel = rowSummaryPanel('review.open', 'x', '#412', 'u')
    const looking = drawPanel(panel, context({ summary: null }))
      .panel.rows.map(plain)
      .join('\n')
    expect(looking).toContain('Looking…')
    const failed = { ...panel, busy: false, problem: 'github.com would not say' }
    const said = drawPanel(failed, context({ summary: null }))
      .panel.rows.map(plain)
      .join('\n')
    expect(said).toContain('github.com would not say')
  })

  it('offers where it lives only where there is somewhere to go', () => {
    const withUrl = rowSummaryPanel('review.open', 'x', '#412', 'https://example.com/412')
    expect(drawPanel(withUrl, context()).panel.rows.map(plain).join('\n')).toContain('Open it')
    const without = rowSummaryPanel('review.open', 'x', '#412', null)
    expect(drawPanel(without, context()).panel.rows.map(plain).join('\n')).not.toContain('Open it')
  })

  it('reads, closes and carries out its two acts', () => {
    const panel = rowSummaryPanel('review.open', 'x', '#412', 'https://example.com/412')
    expect(panelKey(panel, 'escape', '').panel).toBeNull()
    const down = panelKey(panel, 'down', '').panel
    expect(down && 'scroll' in down ? down.scroll : null).toBe(1)
    // Nothing is thrown away by reading it, so the arrows are all it answers.
    expect(panelKey(panel, 'a', 'a').panel).toBe(panel)
    expect(panelClick(panel, 'close').panel).toBeNull()
    expect(panelClick(panel, 'open')).toMatchObject({ submit: true, choice: 'open' })
    expect(panelClick(panel, 'ask')).toMatchObject({ submit: true, choice: 'ask' })
  })

  it('offers no click where nothing is drawn', () => {
    const panel = rowSummaryPanel('review.open', 'x', '#412', null)
    const drawn = drawPanel(panel, context()).panel
    const controls = drawn.hits
      .map((hit) => hit.target)
      .filter((target: Target) => target.kind === 'control')
      .map((target) => (target.kind === 'control' ? target.id : ''))
    const text = drawn.rows.map(plain).join('\n')
    for (const id of new Set(controls)) {
      expect(text).toContain(id === 'ask' ? 'Ask about it' : 'Close')
    }
  })
})
