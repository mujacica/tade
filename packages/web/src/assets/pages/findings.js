// The findings: what a judge asked about a change, and whose move each one is.

import { mayFor } from '../access.js'
import { el, empty, into, keyed, textIn } from '../dom.js'
import { count } from '../figures.js'
import { createFindingRow, fillFindingRow, nothingSaid, section } from '../rows.js'
import { findingsOf, omitted } from '../store.js'
import { panel } from '../ui.js'

/* ── the findings ──────────────────────────────────────────────────────────── */

/**
 * Open findings, and whose move each one is.
 *
 * **A finding is material and not a verdict.** A probability is drawn beside the
 * question rather than as the answer to it, and no sentence here says a change
 * is wrong — it says a question was asked about it, who has answered, and
 * whether anybody has read it yet.
 */
export function findingsScreen() {
  const node = el('div')
  const made = section('FINDINGS', {
    top: true,
    hint: 'A judge answers questions; it never decides. A probability is not a verdict, and the account under one is the agent’s own testimony.',
  })
  const list = panel('ul', 'rows')
  const none = empty('no findings')
  into(made.body, list, none)
  into(node, made.node)

  return {
    node,
    update(view) {
      const rows = findingsOf(view.store).sort(
        (a, b) => whose(a) - whose(b) || b.probability - a.probability,
      )
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} findings`)
      none.hidden = rows.length > 0
      textIn(
        none,
        nothingSaid(mayFor(view.store, 'findings'), omitted(view.store, 'findings'), 'no findings'),
      )
      keyed(
        list,
        rows,
        (row) => row.key,
        createFindingRow,
        (one, row) => fillFindingRow(one, row, view),
      )
    },
  }
}

/** Waiting on a person first, then on an agent, then done with. */
function whose(finding) {
  if (finding.verdict !== null && finding.verdict !== undefined) return 2
  return finding.accounted ? 0 : 1
}
