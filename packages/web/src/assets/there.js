// Another machine's screen: `/m/<machine>/…` (`THERE` in `routes.js`,
// ONE-AWAY-VIEW §2.4).
//
// **The same screens, drawn out of that machine's copy.** A project and a task
// of the Mac's on ipax's page are the screens a project and a task of ipax's
// are, handed the Mac's copy (`thereOf`) for a store and its clock for theirs,
// so nothing is drawn twice and nothing reads a copy differently.
//
// **No `ctx`** — the router's to withhold (`boot.js`) — so nothing on them
// asks this door anything or offers a press: this door's routes are this
// machine's tasks, and what may be done to another machine's from here is its
// own step (§2.5). **Their links are that
// machine's** (`thereHref`): a project or a task under `/m/<machine>/`, and a
// link to a screen of this door's — its findings, its plans, which are not
// that machine's — drawn as its words.
//
// One line over the screen says whose it is and as of when, and while that
// machine is not up the rest is dimmed as a held page is.

import { classOn, el, textIn } from './dom.js'
import { thereOf } from './machines.js'
import { THERE, thereHref } from './routes.js'

/**
 * The screen the router built for `at`, made another machine's where `at` is
 * one — the router built it with no `ctx` — and as it was where it is not.
 */
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

/** Every link a screen drew, made `machine`'s (`thereHref`), or words where it is not. */
export function linksThere(node, machine) {
  for (const link of node.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    const made = thereHref(machine, href)
    if (made === null) link.removeAttribute('href')
    else if (made !== href) link.setAttribute('href', made)
  }
}
