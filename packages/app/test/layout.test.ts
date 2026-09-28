import { describe, expect, it } from 'vitest'
import {
  asRemembered,
  CHROME,
  DEFAULTS,
  MINIMUM,
  resolveLayout,
  worthKeeping,
} from '../src/layout.ts'
import { QUEUE_SCOPES } from '../src/queue-view.ts'

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

  it('reads back the order the project tabs were moved into, and keeps one that is closed', () => {
    // A project in the row that the config no longer has is not dropped here:
    // it may be opened again this afternoon, and a place thrown away on the
    // way in is one nobody can get back. `projects` is what leaves it out of
    // the tabs while it is gone.
    expect(asRemembered({ focused: null, projectOrder: ['infra', 7, 'app'] })).toEqual({
      focused: null,
      projectOrder: ['infra', 'app'],
    })
    // A row nobody arranged is not written down, so nothing is read back.
    expect(asRemembered({ focused: null, projectOrder: [] })).toEqual({ focused: null })
    expect(asRemembered({ focused: null, projectOrder: 'app' })).toEqual({ focused: null })
  })

  it('reads back where you were standing in each project, and skips what is not one', () => {
    expect(
      asRemembered({
        focused: 'app/search',
        spots: {
          // A tab is never written down, so one in the file is not read back.
          app: { focused: 'app/search', bottom: 'app/terminals/1' },
          infra: { focused: null },
          // Neither of these is a spot, and neither is a reason to open the
          // window on no preferences at all.
          bad: 'app/a',
          worse: { focused: 7 },
        },
      }),
    ).toEqual({
      focused: 'app/search',
      spots: { app: { focused: 'app/search' }, infra: { focused: null }, worse: { focused: null } },
    })
  })

  it('reads back what each project was showing in its queue, and no scope nobody offers', () => {
    expect(
      asRemembered({
        focused: null,
        queueViews: {
          app: { scope: 'next' },
          // Written before the schedules got a section of their own, so it has
          // a `timed` beside its scope. Ignored rather than refused: throwing
          // the row away would lose the scope that was written with it.
          infra: { scope: 'all', timed: false },
          // None of these is a view, and none is a reason to open the window
          // on no preferences at all. A scope nothing offers matters most: read
          // back as one, it would leave a project showing something no control
          // could put right.
          made_up: { scope: 'timed' },
          bad: 'next',
        },
      }),
    ).toEqual({
      focused: null,
      queueViews: {
        app: { scope: 'next' },
        infra: { scope: 'all' },
      },
    })
  })

  it('reads back every scope the queue offers, so a new one cannot be dropped here', () => {
    // The one place a word of the queue's is spelt twice. This is what holds
    // the two lists together: add a scope to `QUEUE_SCOPES` and forget this
    // file, and a project set to it comes back as no preference at all.
    for (const scope of QUEUE_SCOPES) {
      expect(asRemembered({ focused: null, queueViews: { app: { scope } } })?.queueViews).toEqual({
        app: { scope },
      })
    }
  })

  it('keeps the agent out of a spot and never the tab, which cannot outlive the window', () => {
    // A terminal is a lane of the window's own, and under the default driver
    // closing Tade ends it — so a tab written down is one nothing could ever
    // go back to, which is worse than not offering it.
    expect(
      worthKeeping({
        app: { focused: 'app/search', bottom: 'app/terminals/1' },
        infra: { focused: null },
      }),
    ).toEqual({ app: { focused: 'app/search' }, infra: { focused: null } })
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
    // And the other half of that choice: the sections you opened that would
    // fold themselves away, which is the SMART QUEUE with nothing in it.
    expect(asRemembered({ focused: null, opened: ['queue'] })).toEqual({
      focused: null,
      opened: ['queue'],
    })
  })

  it('drops a view choice that is not one, rather than starting the window on it', () => {
    expect(asRemembered({ focused: null, hidingDone: 'yes', folded: 'notes' })).toEqual({
      focused: null,
    })
    expect(asRemembered({ focused: null, folded: ['notes', 7, null] })).toEqual({
      focused: null,
      folded: ['notes'],
    })
    expect(asRemembered({ focused: null, opened: 'queue' })).toEqual({ focused: null })
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
