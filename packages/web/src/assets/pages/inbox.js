// What has been handed to this machine, as two screens: the inbox and one
// request.
//
// **What somebody opening the inbox wants first** is whether anything waits on
// them, how long it has, and what each one needs from them — so the page leads
// with that count beside a bar of every request by where it stands and a strip
// of the doors, then a card for each request waiting, grouped by the one thing
// it needs (to approve, held, given up), oldest first, each with its one press
// across its foot. What is on its way is a quiet list under them, what is
// settled is folded away, and beside them at a desk are the doors, the broken
// one first.
//
// One request is its own screen (`inbox-request.js`), re-exported here for the
// router.
//
// The three rules that break something quietly if they go:
//
// - **`proposed` and `started` are never one word.** One is waiting for a
//   person to say yes and the other is an agent spending money. `glyphs.js`
//   keeps them as far apart in shape and tone as *wants you* and *working*,
//   which is what they are.
// - **An empty list says *which* nothing.** A door that is off, one nobody
//   watches, one that was unreachable at the last look and one that looked and
//   found nothing are four different things to do next, and the page says
//   which out of `because` — Tade's own sentence, never a second wording here.
// - **A stranger's words are drawn under the heading that came with them.**
//   `materialLabel` rides on the row; the page does not choose a word for it,
//   because a drawing that put its own word there would be one edit away from
//   putting none.
//
// Nothing here decides a state, a count or a reason (`inbox-shape.js`).

import { stack, stackIn } from '../charts.js'
import {
  classOn,
  el,
  glyphOf,
  into,
  keyed,
  markIn,
  skeleton,
  textIn,
  toneOn,
  unknown,
} from '../dom.js'
import { count, shortClockOf } from '../figures.js'
import { intakeMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { sayIn, section } from '../rows.js'
import { intakeOf, omitted, sourcesOf } from '../store.js'
import { TROUBLES } from '../trouble.js'
import { panel, stateBox, stateBoxIn } from '../ui.js'
import { sectionCount } from './inbox-request.js'
import {
  byDoor,
  calmSaid,
  emptySays,
  figureSaid,
  groupSaid,
  heroSaid,
  inboxPage,
  knownIn,
  omittedSaid,
  settledSaid,
  stateOf,
  troubleOf,
} from './inbox-shape.js'

export { factsOf, materialIn, requestScreen } from './inbox-request.js'
export { emptySays } from './inbox-shape.js'

/** The bar's word: a violet pill while something waits on the person. */
function figureIn(figure, page) {
  const said = figureSaid(page)
  textIn(figure, said.word)
  figure.classList.toggle('ui-pill', said.word !== '')
  toneOn(figure, said.tone)
}

/* ── the inbox ─────────────────────────────────────────────────────────────── */

export function inboxScreen() {
  const node = el('div')
  const made = section('INBOX', {
    top: true,
    hint: 'Work that came from outside this machine, through the doors it watches. What waits on you comes first; approving one starts work this machine already allowed.',
  })
  const coming = skeleton(4)
  const whole = stateBox()
  whole.classList.add('ib-whole')
  const lead = leadOf()
  const left = el('div', { class: 'ib-omitted' })
  const waits = waitsOf()
  const moving = movingOf()
  const settled = settledOf()
  const doors = doorsOf()
  const main = el('div', { class: 'ib-main' })
  into(main, waits.made.node, moving.made.node, settled.made.node)
  const grid = el('div', { class: 'ib-grid' })
  into(grid, main, doors.made.node)
  made.body.classList.add('ib-body')
  into(made.body, coming, whole, lead.node, left, grid)
  into(node, made.node)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      const shut = view.standing === 'unreachable' || view.standing === 'closed'
      const sources = had ? sourcesOf(store) : []
      const page = had
        ? inboxPage(intakeOf(store), sources, view.asOf, view.now, knownIn(store))
        : null
      coming.hidden = had || shut
      figureIn(made.figure, page)
      stateBoxIn(whole, wholeOf(had, shut, page, sources))
      const some = page !== null && page.total > 0
      lead.node.hidden = !some
      main.hidden = !some
      grid.hidden = page === null
      classOn(grid, 'is-alone', !some)
      const gone = page === null ? null : omittedSaid(omitted(store, 'intake'), page.total)
      left.hidden = !some || (gone === null && !view.frozen)
      if (!left.hidden) {
        const clock = view.frozen ? `as of ${shortClockOf(new Date(view.asOf).toISOString())}` : ''
        sayLeft(left, [clock, gone].filter(Boolean).join(' · '))
      }
      if (page === null) return
      doors.fill(page)
      if (!some) return
      lead.fill(page)
      waits.fill(page)
      moving.fill(page)
      settled.fill(page)
    },
  }
}

/**
 * The page's own state when there is no request to draw: coming, could not
 * reach, or none — and **which** none, out of the doors' own sentences, red
 * where a door is why.
 */
function wholeOf(had, shut, page, sources) {
  if (!had) {
    return shut ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert') : null
  }
  if (page.total > 0) return null
  // In the doors' own order, so the sentence is about the door drawn first
  // under it — the broken one before one that clears on its own.
  const why = emptySays(byDoor(sources))
  const line = `${why.charAt(0).toUpperCase()}${why.slice(1)}.`
  return troubleOf(sources) === undefined
    ? stateOf('empty', 'Nothing handed over', line)
    : stateOf('error', 'Nothing handed over', line, 'alert')
}

/** The line under the lead: the moment a page that is not live was true at, and what it was not sent. */
function sayLeft(node, said) {
  if (node.dataset.said === said) return
  node.dataset.said = said
  node.replaceChildren(unknown(said))
}

/* ── the lead: how many wait on you, where everything stands, the doors ──── */

function leadOf() {
  const node = el('div', { class: 'ui-card ib-lead' })
  const hero = el('p', { class: 'ib-hero' })
  const words = el('span', { class: 'ib-hero-words' })
  into(words, el('span', { class: 'ib-hero-label' }), el('span', { class: 'ib-hero-under' }))
  into(hero, el('strong', { class: 'ib-hero-n' }), words)
  const bar = stack('Every request, by where it stands')
  bar.classList.add('ib-stand')
  const strip = el('div', { class: 'ib-strip' })
  const chips = el('ul', { class: 'ib-chips', attrs: { 'aria-label': 'Doors' } })
  into(
    strip,
    el('span', { class: 'ib-strip-label', text: 'Doors', attrs: { 'aria-hidden': 'true' } }),
    chips,
  )
  into(node, hero, bar, strip)
  return {
    node,
    fill(page) {
      const [n, said] = hero.children
      const [label, under] = said.children
      const words = heroSaid(page)
      textIn(n, String(page.waiting))
      textIn(label, words.label)
      sayIn(under, words.under)
      node.classList.toggle('is-wanted', page.waiting > 0)
      stackIn(bar, page.parts)
      strip.hidden = page.doors.length === 0
      keyed(chips, page.doors, (one) => one.key, createChip, fillChip)
    },
  }
}

/** A door in the lead's strip: its mark and its name, and its state's word where it is not calm. */
function createChip() {
  const item = el('li', { class: 'ib-chip' })
  into(
    item,
    glyphOf(intakeMark({ state: 'noticed', work: [] })),
    el('span'),
    el('span', { class: 'ib-chip-word' }),
  )
  return item
}

function fillChip(item, door) {
  const [glyph, name, word] = item.children
  markIn(glyph, door.mark)
  textIn(name, door.name)
  const loud = door.broken || door.state === 'rate-limited'
  // The word is said once: the glyph carries it for a screen reader, and the
  // visible one is for the doors a person has to look at.
  textIn(word, loud ? door.mark.word : '')
  word.hidden = !loud
  word.setAttribute('aria-hidden', 'true')
  classOn(item, 'is-broken', door.broken)
}

/* ── waiting on you: a group per kind, a card per request ─────────────────── */

function waitsOf() {
  const made = section('WAITS ON YOU')
  const calm = stateBox()
  const list = el('ul', { class: 'ib-groups', attrs: { 'aria-label': 'By what it needs' } })
  into(made.body, calm, list)
  return {
    made,
    fill(page) {
      sectionCount(made.figure, page.waiting, 'wait on you')
      stateBoxIn(
        calm,
        page.waiting > 0 ? null : stateOf('empty', 'Nothing waits on you', calmSaid(page), 'check'),
      )
      list.hidden = page.waiting === 0
      keyed(list, page.groups, (one) => one.kind, createGroup, fillGroup)
    },
  }
}

function createGroup() {
  const item = el('li', { class: 'ib-group' })
  const head = el('div', { class: 'ib-group-head' })
  into(head, el('h3', { class: 'ib-group-name' }), el('span', { class: 'ib-group-n' }))
  into(item, head, el('ul', { class: 'ib-cards' }))
  return item
}

function fillGroup(item, group) {
  const [head, cards] = item.children
  const [name, n] = head.children
  textIn(name, group.heading)
  textIn(n, groupSaid(group))
  item.dataset.kind = group.kind
  cards.setAttribute('aria-label', group.heading)
  keyed(cards, group.cards, (one) => one.key, createCard, fillCard)
}

/**
 * A request waiting on a person: its mark, its name and how long it has
 * waited as the card's one figure, where it came from, Tade's sentence about
 * it — the whole of that a press to the request — and the one thing to do
 * about it across the card's foot.
 */
function createCard() {
  const item = el('li', { class: 'ui-card ib-card' })
  const body = el('a', { class: 'ib-card-body', attrs: { href: '/inbox' } })
  const head = el('span', { class: 'ib-card-head' })
  into(
    head,
    glyphOf(intakeMark({ state: 'proposed', work: [] }), 'ib-card-mark'),
    el('strong', { class: 'ib-card-name' }),
    el('span', { class: 'ib-card-age' }),
  )
  const from = el('span', { class: 'ib-card-origin' })
  const tags = el('span', { class: 'ib-card-tags' })
  into(
    tags,
    el('span', { class: 'ui-pill t-working ib-card-moved', text: 'edited since' }),
    el('span', { class: 'ui-pill ib-card-starts' }),
  )
  into(body, head, from, el('span', { class: 'ib-card-why' }), tags)
  const foot = el('a', { class: 'ib-card-foot', attrs: { href: '/inbox' } })
  into(foot, el('span'), el('strong'), icon('chevron'))
  into(item, body, foot)
  return item
}

function fillCard(item, card) {
  const [body, foot] = item.children
  const [head, from, why, tags] = body.children
  const [mark, name, age] = head.children
  body.setAttribute('href', card.href)
  markIn(mark, card.mark)
  textIn(name, card.name)
  classOn(name, 'is-id', !card.named)
  textIn(age, card.waitedSaid)
  age.setAttribute(
    'aria-label',
    card.waited === null ? 'no moment recorded' : `arrived ${card.waitedSaid} ago`,
  )
  textIn(from, card.from)
  textIn(why, card.because)
  const [moved, starts] = tags.children
  moved.hidden = !card.moved
  moved.setAttribute('aria-label', 'edited at its source since the work was made')
  sayIn(starts, card.starts)
  tags.hidden = moved.hidden && starts.hidden
  item.dataset.kind = card.state
  const [word, who] = foot.children
  foot.setAttribute('href', card.action.href)
  textIn(word, card.action.word)
  textIn(who, card.action.name ?? '')
  who.hidden = card.action.name === null
}

/* ── on its way, and settled: quiet rows ──────────────────────────────────── */

function movingOf() {
  const made = section('ON ITS WAY')
  const list = panel('ul', 'ib-rows')
  list.setAttribute('aria-label', 'On its way')
  into(made.body, list)
  return {
    made,
    fill(page) {
      made.node.hidden = page.moving.length === 0
      sectionCount(made.figure, page.moving.length, 'on their way')
      keyed(list, page.moving, (one) => one.key, createRow, fillRow)
    },
  }
}

/** Whether the settled requests are unfolded, for as long as the page is open. */
let unfolded = false

function settledOf() {
  const made = section('SETTLED')
  const list = panel('ul', 'ib-rows')
  list.id = 'ib-settled'
  list.setAttribute('aria-label', 'Settled')
  const press = el('button', {
    class: 'press quietly small ib-fold',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': list.id },
  })
  let n = 0
  const foldIn = () => {
    list.hidden = !unfolded
    press.setAttribute('aria-expanded', unfolded ? 'true' : 'false')
    textIn(press, settledSaid(n, unfolded))
  }
  press.addEventListener('click', () => {
    unfolded = !unfolded
    foldIn()
  })
  into(made.body, press, list)
  return {
    made,
    fill(page) {
      n = page.settled.length
      made.node.hidden = n === 0
      sectionCount(made.figure, n, 'settled')
      keyed(list, page.settled, (one) => one.key, createRow, fillRow)
      foldIn()
    },
  }
}

/** A row: the mark, the name and how long ago it arrived, and under them where it came from and why it stands where it does. */
function createRow() {
  const item = el('li')
  const link = el('a', { class: 'ib-row', attrs: { href: '/inbox' } })
  into(
    link,
    glyphOf(intakeMark({ state: 'noticed', work: [] }), 'ib-row-mark'),
    el('span', { class: 'ib-row-name' }),
    el('span', { class: 'ib-row-age' }),
    el('span', { class: 'ib-row-line' }),
  )
  into(item, link)
  return item
}

function fillRow(item, row) {
  const [link] = item.children
  const [mark, name, age, line] = link.children
  link.setAttribute('href', row.href)
  markIn(mark, row.mark)
  textIn(name, row.name)
  textIn(age, row.waitedSaid)
  age.setAttribute(
    'aria-label',
    row.waited === null ? 'no moment recorded' : `arrived ${row.waitedSaid} ago`,
  )
  textIn(line, `${row.from} · ${row.because}`)
}

/* ── the doors ─────────────────────────────────────────────────────────────── */

function doorsOf() {
  const made = section('DOORS', {
    hint: 'Where outside work comes in. An empty inbox means something different behind each: a door that is off, one nothing looks through, one that could not be read, and one that looked and found nothing.',
  })
  const none = stateBox()
  const list = panel('ul', 'ib-doors')
  list.setAttribute('aria-label', 'Doors')
  into(made.body, none, list)
  return {
    made,
    fill(page) {
      const broken = page.doors.filter((one) => one.broken).length
      textIn(made.figure, broken === 0 ? count(page.doors.length) : `${broken} broken`)
      toneOn(made.figure, broken === 0 ? null : 't-failed')
      made.figure.classList.toggle('ui-pill', broken > 0)
      if (page.doors.length === 0) made.figure.removeAttribute('aria-label')
      else
        made.figure.setAttribute(
          'aria-label',
          broken === 0
            ? `${page.doors.length} doors`
            : `${broken} of ${page.doors.length} doors broken`,
        )
      stateBoxIn(
        none,
        page.doors.length > 0
          ? null
          : stateOf('empty', 'No doors', 'No source of outside work is implemented here.'),
      )
      list.hidden = page.doors.length === 0
      keyed(list, page.doors, (one) => one.key, createDoor, fillDoor)
    },
  }
}

/** A door: its mark, its name and its state's word, Tade's sentence, and when it last looked — or clears — with what it is set to do. */
function createDoor() {
  const item = el('li', { class: 'ib-door' })
  const head = el('div', { class: 'ib-door-head' })
  into(
    head,
    glyphOf(intakeMark({ state: 'noticed', work: [] }), 'ib-door-mark'),
    el('strong', { class: 'ib-door-name' }),
    el('span', { class: 'ib-door-state', attrs: { 'aria-hidden': 'true' } }),
  )
  into(item, head, el('p', { class: 'ib-door-why' }), el('p', { class: 'ib-door-facts' }))
  return item
}

function fillDoor(item, door) {
  const [head, why, facts] = item.children
  const [mark, name, state] = head.children
  markIn(mark, door.mark)
  textIn(name, door.name)
  textIn(state, door.mark.word)
  toneOn(state, door.broken ? 't-failed' : null)
  textIn(why, door.because)
  sayIn(facts, door.facts)
  classOn(item, 'is-broken', door.broken)
  classOn(item, 'is-shut', door.state === 'off' || door.state === 'ungranted')
}
