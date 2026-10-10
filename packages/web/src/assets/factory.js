// What has been handed to this machine, as two screens: the inbox and one
// request.
//
// Its own file beside `pages.js` and `screens.js`, for the reason those two are
// apart: this is one subject — work that came from outside — and a reader
// checking what the inbox draws should not have to scroll past the money. The
// runs are `runs.js` and the designer is `designer.js`, for the same reason
// again.
//
// The three rules that break something quietly if they go:
//
// - **`proposed` and `started` are never one word.** One is waiting for a
//   person to say yes and the other is an agent spending money. `glyphs.js`
//   keeps them as far apart in shape and tone as *wants you* and *working*,
//   which is what they are.
// - **An empty list says *which* nothing.** A door that is off, one nobody
//   watches, one that was unreachable at the last look and one that looked and
//   found nothing are four different things to do next, and the row says which
//   out of `because` — Tade's own sentence, never a second wording here.
// - **A stranger's words are drawn under the heading that came with them.**
//   `materialLabel` rides on the row; the page does not choose a word for it,
//   because a drawing that put its own word there would be one edit away from
//   putting none.
//
// Nothing here decides a state, a count or a reason: all of it came off the
// wire already derived.

import { afterAnswer, bodyFor, standingOf, wordsFor } from './acts.js'
import { classOn, el, glyphOf, into, keyed, markIn, proseOf, textIn } from './dom.js'
import { ageSaid, count, untilSaid } from './figures.js'
import { intakeMark, sourceMark } from './glyphs.js'
import { nothingSaid } from './pages.js'
import { pathOf, requestPath, safeHref, taskPath } from './routes.js'
import {
  createLocally,
  createWaitRow,
  dl,
  dlIn,
  fillLocally,
  fillWaitRow,
  rowFor,
  sayIn,
  section,
} from './rows.js'
import { intakeAt, intakeOf, intakeWaiting, mayRead, omitted, sourcesOf } from './store.js'

/* ── what has been handed over ─────────────────────────────────────────────── */

/**
 * The inbox: the doors first, then the requests.
 *
 * **The doors are above the list and not under it**, which is the one layout
 * decision here worth an argument. The commonest reading of this screen is *is
 * anything waiting for me*, and the commonest wrong answer to it is an empty
 * list that means a connector has been failing since Tuesday. Putting the
 * doors where somebody arrives means the empty list is never the first thing
 * read without its reason beside it.
 */
export function inboxScreen() {
  const node = el('div')
  const made = section('HANDED OVER', { top: true })
  const doors = section('THE DOORS')
  const list = el('ul', { class: 'rows' })
  const none = el('p', { class: 'empty' })
  into(made.body, list, none)
  const doorList = el('ul', { class: 'rows' })
  const doorNone = el('p', { class: 'empty', text: 'no source is implemented here' })
  into(doors.body, doorList, doorNone)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left, doors.node)

  return {
    node,
    update(view) {
      const rows = intakeOf(view.store)
      const waiting = intakeWaiting(view.store)
      textIn(made.figure, count(waiting.length))
      made.figure.setAttribute('aria-label', `${waiting.length} waiting on you`)
      keyed(
        list,
        rows,
        (row) => row.item,
        createIntakeRow,
        (one, row) => fillIntakeRow(one, row, view),
      )
      // **Which nothing.** The doors' own sentences, picked the way
      // `nothingHandedSays` picks one — the trouble first, because that is the
      // one somebody can do something about.
      const sources = sourcesOf(view.store)
      none.hidden = rows.length > 0
      textIn(none, rows.length > 0 ? '' : emptySays(sources))
      keyed(
        doorList,
        sources,
        (row) => row.source,
        createSourceRow,
        (one, row) => fillSourceRow(one, row, view),
      )
      doorNone.hidden = sources.length > 0
      const n = omitted(view.store, 'intake')
      sayIn(left, n === 0 ? '' : `${n} more requests are not on this page`)
    },
  }
}

/**
 * What an empty inbox means, out of the doors' own sentences.
 *
 * `nothingHandedSays`' rule, and the same order: a door in trouble first
 * because that is the one a person can act on, then the sentence of whatever
 * is not off, then the first row's. The sentences themselves are the domain's
 * — this picks which one to draw and writes none of its own.
 */
export function emptySays(sources) {
  if (sources.length === 0) return 'no source is implemented here'
  const trouble = sources.find(
    (row) => row.state === 'trouble' || row.state === 'unreachable' || row.state === 'rate-limited',
  )
  if (trouble !== undefined) return trouble.because
  const working = sources.filter((row) => row.state === 'quiet' || row.state === 'found')
  if (working.length > 0) {
    return `${working.length} ${working.length === 1 ? 'source is' : 'sources are'} being looked with and nothing has been handed over`
  }
  return sources.find((row) => row.state !== 'off')?.because ?? sources[0].because
}

function createIntakeRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/inbox' } })
  const glyph = glyphOf(intakeMark({ state: 'noticed', work: [] }))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(link, glyph, name, aside, under)
  return into(node, link)
}

function fillIntakeRow(node, row, view) {
  const [link] = node.children
  const [glyph, name, aside, under] = link.children
  link.setAttribute('href', requestPath(row.item))
  markIn(glyph, intakeMark(row))
  // The source's own title where this device was granted it, and the source's
  // own id where it was not — never the id dressed up as a title.
  textIn(name, row.title === null ? `${row.source} ${row.externalId}` : row.title.words)
  textIn(under, row.because)
  const age = ageSaid(row.at, view.asOf, view.frozen)
  textIn(aside, age === null ? '' : age)
  aside.setAttribute('aria-label', age === null ? 'no moment recorded' : `arrived ${age} ago`)
  classOn(link, 'stalled', row.moved)
}

function createSourceRow() {
  const node = el('li')
  const body = el('div', { class: 'row-static' })
  const glyph = glyphOf(sourceMark('off'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(body, glyph, name, aside, under)
  return into(node, body)
}

function fillSourceRow(node, row, view) {
  const [body] = node.children
  const [glyph, name, aside, under] = body.children
  markIn(glyph, sourceMark(row.state))
  textIn(name, row.source)
  textIn(under, row.because)
  // A rate limit clears on its own, and when is the only figure on this row a
  // person acts on. Everything else says how long ago the last look was.
  const when =
    row.state === 'rate-limited' && row.until !== null
      ? untilSaid(row.until, view.now)
      : ageSaid(row.lookedAt, view.asOf, view.frozen)
  textIn(aside, when === null ? '' : when)
  aside.setAttribute('aria-label', when === null ? 'never looked with' : `last look ${when}`)
}

/* ── one request ───────────────────────────────────────────────────────────── */

/**
 * One request: where it came from, what it made, and then its own words.
 *
 * **Provenance and material are two regions and never one**, which is
 * `openIntakeRow`'s own rule carried onto a phone: the first is this machine's
 * record of what arrived and what allowed it, and the second is somebody
 * else's sentences. A layout that merged them would be one change away from
 * drawing a stranger's words as Tade's.
 */
export function requestScreen(where, ctx) {
  const item = `${where.source}:${where.id}`
  const node = el('div')
  const back = el('a', { class: 'back', text: '‹ Handed over', attrs: { href: '/inbox' } })
  const head = el('div', { class: 'page-head' })
  const glyph = glyphOf(intakeMark({ state: 'noticed', work: [] }))
  const title = el('h1', { text: where.id })
  into(head, glyph, title)
  const gone = el('p', { class: 'empty' })

  const stands = section('WHERE IT STANDS')
  const standing = el('p', { class: 'why' })
  const moved = el('p', { class: 'unknown' })
  into(stands.body, standing, moved)

  const from = section('WHERE IT CAME FROM')
  const facts = dl()
  const link = el('a', { class: 'press ghost', text: 'Open it at its source' })
  into(from.body, facts, link)

  const work = section('WHAT IT MADE')
  const workList = el('ul', { class: 'rows' })
  const workNone = el('p', { class: 'empty' })
  const runLink = el('a', { class: 'press ghost', text: 'The whole run' })
  into(work.body, workList, workNone, runLink)

  const replies = section('WHAT WENT BACK')
  const said = el('p', { class: 'said' })
  const unsent = el('ul', { class: 'rows' })
  into(replies.body, said, unsent)

  // The request itself, last, under the heading that travels with it.
  const words = section('THE REQUEST ITSELF')
  const label = el('p', { class: 'material-label' })
  const body = el('div', { class: 'material' })
  const noBody = el('p', { class: 'unknown' })
  into(words.body, label, body, noBody)

  const approve = section('APPROVING IT')
  const locally = el('ul', { class: 'locally' })
  const control = approveIn(approve.body, ctx)
  into(approve.body, locally)

  const parts = [stands, from, work, replies, words, approve]
  into(node, back, head, gone, ...parts.map((one) => one.node))

  return {
    node,
    update(view) {
      const row = intakeAt(view.store, item)
      gone.hidden = row !== null
      textIn(
        gone,
        row === null
          ? 'This request is not on this device, or nothing by that name has arrived.'
          : '',
      )
      for (const one of parts) one.node.hidden = row === null
      if (row === null) return
      markIn(glyph, intakeMark(row))
      textIn(title, row.title === null ? row.externalId : row.title.words)
      textIn(standing, row.because)
      sayIn(
        moved,
        row.moved
          ? `it has been edited since the work was made: the work is for ${row.taken} and it is at ${row.revision} now`
          : '',
      )
      dlIn(facts, factsOf(row, view))
      const href = safeHref(row.url)
      link.hidden = href === null
      if (href !== null) {
        link.setAttribute('href', href)
        link.setAttribute('rel', 'noreferrer noopener')
        link.setAttribute('target', '_blank')
      }
      keyed(workList, row.work, (one) => one.task, createWorkRow, fillWorkRow)
      workNone.hidden = row.work.length > 0
      textIn(workNone, row.work.length > 0 ? '' : 'nothing has been made for it')
      runLink.hidden = row.run === null
      if (row.run !== null) runLink.setAttribute('href', pathOf({ view: 'run', run: row.run }))
      textIn(
        said,
        row.said.length === 0 ? 'nothing has gone back to the source' : row.said.join(', '),
      )
      keyed(unsent, row.unsent, (one) => one.saying, createUnsentRow, fillUnsentRow)
      materialIn({ label, body, noBody }, row, view)
      control.update(row, view)
      keyed(locally, row.locally, (one) => one.act, createLocally, fillLocally)
    },
  }
}

/**
 * Where it came from, as labelled facts — and **nothing a stranger wrote**
 * except the handle and the source's own ids, which are what *who asked* means.
 *
 * `inboxProvenance`'s own list, with the two revisions collapsed the way it
 * collapses them and `—` wherever the answer is that nobody said: a row drawn
 * with an empty grant reads as a request nothing authorised, and one nothing
 * authorised was refused and never got a row.
 */
export function factsOf(row, view) {
  const dash = (value) => (value === null || value === '' ? '—' : value)
  return [
    ['source', row.source],
    ['their id', row.externalId],
    [
      'revision',
      row.taken === row.revision ? row.revision : `${row.revision} now, work made for ${row.taken}`,
    ],
    [
      'asked by',
      row.who === null
        ? mayRead(view.store, 'requests')
          ? '—'
          : 'not granted'
        : `@${row.who.words}`,
    ],
    ['project', dash(row.project)],
    ['allowed by', dash(row.grant)],
    ['mode', dash(row.mode)],
    ['workflow', row.stamp === null ? 'none: one task' : `${row.stamp.name}@${row.stamp.version}`],
    ['found by', dash(row.watch)],
    ['raw material', dash(row.ref)],
    ['its hash', dash(row.hash)],
    ['tried', `${row.attempts} of ${row.tries}`],
  ]
}

function createWorkRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(link, name, aside)
  return into(node, link)
}

function fillWorkRow(node, one) {
  const [link] = node.children
  const [name, aside] = link.children
  link.setAttribute('href', taskPath(one.task))
  textIn(name, one.task)
  // Four facts and the order is the order they matter in: held beats finished,
  // which beats started, which beats parked. `state` is null where nothing
  // could ask for one, and that is said rather than drawn as a blank.
  const says = one.held
    ? `held: ${one.held}`
    : one.finished
      ? 'finished'
      : one.started
        ? 'an agent has been on it'
        : one.parked
          ? 'parked, waiting to be approved'
          : (one.state ?? 'nothing here knows its state')
  textIn(aside, says)
}

function createUnsentRow() {
  const node = el('li')
  const body = el('div', { class: 'row-static' })
  const name = el('span', { class: 'name' })
  const under = el('span', { class: 'under' })
  into(body, name, under)
  return into(node, body)
}

function fillUnsentRow(node, one) {
  const [body] = node.children
  const [name, under] = body.children
  textIn(
    name,
    `could not say “${one.saying}”, ${one.attempts} ${one.attempts === 1 ? 'time' : 'times'}`,
  )
  textIn(under, one.problem ?? 'nothing said why')
}

/**
 * The request's own words, or **which** nothing there is instead.
 *
 * Three nothings and the page says which: this device was not granted them,
 * Tade never wrote one down, or the words are not on this frame because the
 * snapshot carries the ones waiting on somebody first. A single "nothing to
 * read" over all three tells somebody a request is empty.
 */
export function materialIn(nodes, row, view) {
  const has = row.material !== null
  nodes.label.hidden = !has
  textIn(nodes.label, row.materialLabel ?? '')
  nodes.body.replaceChildren()
  if (has) into(nodes.body, proseOf(row.material))
  nodes.noBody.hidden = has
  textIn(
    nodes.noBody,
    has
      ? ''
      : (row.materialSays ??
          nothingSaid(mayRead(view.store, 'material'), 1, 'nothing was written down')),
  )
}

/**
 * The one control on this screen, and it is an **existing verb on an existing
 * target**.
 *
 * Approving a request from away is `intake` on the parked task the request
 * made — the verb that already re-asks the local grant and the source at the
 * moment of the act (`intakeStands`). So this looks that task up in what the
 * page already holds and draws the control the task screen draws, through the
 * same `controlsFor`/`bodyFor`: there is no second body, no second scope and
 * no second idea of what approving means.
 *
 * Two presses, because the schema's `confirm` literal is the other half and
 * neither stands in for the other: this stops a mis-tap, and the literal means
 * there is no shape of the body that says *do not*.
 */
function approveIn(parent, ctx) {
  const why = el('p', { class: 'empty' })
  const press = el('button', { class: 'press', attrs: { type: 'button' } })
  const said = el('p', { class: 'said' })
  into(parent, why, press, said)
  let asked = false
  let held = null
  let key = null
  const keyOf = () => {
    key ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return key
  }
  press.addEventListener('click', () => {
    if (held === null || ctx === undefined || ctx === null) return
    if (!asked) {
      asked = true
      textIn(press, 'Yes — approve it')
      textIn(said, 'Approving starts the work this machine already allowed. Press again.')
      return
    }
    asked = false
    press.disabled = true
    const body = bodyFor('intake', held, keyOf(), ctx.revOf(), {})
    void ctx.ask('POST', '/api/act/intake', body).then((answer) => {
      press.disabled = false
      const came = afterAnswer(answer, ctx.sentence(answer))
      textIn(said, came.said)
      textIn(press, wordsFor('intake', held ?? {}))
      // **The key is kept across a retry and minted again only once it
      // happened**: a press whose answer never arrived is a press whose repeat
      // must not be a second approval, and the key is what lets the machine
      // tell the two apart.
      if (came.ok) key = null
    })
  })
  return {
    update(row, view) {
      const task = row.approve === null ? null : rowFor(view.store, row.approve)
      held = task
      const acts = view.may.acts ?? { answer: false, steer: false }
      const standing = task === null ? { kind: 'no', why: '' } : standingOf('intake', task, acts)
      press.hidden = standing.kind !== 'yes'
      textIn(press, wordsFor('intake', task ?? {}))
      press.disabled = false
      const reason =
        task === null
          ? row.state === 'proposed'
            ? 'the parked task this would approve is not on this device'
            : `there is nothing to approve: ${row.because}`
          : standing.kind === 'no'
            ? standing.why
            : ''
      sayIn(why, standing.kind === 'off' ? '' : reason)
      if (standing.kind !== 'yes') {
        asked = false
        textIn(said, '')
      }
    },
  }
}
