// The notes: what Tade was told, and what each one is told to.
//
// **What somebody opening this page wants first** is what Tade knows and where
// it applies — so the page leads with how many notes there are, how new the
// newest is, and a picture of every note as a mark on a lane per place it
// applies (everywhere, then each project) at the moment it was said. Under it
// the notes themselves, grouped by **where** they apply — everywhere first,
// then a project at a time, its own notes before its tasks' — or, one press
// away, by **when** they were said.
//
// **A note is never reworded.** Where whoever took it down wrote a headline
// beside it, the headline is the line a card is scanned by and the note itself
// is one press away, whole, under *Exactly as said*; where there is none, the
// note is the card's line, verbatim. Both are written with `textContent` and in
// the shape they were typed: a rule down the side is the page's one mark for
// *these are the words as said*, and a bold line is a headline beside them.
//
// Nothing here decides a note's place, its group or its window
// (`notes-shape.js`).

import { mayFor } from '../access.js'
import { lanes, lanesIn } from '../charts.js'
import { el, into, keyed, proseOf, skeleton, textIn, unknown } from '../dom.js'
import { count, shortClockOf } from '../figures.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { notesOf, omitted, projectAt, taskAt } from '../store.js'
import { troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { answerIn, stateBox, stateBoxIn } from '../ui.js'
import {
  asOfLine,
  BANDS,
  chartFoot,
  foldSaid,
  leadLine,
  notesPage,
  olderAfter,
  olderOffered,
  rowsWith,
  shownOf,
  tallyOf,
  UNWALKED,
  wholeOf,
} from './notes-shape.js'

/** A region's state, as `stateBoxIn` takes it, from the shape's own. */
function stateOf(one) {
  if (one === null) return null
  const { kind, line } = one
  const title = one.heading
  return { kind, icon: one.icon, title, line }
}

/** Which projects and tasks the page has somewhere to go for. */
function placesIn(store) {
  return {
    project: (name) => projectAt(store, name) !== null,
    task: (id) => {
      const cut = id.indexOf('/')
      return cut > 0 && taskAt(store, id.slice(0, cut), id.slice(cut + 1)) !== null
    },
  }
}

/** The mark beside a place, in the lead's tally and on a chip: the machine, a project, one agent's task. */
const GLYPHS = { everywhere: 'laptop', project: 'folder', task: 'agents' }

let cards = 0

export function notesScreen(ctx = null) {
  const node = el('div')
  const made = section('NOTES', {
    top: true,
    hint: 'What you told Tade, word for word. Every agent is told the notes on everywhere, on its project and on its own task.',
  })
  const state = { by: 'where', open: new Set(), last: null }
  const by = byOf(state, () => state.last !== null && draw(state.last))
  made.tools.prepend(by.node)
  const coming = skeleton(4)
  const whole = stateBox()
  whole.classList.add('nt-whole')
  const lead = leadOf()
  const asof = el('div', { class: 'nt-asof' })
  const where = whereOf(state)
  const when = whenOf(state)
  const older = olderOf(ctx, () => state.last !== null && draw(state.last))
  made.body.classList.add('nt-body')
  into(made.body, coming, whole, lead.node, asof, where.node, when.node, older.node)
  into(node, made.node)

  const draw = (view) => {
    state.last = view
    const store = view.store
    const had = store.had === true
    const may = had && mayFor(store, 'notes')
    const sent = may ? notesOf(store) : []
    const rows = rowsWith(sent, older.held())
    const total = may ? (store.pages.notes?.total ?? rows.length) : 0
    const page = may ? notesPage(rows, view.asOf, placesIn(store)) : null
    const shut = view.standing === 'unreachable' || view.standing === 'closed'
    coming.hidden = had || shut
    textIn(made.figure, total === 0 ? '' : count(total))
    // A label on an empty figure is one axe refuses: said only when drawn.
    if (total === 0) made.figure.removeAttribute('aria-label')
    else made.figure.setAttribute('aria-label', `${total} notes`)
    stateBoxIn(whole, stateOf(wholeOf(had, shut, may, page?.total ?? 0, omitted(store, 'notes'))))
    const drawn = page !== null && page.total > 0
    by.node.hidden = !drawn
    lead.node.hidden = !drawn
    where.node.hidden = !drawn || state.by !== 'where'
    when.node.hidden = !drawn || state.by !== 'when'
    const left = Math.max(0, total - rows.length)
    const asking = older.fill(may && drawn ? left : 0, store.pages.notes?.next ?? null)
    const clock = shortClockOf(new Date(view.asOf).toISOString())
    sayIn(asof, drawn ? asOfLine(view.frozen, clock, asking ? 0 : left) : '')
    if (!drawn) return
    lead.fill(page)
    if (state.by === 'where') where.fill(page)
    else when.fill(page)
  }

  return { node, update: draw }
}

/** The line under the lead, rewritten only when it changed. */
function sayIn(node, said) {
  node.hidden = said === ''
  if (node.dataset.said === said) return
  node.dataset.said = said
  node.replaceChildren(said === '' ? '' : unknown(said))
}

/* ── the bar's tool: where, or when ─────────────────────────────────────────── */

const BY = [
  { key: 'where', word: 'Where' },
  { key: 'when', word: 'When' },
]

function byOf(state, redraw) {
  const node = el('div', {
    class: 'nt-by',
    attrs: { role: 'group', 'aria-label': 'Group the notes by' },
  })
  for (const one of BY) {
    const chip = el('button', {
      class: 'ui-chip nt-by-chip',
      text: one.word,
      attrs: { type: 'button', 'aria-pressed': one.key === state.by ? 'true' : 'false' },
    })
    chip.addEventListener('click', () => {
      if (state.by === one.key) return
      state.by = one.key
      for (const press of node.children) {
        press.setAttribute('aria-pressed', press === chip ? 'true' : 'false')
      }
      redraw()
    })
    into(node, chip)
  }
  return { node }
}

/* ── the lead: how many, how new, and every note where and when ─────────────── */

function leadOf() {
  const node = el('div', { class: 'ui-card nt-lead' })
  const sum = el('div', { class: 'nt-sum' })
  const total = el('p', { class: 'nt-total' })
  into(total, el('span', { class: 'nt-total-n' }), el('span', { class: 'nt-total-unit' }))
  const recent = el('p', { class: 'nt-line' })
  const tally = el('ul', { class: 'nt-tally', attrs: { 'aria-label': 'Where they apply' } })
  into(sum, total, recent, tally)
  const chart = el('div', { class: 'nt-chart' })
  const head = el('p', { class: 'nt-chart-head' })
  const drawing = lanes('Notes by where they apply and when they were said')
  drawing.classList.add('nt-lanes')
  const foot = el('p', { class: 'nt-chart-foot' })
  into(chart, head, drawing, foot)
  into(node, sum, chart)
  return {
    node,
    fill(page) {
      const [n, unit] = total.children
      textIn(n, String(page.total))
      textIn(unit, page.total === 1 ? 'note' : 'notes')
      textIn(recent, leadLine(page))
      recent.classList.toggle('is-fresh', page.fresh > 0)
      keyed(tally, tallyOf(page), (one) => one.key, createTally, fillTally)
      textIn(head, `Where and when · ${page.chart.said}`)
      lanesIn(drawing, page.chart)
      const said = chartFoot(page.chart)
      textIn(foot, said)
      foot.hidden = said === ''
    },
  }
}

function createTally(one) {
  const item = el('li')
  into(
    item,
    icon(GLYPHS[one.key]),
    el('span', { class: 'nt-tally-label', text: one.label }),
    el('span', { class: 'nt-tally-n' }),
  )
  return item
}

function fillTally(item, one) {
  textIn(item.lastChild, String(one.n))
  item.classList.toggle('is-none', one.n === 0)
}

/* ── a group of notes: a panel of cards, folded to its newest ───────────────── */

function groupOf(label) {
  const list = el('ul', { class: 'ui-panel nt-cards', attrs: { 'aria-label': label } })
  const fold = el('button', {
    class: 'press quietly small nt-fold',
    attrs: { type: 'button' },
  })
  fold.hidden = true
  return { list, fold }
}

function groupIn(made, group, state, inGroup) {
  const open = state.open.has(group.key)
  const shown = shownOf(group, open)
  keyed(
    made.list,
    shown.cards,
    (one) => one.id,
    createCard,
    (item, one) => fillCard(item, one, inGroup),
  )
  const said = foldSaid(group, open)
  made.fold.hidden = said === null
  if (said === null) return
  textIn(made.fold, said)
  made.fold.setAttribute('aria-expanded', open ? 'true' : 'false')
  made.fold.onclick = () => {
    if (state.open.has(group.key)) state.open.delete(group.key)
    else state.open.add(group.key)
    groupIn(made, group, state, inGroup)
  }
}

/* ── where: everywhere, then each project ───────────────────────────────────── */

function whereOf(state) {
  const node = el('div', { class: 'nt-view' })
  const every = section('EVERYWHERE', {
    hint: 'Told to every agent on this machine, whatever it works on.',
  })
  const everyGroup = groupOf('Notes on everywhere')
  into(every.body, everyGroup.list, everyGroup.fold)
  const projects = section('BY PROJECT', {
    hint: 'A note on a project is told to every agent in it, and a note on a task to that task’s agent.',
  })
  const groups = el('ul', { class: 'nt-groups', attrs: { 'aria-label': 'Projects' } })
  into(projects.body, groups)
  into(node, every.node, projects.node)
  return {
    node,
    fill(page) {
      const one = page.where.everywhere
      every.node.hidden = one.n === 0
      figureIn(every.figure, one.n, 'notes')
      groupIn(everyGroup, one, state, true)
      const all = page.where.projects
      projects.node.hidden = all.length === 0
      figureIn(
        projects.figure,
        all.reduce((n, group) => n + group.n, 0),
        'notes',
      )
      keyed(
        groups,
        all,
        (group) => group.key,
        createProject,
        (item, group) => fillProject(item, group, state),
      )
    },
  }
}

/** A section's figure: how many, labelled only while there is one to say. */
function figureIn(figure, n, noun) {
  textIn(figure, n === 0 ? '' : String(n))
  if (n === 0) figure.removeAttribute('aria-label')
  else figure.setAttribute('aria-label', `${n} ${noun}`)
}

/** Each project's panel and fold, by the item they are in. */
const groupsOf = new WeakMap()

function createProject() {
  const item = el('li', { class: 'nt-group' })
  const head = el('div', { class: 'nt-group-head' })
  const name = el('a', { class: 'nt-group-name' })
  into(name, icon('folder'), el('span'))
  into(head, name, el('span', { class: 'nt-group-n' }), el('span', { class: 'nt-group-under' }))
  const made = groupOf('Notes')
  into(item, head, made.list, made.fold)
  groupsOf.set(item, made)
  return item
}

function fillProject(item, group, state) {
  const [head] = item.children
  const [name, n, under] = head.children
  textIn(name.lastChild, group.name)
  if (group.href === null) name.removeAttribute('href')
  else name.setAttribute('href', group.href)
  textIn(n, String(group.n))
  n.setAttribute('aria-label', `${group.n} ${group.n === 1 ? 'note' : 'notes'}`)
  textIn(under, group.under)
  const made = groupsOf.get(item)
  made.list.setAttribute('aria-label', `Notes on ${group.name}`)
  groupIn(made, group, state, true)
}

/* ── when: the last day, the week, the month, before ──────────────────────── */

function whenOf(state) {
  const node = el('div', { class: 'nt-view' })
  const bands = new Map()
  for (const band of BANDS) {
    const part = section(band.heading)
    const group = groupOf(`Notes, ${band.heading.toLowerCase()}`)
    into(part.body, group.list, group.fold)
    into(node, part.node)
    bands.set(band.key, { part, group })
  }
  return {
    node,
    fill(page) {
      for (const band of page.when) {
        const made = bands.get(band.key)
        made.part.node.hidden = band.n === 0
        figureIn(made.part.figure, band.n, 'notes')
        groupIn(made.group, { ...band, key: `when:${band.key}` }, state, false)
      }
    },
  }
}

/* ── a card: the headline, or the words, and the words one press away ───────── */

/**
 * One note. Built once — a note never changes, so its words are written when
 * the card is made and never again — and filled with what moves: its age,
 * whether it is new, and where its chip goes.
 */
function createCard(note) {
  cards += 1
  const item = el('li', { class: note.headline === null ? 'nt-card is-plain' : 'nt-card' })
  const top = el('div', { class: 'nt-top' })
  const id = `nt-${cards}`
  const main =
    note.headline === null
      ? into(el('div', { class: 'nt-words' }), proseOf(note.words, note.long))
      : el('p', { class: 'nt-headline', text: note.headline.words, attrs: { id: `${id}-head` } })
  // How long ago, with the words around it said and not drawn.
  const age = el('span', { class: 'nt-age' })
  into(
    age,
    el('span', { class: 'sr-only' }),
    el('span', { class: 'nt-age-n' }),
    el('span', { class: 'sr-only' }),
  )
  into(top, main, age)
  const foot = el('div', { class: 'nt-foot' })
  const chip = el('a', { class: 'nt-chip' })
  into(chip, el('span', { class: 'ui-pill nt-pill' }))
  into(foot, chip)
  into(item, top, foot)
  if (note.headline === null) {
    into(foot, el('span', { class: 'nt-by', text: note.by ?? '' }))
    return item
  }
  // The note itself, whole, under the headline written beside it — the press
  // described by that headline, so ten of them are not ten of one name.
  const press = el('button', {
    class: 'nt-open',
    attrs: {
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': `${id}-said`,
      'aria-describedby': `${id}-head`,
    },
  })
  into(press, el('span', { text: 'Exactly as said' }), icon('chevron'))
  const said = el('div', { class: 'nt-said', attrs: { id: `${id}-said` } })
  const about = [note.by, note.when].filter((one) => one !== null).join(' · ')
  into(
    said,
    into(el('div', { class: 'nt-words' }), proseOf(note.words)),
    about === '' ? null : el('p', { class: 'nt-about', text: about }),
  )
  said.hidden = true
  press.addEventListener('click', () => {
    const open = said.hidden
    said.hidden = !open
    press.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  into(foot, press)
  into(item, said)
  return item
}

function fillCard(item, note, inGroup) {
  const [top, foot] = item.children
  const [before, value, after] = top.lastChild.children
  textIn(before, note.age === null ? '' : 'said ')
  textIn(value, note.age ?? '—')
  textIn(after, note.age === null ? ' when it was said is not recorded' : ' ago')
  item.classList.toggle('is-fresh', note.fresh)
  const place = inGroup ? note.chip : note.place
  const chip = foot.firstChild
  chip.hidden = place === null
  // A plain card everywhere with no source to say has nothing at its foot.
  foot.hidden = place === null && foot.textContent === ''
  if (place === null) return
  const pill = chip.firstChild
  const drawn = `${place.kind} ${place.of ?? ''} ${place.word} ${place.href !== null}`
  if (pill.dataset.drawn !== drawn) {
    pill.dataset.drawn = drawn
    pill.replaceChildren(icon(GLYPHS[place.kind]))
    if (place.of !== null) into(pill, el('span', { class: 'nt-of', text: `${place.of} /` }))
    into(pill, el('span', { class: 'nt-place', text: place.word }))
    // A chip that goes somewhere says so, on a phone as much as under a pointer.
    if (place.href !== null) into(pill, icon('chevron', 'nt-go'))
  }
  if (place.href === null) chip.removeAttribute('href')
  else chip.setAttribute('href', place.href)
}

/* ── the older pages: asked for, not sent ───────────────────────────────────── */

/** The press that asks the machine for the page after the newest (`olderAfter`, `olderOffered`). */
function olderOf(ctx, redraw) {
  const node = el('div', { class: 'nt-older' })
  const press = el('button', {
    class: 'press quietly nt-older-press',
    attrs: { type: 'button' },
  })
  const said = el('p', { class: 'nt-older-said', attrs: { role: 'status' } })
  into(node, press, said)
  let walk = UNWALKED
  let cursor = null
  let asking = false
  press.addEventListener('click', async () => {
    if (ctx === null || asking || cursor === null) return
    asking = true
    press.disabled = true
    const answer = await ctx.ask('GET', `/api/notes?after=${encodeURIComponent(cursor)}`)
    asking = false
    press.disabled = false
    if (answer.status !== 200 || answer.body === null) {
      answerIn(said, '', troubleOf(answer) ?? UNKNOWN_TROUBLE)
      return
    }
    walk = olderAfter(walk, answer.body)
    answerIn(said, walk.restarted ? 'The notes moved; started again from the newest.' : '', null)
    redraw()
  })
  return {
    node,
    held: () => walk.held,
    /** Offer the next page where there is one and somebody to ask; true while it is offered. */
    fill(left, next) {
      const now = olderOffered(walk, left, next, ctx !== null)
      cursor = now.cursor
      press.hidden = !now.offered
      node.hidden = !now.offered && said.textContent === ''
      textIn(press, `Show older notes · ${left}`)
      return now.offered
    },
  }
}
