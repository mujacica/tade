import { describe, expect, it } from 'vitest'
import type { LaneView } from '../src/frame.ts'
import { KEPT_SCREENS, Screens } from '../src/wire/shown.ts'

// A lane's screen is that lane's. A focus moves between two looks, and what the
// last look read is then somebody else's: the pane used to draw the agent you
// had just left under the name of the one you had gone to, for up to a beat.

const view: LaneView = {
  lines: 12,
  cursor: { back: 0, column: 3 },
  scrolling: 'window',
  pointing: 'nobody',
}

describe('whose screen is on screen', () => {
  it("shows a lane's own last screen when the focus comes back to it, and owes a look", () => {
    const screens = new Screens()
    screens.read('pane', { lane: 'refunds/agent', screen: 'refunds says', view }, true)
    screens.read('pane', { lane: 'search/agent', screen: 'search says', view: null }, true)

    // Back to refunds before any look has read it again.
    expect(screens.front('pane', 'refunds/agent')).toBe(true)
    expect(screens.of('pane')).toEqual({ lane: 'refunds/agent', screen: 'refunds says', view })
    // And nothing more is owed once it is the lane in front.
    expect(screens.front('pane', 'refunds/agent')).toBe(false)
  })

  it("shows nothing for a lane never read, and never another lane's", () => {
    const screens = new Screens()
    screens.read('pane', { lane: 'refunds/agent', screen: 'refunds says', view }, true)
    expect(screens.front('pane', 'search/agent')).toBe(true)
    expect(screens.of('pane')).toEqual({ lane: 'search/agent', screen: '', view: null })
  })

  it('comes back to a lane at its newest line, never at where it was scrolled back to', () => {
    const screens = new Screens()
    screens.read('pane', { lane: 'refunds/agent', screen: 'the end', view }, true)
    screens.read('pane', { lane: 'refunds/agent', screen: 'an hour ago', view }, false)
    screens.front('pane', 'search/agent')
    screens.front('pane', 'refunds/agent')
    expect(screens.of('pane').screen).toBe('the end')
  })

  it('says a read changed what an area shows only when it did', () => {
    const screens = new Screens()
    expect(screens.read('terminal', { lane: 't1', screen: '$ ', view: null }, true)).toBe(true)
    expect(screens.read('terminal', { lane: 't1', screen: '$ ', view: null }, true)).toBe(false)
    // The same text from another lane is another screen.
    expect(screens.read('terminal', { lane: 't2', screen: '$ ', view: null }, true)).toBe(true)
  })

  it('keeps the screens of the lanes somebody moves between, not of every lane there is', () => {
    const screens = new Screens()
    for (let i = 0; i <= KEPT_SCREENS; i++) {
      screens.read('pane', { lane: `lane-${i}`, screen: `screen ${i}`, view: null }, true)
    }
    // The oldest went to make room; the newest of them are all still there.
    screens.front('pane', 'lane-0')
    expect(screens.of('pane').screen).toBe('')
    screens.front('pane', 'lane-1')
    expect(screens.of('pane').screen).toBe('screen 1')
  })

  it('keeps each area apart: a terminal coming to the front leaves the pane where it was', () => {
    const screens = new Screens()
    screens.read('pane', { lane: 'refunds/agent', screen: 'refunds says', view }, true)
    expect(screens.front('terminal', 't1')).toBe(true)
    expect(screens.front('pane', 'refunds/agent')).toBe(false)
    expect(screens.of('pane').screen).toBe('refunds says')
  })
})
