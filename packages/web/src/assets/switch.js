// The switch between the page's two modes, in each one's header (§10 T4 of
// the Duo plan): **Overview** and **Full view**, the one this page is marked
// as current and the other a link to it. Pressing one keeps it as this
// device's choice for the way up the screen is held now (`mode.js`), and goes.
//
// A link and not a button, because each mode is its own page — the full view
// is the document at `/draw/` whose import map loads the window's drawing,
// and an import map cannot be added to a page that is already running — so
// "the other mode" is somewhere to go, which a link says to everything that
// reads the page.

import { el, into } from './dom.js'
import { keepMode, MODES, modeNow, orientationOf } from './mode.js'

const NAMES = { overview: 'Overview', full: 'Full view' }

/**
 * The switch, drawn as `current`. `go(path)` is how the page leaves: a plain
 * navigation unless the page has a reason to wait (something typed).
 */
export function modeSwitch(current, go = (path) => location.assign(path)) {
  const nav = el('nav', { class: 'mode-switch', attrs: { 'aria-label': 'How Tade is drawn' } })
  for (const mode of Object.keys(MODES)) {
    const link = el('a', {
      class: 'mode',
      text: NAMES[mode],
      attrs: {
        href: MODES[mode],
        ...(mode === current ? { 'aria-current': 'page' } : {}),
      },
    })
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      keepMode(orientationOf(globalThis.innerWidth, globalThis.innerHeight), mode)
      if (mode !== current) go(MODES[mode])
    })
    into(nav, link)
  }
  return nav
}

/** Whether somebody has typed into a box on the page: nothing reloads or leaves under them. */
export function typing() {
  return [...document.querySelectorAll('textarea, input')].some(
    (one) => one.value.trim() !== '' && one.offsetParent !== null,
  )
}

/**
 * The full view, offered from the overview where the machine draws a window to
 * share: the switch (`switch`) shown, and the page going there when the way up
 * the screen is held says so — sideways, unless somebody chose the overview
 * there (`mode.js`) — now, and whenever the phone is turned. Asked of the
 * machine rather than assumed: `tade serve` draws no window, and its `/draw/`
 * is a `404`. Never leaving a page somebody is typing in, nor one with no
 * session (`inside`).
 */
export async function offerFull(switchNode, inside) {
  let offered = false
  try {
    offered = (await fetch(MODES.full, { credentials: 'same-origin' })).ok
  } catch {
    offered = false
  }
  if (!offered) return
  switchNode.hidden = false
  const follow = (how) => {
    if (!inside() || typing()) return
    if (modeNow(globalThis.innerWidth, globalThis.innerHeight) === 'full') location[how](MODES.full)
  }
  follow('replace')
  let way = orientationOf(globalThis.innerWidth, globalThis.innerHeight)
  addEventListener('resize', () => {
    const now = orientationOf(globalThis.innerWidth, globalThis.innerHeight)
    if (now === way) return
    way = now
    follow('assign')
  })
}
