// The screens that are a list or a table: the queue, the checks, the reviews,
// the findings, the notes and this device. Pairing one is `pair.js`. The money is
// `spend.js`.
//
// **The checks.** A rollup is what a run *here* adds up to, so `unknown` is
// first-class and is never folded into a pass. A check that cannot run here
// keeps its row.
//
// The tables are the only things in the design allowed to be wider than the
// viewport, each in its own `overflow-x` container, and each is a real `<table>`
// with a `<caption>` and `<th scope>`.

import { ringIn, ringOf } from './charts.js'
import { classOn, el, empty, into, keyed, textIn, toneOn } from './dom.js'
import {
  ageSaid,
  count,
  money,
  onPlan,
  planBar,
  sinceSaid,
  tokensSaid,
  untilSaid,
} from './figures.js'
import { checkMark } from './glyphs.js'
import { icon } from './icons.js'
import { NOT_OFFERED, OFF, ON, PUSH_SAID, pushState, subscribe, unsubscribe } from './push.js'
import { GROUPS, MORE, pathOf, placeOf } from './routes.js'
import {
  createFindingRow,
  createNoteRow,
  createQueueRow,
  createReviewRow,
  dl,
  dlIn,
  fillFindingRow,
  fillNoteRow,
  fillQueueRow,
  fillReviewRow,
  sayIn,
  section,
} from './rows.js'
import {
  checksFold,
  checksWord,
  findingsOf,
  notesOf,
  omitted,
  plansOf,
  projectsOf,
  queueIn,
  reviewsOf,
  rowsOf,
  spendFold,
  spendSince,
  tasksIn,
} from './store.js'
import { callout, countIn, count as countOf, panel } from './ui.js'

/**
 * What an empty list says, which is **two different nothings**.
 *
 * A collection with no rows because there are none, and one with no rows
 * because this device was not granted them, are different facts — and the
 * second carries its count, because *there are forty-one notes and you may not
 * read them from here* is the honest shape of a read scope. A nought in its
 * place reads as "you have none", which is a page answering a question nobody
 * asked it.
 */
export function nothingSaid(may, total, nothing) {
  if (may) return nothing
  return total === 0
    ? 'not granted to this device'
    : `${total} here, and this device was not granted them`
}

/* ── the queue ─────────────────────────────────────────────────────────────── */

/**
 * Everything waiting, grouped by project, with **what each piece waits on drawn
 * as an indent and a connector**.
 *
 * Parked work stays in the list. A task with a `start` is queued work, and
 * hiding one because somebody parked it would leave them with nothing to pick
 * back up.
 */
export function queueScreen() {
  const node = el('div')
  const made = section('QUEUE', { top: true })
  // **A filter by standing**, a chip each with its count: what can start next
  // is one tap from the whole queue, and a chip at nought is not offered.
  // The standing is `queueStateOf`'s, off the wire — this only counts it.
  const chips = el('div', { class: 'filter', attrs: { role: 'group', 'aria-label': 'Show' } })
  let only = null
  const chipsBy = new Map()
  for (const kind of [null, ...QUEUE_KINDS]) {
    const chip = el('button', {
      class: 'ui-chip filter-chip',
      attrs: { type: 'button', 'aria-pressed': kind === null ? 'true' : 'false' },
    })
    into(
      chip,
      el('span', { text: kind === null ? 'All' : QUEUE_WORDS[kind] }),
      el('span', { class: 'num' }),
    )
    chip.addEventListener('click', () => {
      only = kind
      for (const [one, node] of chipsBy)
        node.setAttribute('aria-pressed', one === only ? 'true' : 'false')
      if (last !== null) draw(last)
    })
    chipsBy.set(kind, chip)
    into(chips, chip)
  }
  let last = null
  const groups = el('div')
  const none = empty('nothing queued')
  into(made.body, chips, groups, none)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left)

  const draw = (view) => {
    last = view
    const every = queueIn(view.store, null)
    for (const [kind, chip] of chipsBy) {
      const n = kind === null ? every.length : every.filter((row) => row.state.kind === kind).length
      textIn(chip.lastChild, String(n))
      chip.hidden = kind !== null && n === 0 && only !== kind
    }
    const rows = only === null ? every : every.filter((row) => row.state.kind === only)
    textIn(made.figure, count(every.length))
    made.figure.setAttribute('aria-label', `${rows.length} queued`)
    none.hidden = rows.length > 0
    const projects = [...new Set(rows.map((row) => row.project))].sort()
    keyed(
      groups,
      projects,
      (name) => name,
      createQueueGroup,
      (one, name) => fillQueueGroup(one, name, rows, view),
    )
    const n = omitted(view.store, 'queue')
    textIn(left, n === 0 ? '' : `${n} more pieces of queued work are not on this page`)
    left.hidden = n === 0
    chips.hidden = every.length === 0
  }

  return { node, update: draw }
}

/** The standings a filter chip is offered for, in the order they are drawn. */
const QUEUE_KINDS = ['ready', 'waiting', 'scheduled', 'held', 'paused']

/** Each standing's word on its chip: `queueMark`'s own, made a heading. */
const QUEUE_WORDS = {
  ready: 'Next',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  held: 'Held',
  paused: 'Paused',
}

function createQueueGroup() {
  const node = el('div', { class: 'section' })
  const head = el('h3', { class: 'aside' })
  const list = panel('ul', 'queue')
  const said = el('p', { class: 'unknown' })
  return into(node, head, list, said)
}

function fillQueueGroup(node, name, rows, view) {
  const [head, list, said] = node.children
  textIn(head, name)
  const mine = rows.filter((row) => row.project === name)
  keyed(
    list,
    mine,
    (row) => row.task,
    createQueueRow,
    (one, row) => fillQueueRow(one, row, { ...view, project: name }),
  )
  // A whole project held at once is a different fact from four rows that each
  // happen to be paused, and it is the one a person can undo in one act.
  const all = mine.every((row) => row.state.kind === 'paused' && row.state.all)
  textIn(said, all && mine.length > 0 ? 'this project’s queue is paused' : '')
  said.hidden = !(all && mine.length > 0)
}

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
  // Without the grant the link to each review is withheld, so **every** task
  // reads as unoffered. Said before the lists rather than left to look like a
  // repository where nobody reviews anything.
  const scope = el('p', { class: 'ui-callout' })
  into(node, scope, open.node, quiet.node)

  return {
    node,
    update(view) {
      scope.hidden = view.may.reviews
      textIn(
        scope,
        view.may.reviews
          ? ''
          : 'This device was not granted the reviews, so nothing here can say whether a branch was offered for merge.',
      )
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
  const made = section('FINDINGS', { top: true })
  const list = panel('ul', 'rows')
  const none = empty('no findings')
  into(made.body, list, none)
  into(
    node,
    made.node,
    callout(
      'A judge answers questions; it never decides. A probability is not a verdict, and the account under one is the agent’s own testimony.',
    ),
  )

  return {
    node,
    update(view) {
      const rows = findingsOf(view.store).sort(
        (a, b) => whose(a) - whose(b) || b.probability - a.probability,
      )
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} findings`)
      none.hidden = rows.length > 0
      textIn(none, nothingSaid(view.may.findings, omitted(view.store, 'findings'), 'no findings'))
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
      textIn(moreSaid, ctx.sentence(answer))
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
    textIn(none, nothingSaid(view.may.notes, omitted(view.store, 'notes'), 'nothing written down'))
    if (cursor === null && held.length === 0) cursor = view.store.pages.notes?.next ?? null
    const n = Math.max(0, total - rows.length - extra.length)
    const may = view.may.notes === true
    more.hidden = !may || n === 0 || cursor === null || ctx === null
    textIn(more, `Show older · ${n}`)
    textIn(left, n === 0 || !may || !more.hidden ? '' : `${n} older notes are not on this page`)
    left.hidden = n === 0 || !may || !more.hidden
  }

  return { node, update: draw }
}

/* ── this device, and the others ───────────────────────────────────────────── */

/**
 * What this browser's own credential is, and every device that has been let in.
 *
 * **The whole list is here on purpose.** Nothing on this machine is contained —
 * an agent runs as you and can append to the paired-device list — so seeing
 * every device there is, is the mitigation, and disconnecting one needs no
 * network at all. That is said here because this is the page somebody reads it
 * on, and it is the page's own sentence about its own list rather than a second
 * copy of the domain's.
 */
export function devicesScreen(ctx) {
  const node = el('div')
  const mine = section('THIS DEVICE', { top: true })
  const facts = dl()
  const noSession = el('p', { class: 'unknown' })
  const out = el('button', { class: 'press quietly', text: 'Sign this device out' })
  const said = el('p', { attrs: { role: 'status' } })
  into(mine.body, facts, noSession, out, said)

  // **The notifications control, and it is on this screen because this is the
  // screen about this device.** The permission belongs to the phone, not to
  // the machine, and `pushState` reads the phone's own answer rather than a
  // row in a file — so a permission somebody took back in their browser's
  // settings draws as blocked here instead of as on.
  const telling = section('NOTIFICATIONS')
  const tellingSaid = el('p', { attrs: { role: 'status' } })
  const tell = el('button', { class: 'press' })
  into(
    telling.body,
    tellingSaid,
    tell,
    callout(
      'A notification says how many pieces of work want you and nothing else — no project, no task, no title — unless details are turned on at the machine. It is relayed by your browser’s own push service, which cannot read it, and it is sent only while Tade’s window is open and the machine is awake. Nothing is caught up afterwards.',
    ),
  )
  /** What the *phone* says, which is the one thing this screen cannot derive. */
  let standing = null
  /**
   * What the machine was offering when the phone was last asked.
   *
   * Kept so that `update` can tell *the machine changed its mind* from *this
   * is the fourth paint of the same second*: asking the browser costs a
   * `getRegistration` and a `getSubscription`, which is not a thing to do four
   * times a second, and not asking at all would leave the control absent for
   * as long as the screen stays open after somebody turns notifications on.
   */
  let asked = null
  const askPhone = async () => {
    asked = JSON.stringify(ctx.shell()?.notifying ?? null)
    standing = await pushState(ctx.shell())
    drawTelling()
  }
  const drawTelling = () => {
    // Hidden rather than drawn as unavailable while the machine is not
    // offering it: a control for a thing nobody turned on costs a section to
    // say nothing. The same decision the window makes about its own away
    // panel.
    telling.node.hidden = standing === null || standing === NOT_OFFERED
    textIn(tellingSaid, standing === null ? 'asking…' : (PUSH_SAID[standing] ?? ''))
    tell.hidden = standing !== ON && standing !== OFF
    textIn(tell, standing === ON ? 'Stop telling this device' : 'Tell this device')
  }
  drawTelling()
  void askPhone()

  tell.addEventListener('click', async () => {
    tell.disabled = true
    // **The press is what raises the browser's prompt**, and it has to be this
    // handler: a prompt that is not a direct answer to a gesture is refused by
    // every browser that implements this, silently.
    standing = standing === ON ? await unsubscribe(ctx.ask) : await subscribe(ctx.shell(), ctx.ask)
    tell.disabled = false
    drawTelling()
  })

  const others = section('DEVICES')
  const list = panel('ul', 'rows')
  const loading = el('p', { class: 'empty', text: 'asking…' })
  into(others.body, list, loading)
  // The device list is not on the stream — letting a phone in or disconnecting
  // one is not a projection change — so it is asked for when this screen
  // opens, which is the only moment anybody is reading it.
  void ctx.freshen()

  out.addEventListener('click', async () => {
    out.disabled = true
    const who = ctx.session()
    if (who === null) {
      textIn(said, 'this device has no session to sign out')
      out.disabled = false
      return
    }
    const answer = await ctx.ask('DELETE', `/api/devices/${encodeURIComponent(who.device)}`, {})
    if (answer.status === 200) {
      ctx.go('/pair', { replace: true })
      return
    }
    out.disabled = false
    textIn(said, ctx.sentence(answer))
  })

  into(
    node,
    mine.node,
    telling.node,
    others.node,
    callout(
      'Every device that has been let in is listed here, and disconnecting one is done at the machine and needs no network. Nothing running on that machine is contained: anything there runs as you.',
    ),
  )

  return {
    node,
    update(view) {
      const who = ctx.session()
      const until = who === null ? null : untilSaid(who.until, view.asOf)
      dlIn(facts, [
        ['this device', who === null ? null : who.label],
        ['may read', who === null ? null : readsSaid(who.reads)],
        ['may do', who === null ? null : who.scopes.join(', ')],
        ['session runs out', until === null ? null : `in ${until}`],
      ])
      sayIn(noSession, who === null ? '— could not read this device’s own session' : null)
      // The machine's half arrives on `/api/devices`, which `freshen` asks
      // again when this screen opens — so somebody who turns notifications on
      // at the machine and reloads the phone gets the control, and nobody
      // pays for a round trip per paint.
      if (asked !== JSON.stringify(ctx.shell()?.notifying ?? null)) void askPhone()
      const rows = ctx.devices()
      loading.hidden = rows !== null
      keyed(
        list,
        rows ?? [],
        (one) => one.device,
        createDeviceRow,
        (one, row) => fillDeviceRow(one, row, view),
      )
      textIn(others.figure, rows === null ? '' : count(rows.length))
    },
  }
}

/** What a device was granted, in words, with the floor said rather than left blank. */
function readsSaid(reads) {
  return reads.length === 0 ? 'names and counts' : reads.join(', ')
}

function createDeviceRow() {
  const node = el('li')
  const body = el('div')
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(body, el('span', { class: 'glyph', text: '⌸' }), name, aside)
  return into(node, body)
}

function fillDeviceRow(node, device, view) {
  const [body] = node.children
  const [, name, aside] = body.children
  textIn(name, `${device.label}${device.you ? ' · this one' : ''}`)
  const age = ageSaid(device.pairedAt, view.asOf, view.frozen)
  textIn(aside, age === null ? '' : `paired ${age} ago`)
}

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
  // **The sidebar's own categories**, so a place is in one group on a phone
  // and at a desk alike — and the projects as a group of their own, each a
  // link with what wants you and what works in it, as the rail has them.
  let projects = null
  for (const group of GROUPS) {
    const views = group.views.filter((view) => MORE.some((one) => one.view === view))
    if (group.key !== 'projects' && views.length === 0) continue
    const list = panel('ul', 'places')
    if (group.title === '') into(made.body, list)
    else {
      const part = section(group.title.toUpperCase())
      into(part.body, list)
      into(node, part.node)
    }
    if (group.key === 'projects') projects = list
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
      if (projects === null) return
      keyed(
        projects,
        projectsOf(view.store),
        (row) => row.name,
        () => {
          const row = el('li')
          const link = el('a', { attrs: { href: '/' } })
          into(
            link,
            icon('folder'),
            el('span', { class: 'label' }),
            el('span', { class: 'ui-count is-wants' }),
          )
          return into(row, link)
        },
        (row, project) => {
          const link = row.firstChild
          link.setAttribute('href', pathOf({ view: 'project', project: project.name }))
          textIn(link.children[1], project.name)
          const n = project.counts.wantsYou
          textIn(link.children[2], n === 0 ? '' : String(n))
          link.children[2].setAttribute('aria-label', `${n} wanting you`)
        },
      )
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
    el('h1', { text: 'Nothing here' }),
    el('p', {
      class: 'empty',
      text: 'This address is not one of Tade’s screens. It may belong to a newer version than this page.',
    }),
    el('a', { text: 'Go to the overview', attrs: { href: '/' } }),
  )
  return { node, update() {} }
}
