// The notes: what Tade was told, newest first and verbatim.

import { mayFor } from '../access.js'
import { el, empty, into, keyed, textIn } from '../dom.js'
import { count } from '../figures.js'
import { createNoteRow, fillNoteRow, nothingSaid, section } from '../rows.js'
import { notesOf, omitted } from '../store.js'
import { troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { answerIn, panel } from '../ui.js'

/* ── the notes ─────────────────────────────────────────────────────────────── */

/**
 * The notes, newest first and **verbatim**.
 *
 * Never lowercased, never reworded, never summarised. This is the one thing on
 * the page that Tade was *told* rather than derived, and it is rendered with
 * `textContent` and in the shape it was typed.
 */
export function notesScreen(ctx = null) {
  const node = el('div')
  const made = section('NOTES', { top: true })
  const list = panel('ul', 'rows notes')
  // **The older pages, asked for, not sent.** The snapshot carries the newest
  // notes and a cursor past them (`pages.notes.next`); each press asks the
  // machine for the page after it (`/api/notes?after=`), and what came is
  // drawn under the newest. Notes are append-only, so a page once read stays
  // true — and a cursor the machine no longer knows starts over and says so.
  const older = panel('ul', 'rows notes')
  const none = empty('nothing written down')
  into(made.body, list, older, none)
  const more = el('button', { class: 'press ghost more-page', attrs: { type: 'button' } })
  const moreSaid = el('p', { attrs: { role: 'status' } })
  const left = el('p', { class: 'unknown' })
  into(node, made.node, more, moreSaid, left)

  let held = []
  let cursor = null
  let asking = false
  let last = null

  more.addEventListener('click', async () => {
    if (ctx === null || asking || cursor === null) return
    asking = true
    more.disabled = true
    const answer = await ctx.ask('GET', `/api/notes?after=${encodeURIComponent(cursor)}`)
    asking = false
    more.disabled = false
    if (answer.status !== 200 || answer.body === null) {
      answerIn(moreSaid, '', troubleOf(answer) ?? UNKNOWN_TROUBLE)
      return
    }
    const page = answer.body
    held = page.restarted === true ? [...page.rows] : [...held, ...page.rows]
    cursor = page.next ?? null
    textIn(
      moreSaid,
      page.restarted === true ? 'The notes moved; started again from the newest.' : '',
    )
    if (last !== null) draw(last)
  })

  const draw = (view) => {
    last = view
    const rows = notesOf(view.store)
    const shown = new Set(rows.map((row) => row.id))
    const extra = held.filter((row) => !shown.has(row.id))
    const total = view.store.pages.notes?.total ?? rows.length
    textIn(made.figure, count(total))
    made.figure.setAttribute('aria-label', `${total} notes`)
    none.hidden = rows.length > 0
    keyed(
      list,
      rows,
      (row) => row.id,
      createNoteRow,
      (one, row) => fillNoteRow(one, row, view),
    )
    keyed(
      older,
      extra,
      (row) => row.id,
      createNoteRow,
      (one, row) => fillNoteRow(one, row, view),
    )
    textIn(
      none,
      nothingSaid(
        mayFor(view.store, 'notes'),
        omitted(view.store, 'notes'),
        'nothing written down',
      ),
    )
    if (cursor === null && held.length === 0) cursor = view.store.pages.notes?.next ?? null
    const n = Math.max(0, total - rows.length - extra.length)
    const may = mayFor(view.store, 'notes')
    more.hidden = !may || n === 0 || cursor === null || ctx === null
    textIn(more, `Show older · ${n}`)
    textIn(left, n === 0 || !may || !more.hidden ? '' : `${n} older notes are not on this page`)
    left.hidden = n === 0 || !may || !more.hidden
  }

  return { node, update: draw }
}
