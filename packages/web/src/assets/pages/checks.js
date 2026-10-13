// The checks: what a run *here* added up to, per project and per task. A rollup
// is what a run on this machine adds up to, so `unknown` is first-class and is
// never folded into a pass; a check that cannot run here keeps its row.
//
// A table is the one thing allowed to be wider than the viewport, in its own
// `overflow-x` container, a real `<table>` with a `<caption>` and `<th scope>`.

import { ringIn, ringOf } from '../charts.js'
import { classOn, el, empty, into, keyed, textIn, toneOn } from '../dom.js'
import { checkMark } from '../glyphs.js'
import { pathOf } from '../routes.js'
import { section } from '../rows.js'
import { checksFold, checksWord, projectsOf, rowsOf, tasksIn } from '../store.js'
import { countIn, count as countOf } from '../ui.js'

/* ── the checks ────────────────────────────────────────────────────────────── */

export function checksScreen() {
  const node = el('div')
  const made = section('CHECKS', { top: true })
  // **A region that scrolls has to be reachable by a keyboard.** A table wider
  // than a phone is the one thing in this design allowed to scroll sideways,
  // and a container nobody can focus is one a keyboard cannot move.
  const wrap = el('div', {
    class: 'scrolls ui-panel',
    attrs: { tabindex: '0', role: 'region', 'aria-label': 'Checks, scrollable' },
  })
  const table = el('table')
  // Read aloud, not drawn: the table's own marks (`—` and *not run here*)
  // already say on every row what the sentence says once.
  const caption = el('caption', {
    class: 'sr-only',
    text: 'What a run on this machine added up to, per task. A check nobody ran here is not a check that passed.',
  })
  const head = el('thead')
  const headRow = el('tr')
  for (const [name, klass] of [
    ['Project', ''],
    ['Task', ''],
    ['Checks', ''],
    ['Red', ''],
    ['Not run here', ''],
  ]) {
    into(headRow, el('th', { class: klass, text: name, attrs: { scope: 'col' } }))
  }
  into(head, headRow)
  const body = el('tbody')
  into(table, caption, head, body)
  into(wrap, table)
  const none = empty('no tasks to check')
  // Every project's checks as a ring and three counts, above the table of
  // every task: the shape first, the rows for whoever needs them.
  const cards = el('div', { class: 'check-cards' })
  into(made.body, cards, wrap, none)
  into(node, made.node)

  return {
    node,
    update(view) {
      const tasks = rowsOf(view.store, 'tasks')
      const fold = checksFold(tasks)
      const mark = checkMark(checksWord(fold))
      textIn(made.figure, mark.word)
      // The word as a pill in its own tone: the one figure this heading has.
      classOn(made.figure, 'ui-pill', true)
      toneOn(made.figure, mark.tone)
      none.hidden = tasks.length > 0
      wrap.hidden = tasks.length === 0
      keyed(body, tasks, (task) => task.id, createCheckRow, fillCheckRow)
      keyed(
        cards,
        projectsOf(view.store),
        (row) => row.name,
        createCheckCard,
        (one, row) => fillCheckCard(one, row, view),
      )
    },
  }
}

function createCheckCard() {
  const node = el('a', { class: 'ui-card check-card', attrs: { href: '/' } })
  const counts = el('span', { class: 'check-counts' })
  into(counts, countOf('done'), countOf('failed'), countOf())
  into(node, ringOf('checks'), el('span', { class: 'proj-name' }), counts)
  return node
}

const CHECK_NOUNS = ['green', 'red', 'not run here']

function fillCheckCard(node, project, view) {
  const [ring, name, counts] = node.children
  const fold = checksFold(tasksIn(view.store, project.name))
  node.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  textIn(name, project.name)
  ringIn(ring, [fold.pass, fold.fail, fold.unknown])
  const figures = [fold.pass, fold.fail, fold.unknown]
  ;[...counts.children].forEach((one, at) => {
    countIn(one, figures[at] ?? 0, CHECK_NOUNS[at])
  })
}

function createCheckRow() {
  const node = el('tr')
  for (let at = 0; at < 5; at += 1) into(node, el('td'))
  return node
}

function fillCheckRow(node, task) {
  const cells = node.children
  textIn(cells[0], task.project)
  textIn(cells[1], task.name)
  const mark = checkMark(task.checks.state)
  textIn(cells[2], `${mark.glyph} ${mark.word}${task.checks.overridden ? ' · overruled' : ''}`)
  cells[2].setAttribute('aria-label', mark.word)
  textIn(cells[3], task.checks.failed.join(', ') || '—')
  textIn(cells[4], task.checks.missing.join(', ') || '—')
}
