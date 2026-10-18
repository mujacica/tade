// A conversation read as a chat is: it opens at the newest line, stays there
// while more arrive, and lets go the moment somebody scrolls up to read — with
// one press to come back down that only shows while they are away from it.
//
// **Whose the scroll is, is the reader's**: nothing here moves a region the
// reader has scrolled up in. A reply arriving pulls the view down only while
// it is already at the foot, which is what *following* means; scrolling up is
// the reader saying they are reading something else, and the press is how
// they say they are done.
//
// The rule is `atFoot`, pure, so a test can hold it without a layout; the rest
// is the wiring between a region that scrolls and the press.

import { el } from './dom.js'
import { icon } from './icons.js'

/**
 * How near the foot still counts as at it, in pixels: a line's breadth, so a
 * fraction of a pixel of rounding, or the last line half drawn, never reads as
 * somebody having scrolled away.
 */
export const FOOT_SLACK = 48

/** Whether a region scrolled this far is at its foot. */
export function atFoot(scrollTop, clientHeight, scrollHeight, slack = FOOT_SLACK) {
  return scrollHeight - (scrollTop + clientHeight) <= slack
}

/**
 * Follow the newest line of a region that scrolls.
 *
 * `scroller` is the region (a function, because the screen's own region is
 * the frame's `main`, which it is put into only after it is built), and the
 * press it returns goes wherever the screen draws it. Call `drawn()` after
 * every paint: following, it puts the view at the foot; scrolled up, it leaves
 * the view where the reader put it and shows the press.
 */
export function followOf(scroller, words = 'Jump to latest') {
  const press = el('button', {
    class: 'jump-latest',
    attrs: { type: 'button', 'aria-label': words },
  })
  press.append(icon('chevron'), el('span', { text: 'Latest' }))
  press.hidden = true
  let following = true
  /** Where the region was last scrolled to: what tells the reader going up from the lines growing. */
  let lastTop = 0
  let held = null

  const region = () => {
    const now = scroller()
    if (now !== held && now !== null && now !== undefined) {
      held = now
      lastTop = now.scrollTop
      // Passive: reading where somebody is never holds their scrolling up.
      now.addEventListener('scroll', heard, { passive: true })
    }
    return held
  }
  /**
   * What the reader did. **Reaching the foot is following, and only going up
   * is letting go** — never the lines growing under the view, which moves the
   * foot away without anybody scrolling: a reply drawn between this page's own
   * scroll down and the browser saying so would otherwise read as somebody
   * having scrolled up to read.
   */
  function heard() {
    const at = region()
    if (at === null) return
    const top = at.scrollTop
    if (atFoot(top, at.clientHeight, at.scrollHeight)) following = true
    else if (top < lastTop - 1) following = false
    lastTop = top
    press.hidden = following
  }
  const toFoot = (smooth) => {
    const at = region()
    if (at === null) return
    const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    at.scrollTo?.({ top: at.scrollHeight, behavior: smooth && !calm ? 'smooth' : 'auto' })
  }
  /**
   * Down to the newest line, in the frame after a paint — unless the reader
   * went up since the browser last said where they were: their scroll may land
   * between the paint and its event, and following it down would take back
   * what they just did.
   */
  const down = () => {
    const at = region()
    if (!following || at === null) return
    if (at.scrollTop < lastTop - 1) {
      following = false
      lastTop = at.scrollTop
      press.hidden = false
      return
    }
    toFoot(false)
  }
  press.addEventListener('click', () => {
    following = true
    press.hidden = true
    toFoot(true)
  })

  return {
    press,
    /** After a paint: down to the newest line while following, never otherwise. */
    drawn() {
      if (region() === null) return
      if (following) requestAnimationFrame(down)
      else press.hidden = false
    },
    /** The screen is gone: stop listening to a region that outlives it (the frame's `main`). */
    leave() {
      held?.removeEventListener('scroll', heard)
      held = null
    },
    /** Whether it is following now: for a test, and for nothing that decides. */
    get following() {
      return following
    },
  }
}
