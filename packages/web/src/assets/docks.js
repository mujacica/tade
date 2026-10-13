// The three docks round the work, and how each one folds: the menu on the left,
// the work on the right (`side.js`), Tade at the foot (`desk.js`).
//
// **One press, three meanings, decided by the room there is** — never by what
// device this is:
//
// - At a desk each dock is a part of the frame, and folding it gives its room
//   to the work: the menu to its icons, the side to the marks of its agents,
//   Tade to its heading line. Kept per device, because the person folding the
//   side on a laptop wants it folded tomorrow and not on their phone.
// - Below that, the side is a drawer over the work, opened from the header and
//   closed from its own foot, and on a phone Tade is a sheet from the foot of
//   the screen. A drawer is never *remembered* open: coming back to a page that
//   is covered is coming back to the wrong page.
//
// The fold is a class on the frame and nothing else, so the stylesheet decides
// what each state looks like at each width (`dock.css`) and a resize needs no
// script.
//
// **The one thing this page keeps in `localStorage`, and it is three words the
// page wrote itself** — which of `menu`, `side` and `tade` are folded — read
// back through `foldsFrom`, which knows no other word, so nothing else can ride
// in on the key. Nothing about anybody's work: which *projects* are folded is
// kept in memory only (`side.js`), because a name is text and what a device
// keeps has none (`LAST_VIEW_IS_A_COPY`). Here rather than in Cache Storage
// beside the last view, because that store is not there on a plain address,
// and a desk on the LAN would forget its folds on every load. Signing out
// clears it with everything else (`forgetFolds`). Read and written inside a
// `try`: a private window, a blocked store or a full disk is a page whose docks
// start open, never a page that does not start.

import { foldsFrom, foldsTo } from './tree.js'

/** The key the folds are kept under. */
const FOLDS_KEY = 'tade.docks.folded'

/** What this device kept of the folds, or null where it kept nothing or cannot say. */
function keptFolds() {
  try {
    return globalThis.localStorage?.getItem(FOLDS_KEY) ?? null
  } catch {
    return null
  }
}

/** Keep the folds on this device, or quietly do not: a dock that forgets is a dock that opens. */
function keepFolds(value) {
  try {
    if (value === '') globalThis.localStorage?.removeItem(FOLDS_KEY)
    else globalThis.localStorage?.setItem(FOLDS_KEY, value)
  } catch {
    // Nothing to do about a store this browser will not lend, and nothing on
    // the page depends on it: the folds are the frame's classes either way.
  }
}

/** The folds gone, with everything else this device kept, on signing out. */
export function forgetFolds() {
  keepFolds('')
}

/** The widths at which a dock is a part of the frame rather than a drawer. Held equal to `dock.css`. */
const DOCKED_FROM = { menu: 1100, side: 1280, tade: 768 }

const docked = (which) =>
  globalThis.matchMedia?.(`(min-width: ${DOCKED_FROM[which]}px)`).matches === true

/**
 * The folds wired to the frame: the kept state put back, every press that
 * folds or opens a dock, and the keys. Returns `toggle(which)` for the
 * keyboard, and `close()` for Escape, which says whether it closed anything.
 */
export function docksOn(shown) {
  const folds = foldsFrom(keptFolds())
  const frame = shown.frame
  const open = { side: false, tade: false }
  /** The press that opened a drawer, which is where the keyboard goes back to when it closes. */
  let opener = null

  const paint = () => {
    frame.classList.toggle('rail-mini', folds.menu)
    frame.classList.toggle('side-mini', folds.side)
    frame.classList.toggle('tade-mini', folds.tade)
    frame.classList.toggle('side-open', open.side)
    frame.classList.toggle('tade-open', open.tade)
    for (const [which, press] of Object.entries(shown.folds)) {
      for (const one of press) said(one, which)
    }
    shown.scrim.hidden = !(open.side || open.tade)
  }

  /** What a press says, which is what pressing it does now — at this width, in this state. */
  const said = (press, which) => {
    const name = { menu: 'the menu', side: 'agents and queue', tade: 'Tade' }[which]
    const drawer = which !== 'menu' && !docked(which)
    const shut = drawer ? !open[which] : folds[which]
    const word = drawer
      ? shut
        ? `Open ${name}`
        : `Close ${name}`
      : shut
        ? `Unfold ${name}`
        : `Fold ${name}`
    press.setAttribute('aria-label', word)
    press.setAttribute('aria-expanded', shut ? 'false' : 'true')
    const words = press.querySelector('.fold-said')
    if (words !== null)
      words.textContent = drawer ? (shut ? 'Open' : 'Close') : shut ? 'Expand' : 'Collapse'
  }

  const toggle = (which, from = null) => {
    if (which !== 'menu' && !docked(which)) {
      // On the conversation's own screen the dock is not drawn — the screen
      // is the whole of it — so its press goes to that screen's box rather
      // than raising a sheet with nothing in it.
      if (which === 'tade' && shown.dock?.hidden === true) {
        shown.main.querySelector('textarea')?.focus()
        return
      }
      if (open[which]) {
        close()
        return
      }
      open.side = false
      open.tade = false
      open[which] = true
      opener =
        from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      paint()
      ;(which === 'side' ? shown.side : shown.dock)?.querySelector('a, button, textarea')?.focus()
      return
    }
    folds[which] = !folds[which]
    keepFolds(foldsTo(folds))
    paint()
  }

  const close = () => {
    if (!open.side && !open.tade) return false
    open.side = false
    open.tade = false
    paint()
    // Back to whatever opened it, where that is still on the screen.
    if (opener !== null && opener.offsetParent !== null) opener.focus()
    opener = null
    return true
  }

  for (const [which, press] of Object.entries(shown.folds)) {
    for (const one of press) one.addEventListener('click', () => toggle(which, one))
  }
  shown.scrim.addEventListener('click', close)
  // A drawer left open while the window grew into a desk is a part of the frame
  // now: the class goes, and the words on every press follow the width.
  for (const which of Object.keys(DOCKED_FROM)) {
    globalThis
      .matchMedia?.(`(min-width: ${DOCKED_FROM[which]}px)`)
      .addEventListener?.('change', () => {
        if (which !== 'menu') open[which] = false
        paint()
      })
  }
  // Following a link out of a drawer is leaving it.
  for (const part of [shown.side, shown.dock]) {
    part?.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) close()
    })
  }
  paint()
  return { toggle, close }
}
