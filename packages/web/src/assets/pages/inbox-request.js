// One request handed to this machine, as its own screen (`/i/:source/:id`):
// the inbox page's second view, in its own file because it is a different
// reading from the list and the two together were a conversation.
//
// **It leads with where the request stands and the one thing to do about it**
// — approving, with what approving would start beside the press — then the
// request's own words, what it would start and what it made; where it came
// from and what went back are the side's at a desk and come last on a phone.
//
// Nothing here decides a state, a count or a reason (`inbox-shape.js`).

import { mayFor } from '../access.js'
import { afterAnswer, bodyFor, standingOf, wordsFor } from '../acts.js'
import {
  classOn,
  el,
  glyphOf,
  into,
  keyed,
  markIn,
  proseOf,
  skeleton,
  textIn,
  toneOn,
} from '../dom.js'
import { count } from '../figures.js'
import { intakeMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { safeHref, taskPath } from '../routes.js'
import {
  createLocally,
  dl,
  dlIn,
  fillLocally,
  nothingSaid,
  pageBar,
  rowFor,
  sayIn,
  section,
} from '../rows.js'
import { intakeAt } from '../store.js'
import { TROUBLES } from '../trouble.js'
import { answerIn, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  factsSplit,
  knownIn,
  provenanceOf,
  runHref,
  standingOfRequest,
  startsSaid,
  stateOf,
  taskName,
  unsentSaid,
  workOf,
} from './inbox-shape.js'

/** A section's own count, said to a screen reader only while it is drawn — a label on an empty figure is one axe refuses. */
export function sectionCount(figure, n, noun) {
  textIn(figure, n === 0 ? '' : count(n))
  if (n === 0) figure.removeAttribute('aria-label')
  else figure.setAttribute('aria-label', `${n} ${noun}`)
}

/**
 * One request: where it stands and the one thing to do about it, then its own
 * words, what approving would start and what it made; where it came from and
 * what went back beside them at a desk.
 *
 * **Provenance and material are two regions and never one**, which is
 * `openIntakeRow`'s own rule carried onto a phone: the first is this machine's
 * record of what arrived and what allowed it, and the second is somebody
 * else's sentences. A layout that merged them would be one change away from
 * drawing a stranger's words as Tade's.
 */
export function requestScreen(where, ctx) {
  const item = `${where.source}:${where.id}`
  const node = el('div', { class: 'rq' })
  const glyph = glyphOf(intakeMark({ state: 'noticed', work: [] }))
  const bar = pageBar(where.id, { name: true, glyph, back: { text: 'Inbox', href: '/inbox' } })
  const link = el('a', { class: 'press quietly small rq-source' })
  into(link, el('span', { text: 'Open at its source' }), icon('arrow'))
  into(bar.tools, link)
  const coming = skeleton(4)
  const gone = stateBox()
  gone.classList.add('rq-gone')

  const lead = requestLeadOf(ctx)
  const words = wordsOf()
  const would = startsOf()
  const work = madeOf()
  const from = fromOf()
  const replies = repliesOf()
  const main = el('div', { class: 'rq-main' })
  into(main, words.made.node, would.made.node, work.made.node)
  const side = el('div', { class: 'rq-side' })
  into(side, from.made.node, replies.made.node)
  const grid = el('div', { class: 'rq-grid' })
  into(grid, main, side)
  const body = el('div', { class: 'rq-body' })
  into(body, coming, gone, lead.node, grid)
  into(node, bar.node, body)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      const shut = view.standing === 'unreachable' || view.standing === 'closed'
      const row = had ? intakeAt(store, item) : null
      coming.hidden = had || shut
      stateBoxIn(
        gone,
        row !== null
          ? null
          : !had
            ? shut
              ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert')
              : null
            : stateOf(
                'empty',
                'This request isn’t on this device',
                'Nothing by that name has arrived, or it is not among the requests this device was sent.',
              ),
      )
      lead.node.hidden = row === null
      grid.hidden = row === null
      link.hidden = true
      if (row === null) return
      markIn(glyph, intakeMark(row))
      textIn(bar.heading, row.title === null ? row.externalId : row.title.words)
      // `https` and nothing else, asked here as well as at the projection: a
      // row's safety never rests on one function on the other side of a wire.
      const href = safeHref(row.url)
      link.hidden = href === null
      if (href !== null) {
        link.setAttribute('href', href)
        link.setAttribute('rel', 'noreferrer noopener')
        link.setAttribute('target', '_blank')
      }
      const known = knownIn(store)
      lead.fill(row, view, known)
      words.fill(row, view)
      would.fill(row, view)
      work.fill(row, known)
      from.fill(row, view)
      replies.fill(row)
    },
  }
}

/**
 * The head of a request: its mark large in a square of its tone, the glyph's
 * word for where it stands and when it arrived, Tade's sentence, the edit made
 * since the work, where it came from — and the one thing to do about it.
 */
function requestLeadOf(ctx) {
  const node = el('div', { class: 'ui-card rq-lead' })
  const now = el('div', { class: 'rq-now' })
  const square = el('span', { class: 'rq-now-mark', attrs: { 'aria-hidden': 'true' } })
  const words = el('div', { class: 'rq-now-words' })
  const state = el('p', { class: 'rq-now-state' })
  into(state, el('strong'), el('span', { class: 'rq-now-age' }))
  const because = el('p', { class: 'rq-now-said' })
  const moved = el('p', { class: 'rq-moved' })
  into(moved, glyphOf({ glyph: '⚠', word: 'edited', tone: 't-working' }), el('span'))
  into(words, state, because, moved)
  into(now, square, words)
  const chips = el('ul', {
    class: 'rq-chips',
    attrs: { 'aria-label': 'Its source, who asked, its project' },
  })
  const act = el('div', { class: 'rq-act' })
  const control = approveIn(act, ctx)
  const open = el('a', { class: 'press rq-open' })
  into(open, el('span'), icon('chevron'))
  const locally = el('ul', { class: 'rq-locally' })
  into(act, open, locally)
  into(node, now, chips, act)
  return {
    node,
    fill(row, view, known) {
      const standing = standingOfRequest(row, view.asOf)
      textIn(square, standing.mark.glyph)
      toneOn(square, standing.mark.tone)
      now.classList.toggle('is-wants', standing.wash === 'wants')
      now.classList.toggle('is-failed', standing.wash === 'failed')
      const [word, age] = state.children
      textIn(word, standing.word)
      textIn(age, standing.arrived)
      textIn(because, row.because)
      moved.hidden = standing.moved === null
      textIn(moved.lastChild, standing.moved ?? '')
      chipsIn(chips, row, view)
      control.update(row, view)
      // A held request's work is a task with its own controls: one press to it.
      const held = row.state === 'held' ? row.work.find((one) => one.held !== null) : undefined
      const to = held !== undefined && known(held.task) ? held.task : null
      open.hidden = to === null
      if (to !== null) {
        open.setAttribute('href', taskPath(to))
        textIn(open.firstChild, `Open ${taskName(to)}`)
      }
      keyed(locally, row.locally, (one) => one.act, createLocally, fillLocally)
      locally.hidden = row.locally.length === 0
    },
  }
}

/** Where it came from, as a line of chips: the source and its id, who asked, the project, the workflow. */
function chipsIn(list, row, view) {
  const who =
    row.who === null
      ? mayFor(view.store, 'intake.who')
        ? null
        : 'asked by: not granted'
      : `@${row.who.words}`
  const cells = [
    { key: 'source', said: `${row.source} ${row.externalId}`, mono: true },
    { key: 'who', said: who },
    { key: 'project', said: row.project },
    {
      key: 'workflow',
      said: row.stamp === null ? 'one task' : `${row.stamp.name}@${row.stamp.version}`,
      mono: row.stamp !== null,
    },
  ].filter((one) => one.said !== null && one.said !== '')
  keyed(
    list,
    cells,
    (one) => one.key,
    () => el('li', { class: 'ui-pill' }),
    (chip, one) => {
      textIn(chip, one.said)
      classOn(chip, 'is-mono', one.mono === true)
    },
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
  const why = el('p', { class: 'rq-act-why' })
  const line = el('div', { class: 'rq-act-line' })
  const press = el('button', { class: 'press rq-approve', attrs: { type: 'button' } })
  const starts = el('span', { class: 'rq-act-starts' })
  into(line, press, starts)
  const said = el('p', { class: 'said rq-act-said' })
  into(parent, why, line, said)
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
      press.classList.add('asked')
      textIn(press, 'Yes — approve it')
      textIn(said, 'Approving starts the work this machine already allowed. Press again.')
      return
    }
    asked = false
    press.classList.remove('asked')
    press.disabled = true
    const body = bodyFor('intake', held, keyOf(), ctx.revOf(), {})
    void ctx.ask('POST', '/api/act/intake', body).then((answer) => {
      press.disabled = false
      const came = afterAnswer(answer, ctx.sentence(answer))
      answerIn(said, came.said, came.trouble)
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
      line.hidden = standing.kind !== 'yes'
      if (!asked) textIn(press, wordsFor('intake', task ?? {}))
      press.disabled = false
      sayIn(starts, startsSaid(row.would))
      // Only a request that waits on a yes says why it cannot be given one
      // here; the rest say where they stand in the line above, and a second
      // sentence under it would be the same fact twice.
      const reason =
        row.state !== 'proposed'
          ? ''
          : task === null
            ? 'the parked task this would approve is not on this device'
            : standing.kind === 'no'
              ? standing.why
              : ''
      sayIn(why, standing.kind === 'off' ? '' : reason)
      if (standing.kind !== 'yes') {
        asked = false
        press.classList.remove('asked')
        textIn(said, '')
      }
    },
  }
}

/* ── the request's own words ──────────────────────────────────────────────── */

function wordsOf() {
  const made = section('WHAT THEY ASKED')
  const label = el('p', { class: 'ui-callout material-label' })
  const body = el('div', { class: 'material' })
  const noBody = el('p', { class: 'unknown' })
  const box = el('div', { class: 'ui-card rq-words' })
  into(box, label, body, noBody)
  into(made.body, box)
  return {
    made,
    fill(row, view) {
      materialIn({ label, body, noBody }, row, view)
    },
  }
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
  const key = has ? `${row.material.more ? '+' : ''}${row.material.words}` : ''
  if (nodes.body.dataset.said !== key) {
    nodes.body.dataset.said = key
    nodes.body.replaceChildren()
    if (has) into(nodes.body, proseOf(row.material))
  }
  nodes.noBody.hidden = has
  textIn(
    nodes.noBody,
    has
      ? ''
      : (row.materialSays ??
          nothingSaid(mayFor(view.store, 'intake.material'), 1, 'nothing was written down')),
  )
}

/* ── what approving would start ───────────────────────────────────────────── */

/**
 * What approving would start, as the work that exists: each parked task a
 * step down a rail — its name, where it would work, its done rule, what it
 * touches and what it waits on — then what allows it, what bounds it, and
 * what is wrong with it.
 */
function startsOf() {
  const made = section('WHAT APPROVING STARTS')
  const steps = el('ol', { class: 'rq-starts', attrs: { 'aria-label': 'Tasks it starts' } })
  const notes = el('ul', {
    class: 'rq-notes',
    attrs: { 'aria-label': 'What allows and bounds it' },
  })
  const card = el('div', { class: 'ui-card rq-would' })
  into(card, steps, notes)
  into(made.body, card)
  return {
    made,
    fill(row, view) {
      const would = row.would
      made.node.hidden = would === null || row.state !== 'proposed'
      if (made.node.hidden) return
      sectionCount(made.figure, would.starts.length, would.starts.length === 1 ? 'task' : 'tasks')
      keyed(steps, would.starts, (one) => one.task, createStart, fillStart)
      steps.hidden = would.starts.length === 0
      const money = mayFor(view.store, 'intake.would.limits')
      const lines = [
        ...would.problems.map((said) => ({ key: `p${said}`, said, mark: PROBLEM })),
        ...would.warnings.map((said) => ({ key: `w${said}`, said, mark: WARNING })),
        ...would.grant.map((said) => ({ key: `g${said}`, said, mark: ALLOWS })),
        ...(money
          ? would.limits.map((said) => ({ key: `l${said}`, said, mark: BOUNDS }))
          : [{ key: 'l-', said: 'what it may spend is not granted to this device', mark: BOUNDS }]),
      ]
      keyed(notes, lines, (one) => one.key, createNote, fillNote)
    },
  }
}

const PROBLEM = { glyph: '▲', word: 'problem', tone: 't-failed' }
const WARNING = { glyph: '⚠', word: 'warning', tone: 't-working' }
const ALLOWS = { glyph: '✓', word: 'allowed', tone: 't-done' }
const BOUNDS = { glyph: '$', word: 'bounded', tone: 't-quiet' }

function createStart() {
  const item = el('li', { class: 'rq-start' })
  const head = el('div', { class: 'rq-start-head' })
  into(
    head,
    el('strong', { class: 'rq-start-name' }),
    el('span', { class: 'ui-pill rq-start-where' }),
    el('span', { class: 'ui-pill is-mono rq-start-done' }),
  )
  into(
    item,
    head,
    el('p', { class: 'rq-start-touches' }),
    el('p', { class: 'rq-start-makes' }),
    el('ul', { class: 'rq-start-after' }),
  )
  return item
}

function fillStart(item, start) {
  const [head, touches, makes, after] = item.children
  const [name, where, done] = head.children
  textIn(name, taskName(start.task))
  textIn(where, start.workspace === 'worktree' ? 'its own worktree' : 'the shared checkout')
  textIn(done, `done: ${start.done}`)
  sayIn(touches, start.touches.length === 0 ? '' : `touches ${start.touches.join(', ')}`)
  sayIn(makes, start.produces === null ? '' : `produces ${start.produces}`)
  keyed(
    after,
    start.after,
    (one) => one.task,
    () => el('li'),
    (line, one) => {
      const name = taskName(one.task)
      textIn(line, one.why === null ? `after ${name}` : `after ${name} — ${one.why.words}`)
    },
  )
  after.hidden = start.after.length === 0
}

function createNote() {
  const item = el('li')
  into(item, glyphOf(ALLOWS), el('span'))
  return item
}

function fillNote(item, one) {
  const [mark, said] = item.children
  markIn(mark, one.mark)
  textIn(said, one.said)
}

/* ── what it made ─────────────────────────────────────────────────────────── */

function madeOf() {
  const made = section('WHAT IT MADE')
  const list = panel('ul', 'ib-rows rq-work')
  list.setAttribute('aria-label', 'What it made')
  const none = el('p', { class: 'rq-none' })
  const run = el('a', { class: 'press quietly small rq-run' })
  into(run, el('span', { text: 'The whole plan' }), icon('chevron'))
  into(made.body, list, none, run)
  return {
    made,
    fill(row, known) {
      const rows = row.work.map((one) => workOf(one, known))
      sectionCount(made.figure, rows.length, rows.length === 1 ? 'task' : 'tasks')
      keyed(list, rows, (one) => one.key, createWork, fillWork)
      list.hidden = rows.length === 0
      sayIn(none, rows.length > 0 ? '' : 'Nothing has been made for it.')
      const href = runHref(row)
      run.hidden = href === null
      if (href !== null) run.setAttribute('href', href)
    },
  }
}

function createWork() {
  const item = el('li')
  const link = el('a', { class: 'ib-row' })
  into(
    link,
    glyphOf(intakeMark({ state: 'noticed', work: [] }), 'ib-row-mark'),
    el('span', { class: 'ib-row-name is-mono' }),
    el('span', { class: 'ib-row-line' }),
  )
  into(item, link)
  return item
}

function fillWork(item, one) {
  const [link] = item.children
  const [mark, name, line] = link.children
  markIn(mark, one.mark)
  textIn(name, one.name)
  textIn(line, one.says)
  if (one.href === null) link.removeAttribute('href')
  else link.setAttribute('href', one.href)
}

/* ── where it came from ───────────────────────────────────────────────────── */

/** Whether the record under the facts is unfolded, for as long as the page is open. */
let recordOpen = false

function fromOf() {
  const made = section('WHERE IT CAME FROM')
  const first = dl()
  first.classList.add('rq-facts')
  const more = dl()
  more.classList.add('rq-facts', 'rq-record')
  more.id = 'rq-record'
  const press = el('button', {
    class: 'press quietly small rq-fold',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': more.id },
  })
  const foldIn = () => {
    more.hidden = !recordOpen
    press.setAttribute('aria-expanded', recordOpen ? 'true' : 'false')
    textIn(press, recordOpen ? 'Hide its record' : 'Show its record')
  }
  press.addEventListener('click', () => {
    recordOpen = !recordOpen
    foldIn()
  })
  into(made.body, first, press, more)
  return {
    made,
    fill(row, view) {
      const split = factsSplit(factsOf(row, view), row)
      dlIn(first, split.first)
      dlIn(more, split.more)
      foldIn()
    },
  }
}

/**
 * Where it came from, as labelled facts, with this device's grant read off the
 * view: `—` where nobody said who asked, *not granted* where this device may
 * not read the handle (`provenanceOf`).
 */
export function factsOf(row, view) {
  return provenanceOf(row, mayFor(view.store, 'intake.title'))
}

/* ── what went back ───────────────────────────────────────────────────────── */

function repliesOf() {
  const made = section('WHAT WENT BACK')
  const said = el('ul', { class: 'rq-said', attrs: { 'aria-label': 'Said to the source' } })
  const none = el('p', { class: 'rq-none' })
  const unsent = panel('ul', 'rq-unsent')
  unsent.setAttribute('aria-label', 'Could not be said')
  into(made.body, said, none, unsent)
  return {
    made,
    fill(row) {
      keyed(
        said,
        row.said,
        (one) => one,
        () => {
          const chip = el('li', { class: 'ui-pill rq-said-one' })
          into(chip, glyphOf(ALLOWS), el('span'))
          return chip
        },
        (chip, one) => textIn(chip.lastChild, one),
      )
      said.hidden = row.said.length === 0
      sayIn(none, row.said.length === 0 ? 'Nothing has gone back to the source.' : '')
      keyed(unsent, row.unsent, (one) => one.saying, createUnsent, fillUnsent)
      unsent.hidden = row.unsent.length === 0
    },
  }
}

function createUnsent() {
  const item = el('li', { class: 'rq-unsent-one' })
  into(item, glyphOf(PROBLEM, 'rq-unsent-mark'), el('strong'), el('span'))
  return item
}

function fillUnsent(item, one) {
  const [, said, why] = item.children
  const line = unsentSaid(one)
  textIn(said, line.said)
  textIn(why, line.why)
}
