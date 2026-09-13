import { describe, expect, it } from 'vitest'
import { asRemembered, DEFAULTS, MINIMUM, resolveLayout } from '../src/layout.ts'

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

  it('keeps the strip to a third at most: it is context, not the view', () => {
    const layout = resolveLayout({ stripHeight: 50 }, { width: 120, height: 30 })
    expect(layout.stripHeight).toBeLessThanOrEqual(10)
    expect(layout.bodyHeight).toBeGreaterThanOrEqual(MINIMUM.body)
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

  it('ignores sizes it may find written down', () => {
    // Sizes come from the config, so a copy of them here could only ever be a
    // stale second answer to a question that already has one.
    expect(asRemembered({ focused: 'checkout/refunds', sidebarWidth: 30 })).toEqual({
      focused: 'checkout/refunds',
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
