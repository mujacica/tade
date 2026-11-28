// Notifications to this device: one press in the header, where the overview is
// (§10 T5 of the Duo plan). It was a row of the Devices page; that page is a
// panel of the window now, and the window cannot ask this browser for a
// subscription — only a press on this page can (`push.js`'s `subscribe`).
//
// **Absent where the machine offers none**, because a press that can never do
// anything is a question somebody has to go and answer. Drawn wherever it is
// offered, whatever this browser can do: a press that cannot subscribe says
// why in a bar (`PUSH_SAID`), since a missing bell on a phone that was not
// added to the home screen is a silence nobody can find the reason for.

import { el, into } from './dom.js'
import { icon } from './icons.js'
import { NOT_OFFERED, OFF, ON, PUSH_SAID, pushState, subscribe, unsubscribe } from './push.js'

/** The bell's words for where this device stands: what pressing it would do. */
export function bellSaid(state) {
  if (state === ON) return 'Notifications on: stop telling this device'
  if (state === OFF) return 'Tell this device when work wants you'
  return 'Notifications: why this device cannot be told'
}

/**
 * The press, and the bar it raises when pressing it could not turn anything
 * on. `shell()` is what the machine offers (`/api/devices`'s `shell`);
 * `paint()` draws the page again after a change.
 */
export function bellOf(ctx, shell, paint) {
  const node = el('button', {
    class: 'tap icon bell',
    attrs: { type: 'button', 'aria-label': bellSaid(OFF), 'aria-pressed': 'false' },
  })
  into(node, icon('bell'))
  node.hidden = true
  let state = NOT_OFFERED
  /** Why the last press turned nothing on, or null. */
  let why = null
  let busy = false

  const show = () => {
    node.hidden = state === NOT_OFFERED
    node.setAttribute('aria-label', bellSaid(state))
    node.setAttribute('aria-pressed', state === ON ? 'true' : 'false')
    node.classList.toggle('is-on', state === ON)
  }

  node.addEventListener('click', async () => {
    if (busy) return
    busy = true
    try {
      if (state === ON) state = await unsubscribe(ctx.ask)
      else if (state === OFF) state = await subscribe(shell(), ctx.ask)
      // Pressed where it cannot be turned on: the press is the question, the bar its answer.
      why = state === ON || state === OFF ? null : PUSH_SAID[state]
    } finally {
      busy = false
    }
    show()
    paint()
  })

  return {
    node,
    /** Ask the browser where this device stands, once the machine has said what it offers. */
    async read() {
      state = await pushState(shell())
      show()
      paint()
    },
    /** The bar a press that turned nothing on raised, until the next press. */
    bars() {
      if (why === null) return []
      return [
        {
          key: 'bell',
          tone: 'is-stale',
          glyph: '◔',
          lead: 'Notifications are not on here.',
          under: `${why[0].toUpperCase()}${why.slice(1)}.`,
        },
      ]
    },
  }
}
