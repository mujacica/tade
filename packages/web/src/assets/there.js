// Another machine's screen, `/m/<machine>/…`: the same screen, built with no
// `ctx` (nothing to ask or press here), drawn out of that machine's copy and
// clock, its links that machine's (ONE-AWAY-VIEW §2.4, add-away-surface).

import { classOn, el, textIn } from './dom.js'
import { thereOf } from './machines.js'
import { THERE, thereHref } from './routes.js'

/** The router's screen for `at`, made another machine's where `at` is one. */
export function thereOn(at, screen) {
  if (typeof at.machine !== 'string' || !THERE.includes(at.view)) return screen
  const line = el('p', { class: 'there-line', attrs: { role: 'status' } })
  screen.node.prepend(line)
  return {
    node: screen.node,
    update(view) {
      const on = thereOf(view.store, at.machine, view.standing === 'live', view.now ?? Date.now())
      screen.update({ ...view, store: on.store, asOf: on.asOf, frozen: on.frozen })
      textIn(line, on.line)
      classOn(screen.node, 'is-there-down', !on.up)
      linksThere(screen.node, at.machine)
    },
    leave() {
      screen.leave?.()
    },
  }
}

/** Every link on a screen made `machine`'s (`thereHref`), or words. */
export function linksThere(node, machine) {
  for (const link of node.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    const made = thereHref(machine, href)
    if (made === null) link.removeAttribute('href')
    else if (made !== href) link.setAttribute('href', made)
  }
}
