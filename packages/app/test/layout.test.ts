import { describe, expect, it } from 'vitest'
import { asRemembered, CHROME, DEFAULTS, MINIMUM, resolveLayout } from '../src/layout.ts'

// A preference is a wish, not an instruction. Everything here is about what
// happens when the wish does not fit the terminal in front of you.

const big = { width: 200, height: 60 }

describe('resolveLayout', () => {
  it('uses the defaults when nothing was asked for', () => {
    const layout = resolveLayout({}, { width: 100, height: 40 })
    expect(layout.sidebarWidth).toBe(DEFAULTS.sidebarWidth)
    expect(layout.stripHeight).toBe(DEFAULTS.stripHeight)
  })

  it('gives the sidebar more room on a wide terminal, up to a point', () => {
    // Task names are the one thing in that column that has to stay readable,
    // and a fixed 24 beside 200 columns of agent is a ribbon.
    expect(resolveLayout({}, big).sidebarWidth).toBeGreaterThan(DEFAULTS.sidebarWidth)
    expect(resolveLayout({}, { width: 400, height: 60 }).sidebarWidth).toBeLessThanOrEqual(36)
  })

  it('honours a preference that fits', () => {
    const layout = resolveLayout({ sidebarWidth: 40, stripHeight: 14 }, big)
    expect(layout.sidebarWidth).toBe(40)
    expect(layout.stripHeight).toBe(14)
  })

  it('always leaves room for the thing you are trying to watch', () => {
    // A 90-column sidebar in a 100-column terminal is not a layout.
    const layout = resolveLayout({ sidebarWidth: 90 }, { width: 100, height: 40 })
    expect(layout.mainWidth).toBeGreaterThanOrEqual(MINIMUM.main)
    expect(layout.sidebarWidth + layout.mainWidth + 1).toBe(100)
  })

  it('keeps the bottom panel to a third unasked: it is context, not the view', () => {
    expect(resolveLayout({}, { width: 120, height: 24 }).stripHeight).toBeLessThanOrEqual(8)
  })

  it('gives the bottom panel what you dragged it to, leaving the agent a few rows', () => {
    const layout = resolveLayout({ stripHeight: 50 }, { width: 120, height: 30 })
    expect(layout.stripHeight).toBe(30 - CHROME - 4)
    expect(layout.bodyHeight).toBe(4)
  })

  it('fills the window with the bottom panel, or folds it to its tabs', () => {
    expect(resolveLayout({ bottom: 'max' }, { width: 120, height: 40 }).bodyHeight).toBe(4)
    expect(
      resolveLayout({ bottom: 'min', stripHeight: 12 }, { width: 120, height: 40 }).stripHeight,
    ).toBe(1)
  })

  it('refuses to shrink a region into decoration', () => {
    const layout = resolveLayout({ sidebarWidth: 1, stripHeight: 1 }, big)
    expect(layout.sidebarWidth).toBe(MINIMUM.sidebar)
    expect(layout.stripHeight).toBe(MINIMUM.strip)
  })

  it('still produces a usable window in a tiny terminal', () => {
    const layout = resolveLayout({}, { width: 20, height: 5 })
    expect(layout.sidebarWidth).toBeGreaterThanOrEqual(MINIMUM.sidebar)
    expect(layout.bodyHeight).toBeGreaterThanOrEqual(MINIMUM.body)
    expect(layout.stripHeight).toBeGreaterThanOrEqual(MINIMUM.strip)
  })

  it('rounds a fractional preference rather than rendering half a column', () => {
    expect(resolveLayout({ sidebarWidth: 25.6 }, big).sidebarWidth).toBe(26)
  })
})

describe('asRemembered', () => {
  it('reads back which pane you were on', () => {
    expect(asRemembered({ focused: 'checkout/refunds' })).toEqual({ focused: 'checkout/refunds' })
  })

  it('reads back the sizes you dragged the dividers to, and nothing that is not a size', () => {
    expect(asRemembered({ focused: null, sidebarWidth: 30.4, stripHeight: 12 })).toEqual({
      focused: null,
      sidebarWidth: 30,
      stripHeight: 12,
    })
    expect(asRemembered({ focused: null, sidebarWidth: -3, stripHeight: 'tall' })).toEqual({
      focused: null,
    })
  })

  it('reads back the order agents were dragged into, and only names in it', () => {
    expect(
      asRemembered({ focused: null, order: { app: ['app/b', 7, 'app/a'], bad: 'app/c' } }),
    ).toEqual({ focused: null, order: { app: ['app/b', 'app/a'] } })
  })

  it('reads back the view choices in the sidebar headings, either way round', () => {
    // `false` is a choice — you pressed `H` again — and so is an empty list of
    // folded sections. Only a file that never said is a file that says nothing.
    expect(asRemembered({ focused: null, hidingDone: true, folded: ['notes', 'queue'] })).toEqual({
      focused: null,
      hidingDone: true,
      folded: ['notes', 'queue'],
    })
    expect(asRemembered({ focused: null, hidingDone: false, folded: [] })).toEqual({
      focused: null,
      hidingDone: false,
      folded: [],
    })
    expect(asRemembered({ focused: null })).toEqual({ focused: null })
  })

  it('drops a view choice that is not one, rather than starting the window on it', () => {
    expect(asRemembered({ focused: null, hidingDone: 'yes', folded: 'notes' })).toEqual({
      focused: null,
    })
    expect(asRemembered({ focused: null, folded: ['notes', 7, null] })).toEqual({
      focused: null,
      folded: ['notes'],
    })
  })

  it('is null on anything it does not recognise', () => {
    // A layout file is a convenience; refusing to open the window over one
    // would be absurd.
    for (const bad of [null, 'text', 42, []]) {
      expect(asRemembered(bad)).toBeNull()
    }
  })

  it('drops nonsense sizes but keeps the focus', () => {
    expect(asRemembered({ focused: 'a/b', sidebarWidth: -5, stripHeight: 'wide' })).toEqual({
      focused: 'a/b',
    })
  })

  it('copes with a file that remembers nothing in particular', () => {
    expect(asRemembered({})).toEqual({ focused: null })
  })
})
