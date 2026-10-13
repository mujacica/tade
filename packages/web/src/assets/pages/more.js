// More: every place the tab bar has no room for, and the screen for a path this
// page does not know.

import { el, into, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { GROUPS, MORE, placeOf } from '../routes.js'
import { section } from '../rows.js'
import { panel } from '../ui.js'

/* ── More, and nowhere ─────────────────────────────────────────────────────── */

/**
 * The weekly reads, as a screen rather than a menu under the thumb: a grid of
 * places, each an icon and its word, with the count the rail carries.
 */
export function moreScreen() {
  const node = el('div')
  const made = section('MORE', { top: true })
  into(node, made.node)
  const figures = []
  // **The menu's own categories**, so a place is in one group on a phone and
  // at a desk alike. The projects are not here: they are the side, which a
  // phone opens from its tab bar.
  for (const group of GROUPS) {
    const views = group.views.filter((view) => MORE.some((one) => one.view === view))
    if (views.length === 0) continue
    const list = panel('ul', 'places')
    if (group.title === '') into(made.body, list)
    else {
      const part = section(group.title.toUpperCase())
      into(part.body, list)
      into(node, part.node)
    }
    for (const view of views) {
      const one = placeOf(view)
      const row = el('li')
      const link = el('a', { attrs: { href: `/${one.view}` } })
      const figure = el('span', { class: 'count' })
      into(link, icon(one.icon), el('span', { class: 'label', text: one.label }), figure)
      into(list, into(row, link))
      figures.push({ figure, counts: one.counts })
    }
  }
  return {
    node,
    update(view) {
      for (const one of figures) {
        const n = one.counts === null ? 0 : (view.counts?.[one.counts] ?? 0)
        textIn(one.figure, n === 0 ? '' : String(n))
      }
    },
  }
}

/**
 * A path the server served the shell for and this page does not know.
 *
 * Said rather than drawn as the overview: a link that silently landed somewhere
 * else is the worst kind of broken, because it looks like it worked.
 */
export function nowhereScreen() {
  const node = el('div', { class: 'column' })
  into(
    node,
    el('h1', { text: 'Not found' }),
    el('a', { class: 'press', text: 'Overview', attrs: { href: '/' } }),
  )
  return { node, update() {} }
}
