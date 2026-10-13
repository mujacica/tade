// The reviews: branches offered for merge, and the finished work nobody has
// offered yet.

import { mayFor } from '../access.js'
import { el, empty, into, keyed, textIn } from '../dom.js'
import { count } from '../figures.js'
import { createReviewRow, fillReviewRow, section } from '../rows.js'
import { reviewsOf } from '../store.js'
import { note, panel } from '../ui.js'

/* ── the reviews ───────────────────────────────────────────────────────────── */

/**
 * Branches offered for merge, and then **the work that is finished and nobody
 * asked about** — which is the list worth having, and is invisible on a page
 * that shows only what a forge knows.
 *
 * Threads and comments are not here. Comments are attacker-controlled text, and
 * rendering them read-only on a phone is defensible and is still a scope
 * decision somebody has to take rather than one a convenient route takes for
 * them.
 */
export function reviewsScreen() {
  const node = el('div')
  const open = section('REVIEWS', { top: true })
  const openList = panel('ul', 'rows')
  const noOpen = empty('nothing is offered for merge')
  into(open.body, openList, noOpen)
  const quiet = section('NO REVIEW')
  const quietList = panel('ul', 'rows')
  const noQuiet = empty('nothing is waiting to be offered')
  into(quiet.body, quietList, noQuiet)
  // Without the grant only the **link** to each review is withheld
  // (`tasks.review.url`): whether a branch was offered, and how it stands, is
  // sent to every device and drawn below. Said before the lists, so a row with
  // no link reads as withheld rather than as a forge with nothing to open.
  const scope = note(
    'review links not granted',
    'This device was not granted the link to each review on its forge.',
    'reviews',
  )
  into(node, scope, open.node, quiet.node)

  return {
    node,
    update(view) {
      scope.hidden = mayFor(view.store, 'tasks.review.url')
      const { offered, unoffered } = reviewsOf(view.store)
      textIn(open.figure, count(offered.length))
      open.figure.setAttribute('aria-label', `${offered.length} offered for merge`)
      noOpen.hidden = offered.length > 0
      keyed(
        openList,
        offered,
        (task) => task.id,
        createReviewRow,
        (one, task) => fillReviewRow(one, task, view),
      )
      textIn(quiet.figure, count(unoffered.length))
      quiet.figure.setAttribute('aria-label', `${unoffered.length} not offered`)
      noQuiet.hidden = unoffered.length > 0
      keyed(
        quietList,
        unoffered,
        (task) => task.id,
        createReviewRow,
        (one, task) => fillReviewRow(one, task, view),
      )
    },
  }
}
