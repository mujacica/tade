// The pieces every screen is made of, each as a **create and a fill**.
//
// That shape is what `keyed` wants: a row already on the page is filled rather
// than rebuilt, so the keyboard keeps its place in a list that is being
// repainted twice a second. It also means a row's structure is written down
// once and its data in one other place, which is the only way four screens
// agree about what a task row looks like.
//
// **Every row is the same three columns** — a glyph, a name, a figure — which
// is `.row`'s `1.5rem 1fr auto` and is why sections line up across the page
// without anybody measuring one against another.
//
// Nothing here decides anything about a task. `state`, `reason`, `wantsYou` and
// every count came off the wire already derived; what is here is the drawing.

import { classOn, el, glyphOf, into, markIn, proseOf, textIn } from './dom.js'
import { ageSaid, money, shortClockOf } from './figures.js'
import {
  checkMark,
  findingMark,
  originSaid,
  queueMark,
  queueSaid,
  reviewMark,
  taskMark,
} from './glyphs.js'
import { safeHref, taskPath } from './routes.js'

/**
 * A section: a heading, a figure, and a body that is never left blank.
 *
 * The heading is the page's one uppercase and carries an `aria-label` in
 * sentence case, so a screen reader reads a heading instead of spelling it. The
 * body is a landmark of its own (`aria-labelledby`), which is what makes the
 * page navigable by region rather than by scrolling.
 */
let seq = 0

export function section(title, opts = {}) {
  seq += 1
  const id = `h${seq}`
  const node = el('section', { class: 'section', attrs: { 'aria-labelledby': id } })
  const head = el('div', { class: 'section-head' })
  const heading = el(opts.top === true ? 'h1' : 'h2', {
    text: title,
    attrs: { id, 'aria-label': sentence(title) },
  })
  const figure = el('span', { class: 'figure' })
  into(head, heading, figure)
  const body = el('div')
  into(node, head, body)
  return { node, body, figure, heading }
}

/** `WANTS YOU` read aloud as "Wants you", not as five letters and three. */
function sentence(title) {
  const words = title.toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/* ── a task, as a row ──────────────────────────────────────────────────────── */

export function createTaskRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(taskMark('queued'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(link, glyph, name, aside, under)
  into(node, link)
  return node
}

/**
 * One task's row.
 *
 * The second line is `deriveState`'s own `reason` clause, **verbatim**: a second
 * wording of why a task is blocked is a second state machine, and the two would
 * disagree on the morning it mattered.
 */
export function fillTaskRow(node, task, view) {
  const [link] = node.children
  const [glyph, name, aside, under] = link.children
  link.setAttribute('href', taskPath(task.id))
  markIn(glyph, taskMark(task.state))
  textIn(name, task.name)
  textIn(under, task.reason)
  const age = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(aside, age === null ? '' : age)
  aside.setAttribute('aria-label', age === null ? 'never moved' : `moved ${age} ago`)
  classOn(link, 'stalled', task.stalled)
}

/* ── a task, as a card: the `WANTS YOU` drawing ────────────────────────────── */

export function createTaskCard() {
  const node = el('a', { class: 'card', attrs: { href: '/' } })
  const top = el('div', { class: 'card-top' })
  const glyph = glyphOf(taskMark('blocked'))
  const who = el('span', { class: 'who' })
  into(top, glyph, who)
  const why = el('p', { class: 'why' })
  const asked = el('p', { class: 'asked' })
  const foot = el('div', { class: 'card-foot' })
  into(node, top, why, asked, foot)
  return node
}

/**
 * One card. Four lines: who, what state and why, what it is waiting on, and
 * the footer of facts.
 *
 * The third line is **the tool's name and never its arguments**. The projection
 * carries only the name for the same reason this does not ask for more: a
 * command's arguments are the one field that reliably holds a path and a
 * credential, and the place to read the whole of one is the window, at the
 * machine, where the person deciding is.
 */
export function fillTaskCard(node, task, view) {
  const [top, why, asked, foot] = node.children
  const [glyph, who] = top.children
  const mark = taskMark(task.state)
  node.setAttribute('href', taskPath(task.id))
  classOn(node, 'wants', task.state === 'blocked')
  classOn(node, 'broke', task.state === 'failed')
  markIn(glyph, mark)
  textIn(who, `${task.project} / ${task.name}`)
  textIn(why, `${mark.word} — ${task.reason}`)
  const approval = task.approval
  textIn(asked, approval === null ? '' : `waiting on ${approval.tool}`)
  factsIn(foot, task, view)
}

/**
 * The footer of a card: age, harness, model, cost.
 *
 * Every one of the four may be missing and none of them is drawn as a nought.
 * `plan` is a harness on a subscription and is not a figure; `—` is nobody
 * wrote it down.
 */
function factsIn(foot, task, view) {
  const age = ageSaid(task.movedAt, view.asOf, view.frozen)
  const paid = money(task.spend, view.may.spend)
  const parts = [
    task.project,
    age === null ? null : age,
    task.harness,
    task.model,
    paid.said === '—' ? `— ${paid.why}` : paid.said,
  ].filter((one) => one !== null && one !== undefined && one !== '')
  keepText(foot, parts)
}

/**
 * A row of short facts, kept as one text node per fact so a change writes one
 * of them rather than rebuilding the row.
 */
function keepText(parent, parts) {
  while (parent.children.length > parts.length) parent.lastElementChild?.remove()
  while (parent.children.length < parts.length) parent.append(el('span'))
  for (let at = 0; at < parts.length; at += 1) textIn(parent.children[at], parts[at])
}

/* ── queued work ───────────────────────────────────────────────────────────── */

export function createQueueRow() {
  const node = el('li')
  const order = el('span', { class: 'order' })
  const glyph = glyphOf(queueMark({ kind: 'ready' }))
  const link = el('a', { class: 'name', attrs: { href: '/' } })
  const aside = el('span', { class: 'aside' })
  const waits = el('span', { class: 'waits' })
  into(node, order, glyph, link, aside, waits)
  return node
}

/**
 * One piece of queued work, and **what it waits on, drawn as an indented list
 * with a connector** rather than as a graph.
 *
 * At 390px a node diagram is unreadable and a list is not — which is also how
 * the window itself draws the queue, and it reads fine. The words are
 * `@tade/core`'s `describeQueueState`, held to it by `test/glyphs.test.ts`.
 */
export function fillQueueRow(node, row, view) {
  const [order, glyph, link, aside, waits] = node.children
  textIn(order, row.order === null || row.order === undefined ? '' : String(row.order))
  markIn(glyph, queueMark(row.state))
  link.setAttribute('href', taskPath(row.task))
  textIn(link, row.task.slice(row.task.indexOf('/') + 1))
  textIn(aside, view.project === null ? row.project : '')
  waitsIn(waits, row)
}

function waitsIn(node, row) {
  const lines = [{ edge: false, said: queueSaid(row.state, shortClockOf) }]
  for (const one of row.waitsOn ?? []) {
    // The state's own sentence already names what this waits on (`after a and
    // b`). A connector line earns its place by carrying **why** — and where
    // nobody wrote one, or this device was not granted it, there is nothing to
    // draw but the same id again.
    if (one.why === null || one.why === undefined) continue
    lines.push({ edge: true, said: `${one.task} — ${one.why.words}` })
  }
  keepLines(node, lines)
}

/**
 * One line per thing this is waiting on, with the connector **apart from the
 * words**.
 *
 * The glyph is decoration at 2.63:1 and the words are the fact: one span each,
 * so the connector can be the faint grey a drawn edge wants to be and the task
 * it points at is still readable. Carrying both in one text node made the
 * whole line the colour of the line art, which is how a dependency list
 * becomes unreadable without anybody choosing that.
 */
function keepLines(parent, lines) {
  while (parent.children.length > lines.length) parent.lastElementChild?.remove()
  while (parent.children.length < lines.length) {
    const line = el('span', { class: 'wait' })
    into(
      line,
      el('span', { class: 'edge', text: '╷ ', attrs: { 'aria-hidden': 'true' } }),
      el('span'),
    )
    parent.append(line)
  }
  for (let at = 0; at < lines.length; at += 1) {
    const [edge, said] = parent.children[at].children
    const line = lines[at]
    edge.hidden = !line.edge
    textIn(said, line.said)
  }
}

/* ── a judge's finding ─────────────────────────────────────────────────────── */

export function createFindingRow() {
  const node = el('li')
  const body = el('div')
  const glyph = glyphOf(findingMark({ verdict: null, accounted: false }))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(body, glyph, name, aside, under)
  into(node, body)
  return node
}

/**
 * One finding: the question's own id, where it points, and whose move it is.
 *
 * **A probability is not a verdict**, so it is drawn beside the question rather
 * than as the answer to it, and the words for where it stands say who is
 * waited on. The question id is `questions.ts`'s own; the file is
 * repository-relative, the way git names it.
 */
export function fillFindingRow(node, finding, view) {
  const [body] = node.children
  const [glyph, name, aside, under] = body.children
  const mark = findingMark(finding)
  markIn(glyph, mark)
  textIn(name, finding.question)
  textIn(aside, finding.probability.toFixed(2))
  aside.setAttribute('aria-label', `probability ${finding.probability.toFixed(2)}`)
  const gone = finding.stillThere ? '' : ' · the line it pointed at has moved'
  const age = ageSaid(finding.at, view.asOf, view.frozen)
  textIn(under, `${mark.word} · ${finding.file}${gone}${age === null ? '' : ` · ${age}`}`)
}

/* ── a note ────────────────────────────────────────────────────────────────── */

export function createNoteRow() {
  const node = el('li')
  const head = el('p', { class: 'aside' })
  into(node, head)
  return node
}

/**
 * One note, **verbatim**.
 *
 * Never lowercased, never reworded, never summarised: a note is the one thing
 * Tade is told rather than derives. A `summary` may be written *beside* one and
 * never made out of its text, so when there is one it goes under the note and
 * is labelled as what it is.
 */
export function fillNoteRow(node, note, view) {
  const [head] = node.children
  const age = ageSaid(note.at, view.asOf, view.frozen)
  textIn(
    head,
    [note.by, note.scope, age === null ? null : age].filter((one) => one !== null).join(' · '),
  )
  // The text itself is written once: a note never changes, so rebuilding it
  // would be churn with nothing to show for it.
  if (node.children.length === 1) {
    into(node, proseOf(note.text), labelled('as a summary', note.summary))
  }
}

function labelled(what, said) {
  if (said === null || said === undefined) return null
  const node = el('div')
  return into(node, el('p', { class: 'aside', text: what }), proseOf(said))
}

/* ── a branch offered for merge ────────────────────────────────────────────── */

export function createReviewRow() {
  const node = el('li')
  const body = el('div')
  const glyph = glyphOf(reviewMark('open'))
  const link = el('a', { class: 'name', attrs: { href: '/' } })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(body, glyph, link, aside, under)
  into(node, body)
  return node
}

/**
 * One review: its state, its branch, how far ahead it is, and its checks.
 *
 * The outbound link is **the only one in the design** and is `https:`-only
 * (`safeHref`): the URL came from the forge, which makes it the one string on
 * this page written by something off this machine. It opens in a new tab with
 * `noopener noreferrer`, so the forge gets no handle on this window and no
 * referrer carrying the away view's address.
 */
export function fillReviewRow(node, task, view) {
  const [body] = node.children
  const [glyph, link, aside, under] = body.children
  const review = task.review
  markIn(glyph, review === null ? reviewMark('') : reviewMark(review.state))
  link.setAttribute('href', taskPath(task.id))
  textIn(link, `${task.project} / ${task.name}`)
  const checks = checkMark(task.checks.state)
  textIn(aside, `${checks.glyph} ${checks.word}`)
  aside.setAttribute('aria-label', `checks ${checks.word}`)
  const ahead = task.ahead === null ? null : `${task.ahead} ahead`
  const parts = [review === null ? 'not offered for merge' : review.state, task.branch, ahead]
  textIn(under, parts.filter((one) => one !== null && one !== '').join(' · '))
  outbound(body, review === null ? null : safeHref(review.url))
  void view
}

/** The forge link, added once and removed when there is nothing safe to link. */
function outbound(body, href) {
  const held = body.querySelector('.out')
  if (href === null) {
    held?.remove()
    return
  }
  if (held !== null && held.getAttribute('href') === href) return
  held?.remove()
  const link = el('a', {
    class: 'out',
    text: 'open on the forge ↗',
    attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
  })
  into(body, link)
}

/* ── a plain figure row, for the tables that are not lists ─────────────────── */

export function dl() {
  return el('dl', { class: 'dl' })
}

/**
 * A list of names and figures, **patched rather than rebuilt**.
 *
 * These hold the branch, the model, the account — the things somebody actually
 * selects and copies — and the page repaints every two seconds. Assigning the
 * whole list again would collapse that selection on every beat, which is a
 * selection nobody can make. So the `dt`/`dd` pairs are reused and only the
 * text that differs is written.
 *
 * A pair whose value is null is left out: `unknown` is said in words by the
 * caller, where it can say *which* unknown it is, not as an empty row.
 */
export function dlIn(node, pairs) {
  const rows = pairs.filter(([, value]) => value !== null && value !== undefined)
  while (node.children.length > rows.length * 2) node.lastElementChild?.remove()
  while (node.children.length < rows.length * 2) into(node, el('dt'), el('dd'))
  for (let at = 0; at < rows.length; at += 1) {
    const [name, value, label] = rows[at]
    textIn(node.children[at * 2], name)
    const said = node.children[at * 2 + 1]
    textIn(said, value)
    if (label !== undefined) said.setAttribute('aria-label', label)
  }
}

/**
 * A line that is there or not, without rebuilding the region around it.
 *
 * `hidden` rather than append-and-remove, so a region that gains a caveat does
 * not move everything under it in and out of the document — and whatever is
 * focused in that region stays focused.
 */
export function sayIn(node, said) {
  textIn(node, said ?? '')
  node.hidden = said === null || said === undefined || said === ''
}

/** Whose a task is, said rather than left as a word nobody defined. */
export function originOf(task) {
  return `asked for by ${originSaid(task.origin)}`
}
