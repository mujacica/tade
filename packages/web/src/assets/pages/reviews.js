// The reviews: every branch offered for merge, by what holds it, then the
// finished work nobody offered, then what is settled.
//
// **What somebody opening this page wants first** is which reviews are stuck
// and on what — so the page leads with the way the work flows: what has
// commits and no review, what is open (one bar of everything open, by what
// holds it), and what merged. Then a card for each open review, in the order a
// person acts on them: what waits on them, with the press to answer it; what
// is held by a red check, a draft or a check nobody ran; and what is free to
// merge, which is theirs to do on the forge. Each card draws its checks at its
// head as a row of cells — every failing check by name, every one that never
// ran hatched — so a review's trouble is read without opening it.
//
// What has commits and no review is a quiet list under them, and what merged
// or closed is folded away.
//
// Nothing here decides what holds a review or what its checks add up to
// (`reviews-shape.js`).

import { mayFor } from '../access.js'
import { stack, stackIn, toneIn } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn, toneOn, unknown } from '../dom.js'
import { count, shortClockOf } from '../figures.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { section } from '../rows.js'
import { omitted, reviewsOf, taskAt } from '../store.js'
import { TROUBLES } from '../trouble.js'
import { note, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  figureSaid,
  heldSaid,
  leadSaid,
  omittedSaid,
  reviewsPage,
  rowLine,
  settledSaid,
  stagesOf,
} from './reviews-shape.js'

/** A region's state, as `stateBoxIn` takes it, with this page's mark unless it says. */
function stateOf(kind, title, line, mark = 'reviews') {
  return { kind, icon: mark, title, line }
}

export function reviewsScreen(ctx = null) {
  const node = el('div')
  const made = section('REVIEWS', {
    top: true,
    hint: 'A review is a branch offered for merge. What holds one is read off its agent, its required checks at its head and what its forge says; Tade never merges — that is yours, on the forge.',
  })
  const coming = skeleton(4)
  const whole = stateBox()
  whole.classList.add('rv-whole')
  const lead = leadOf()
  // Without the grant only the **link** to each review is withheld
  // (`tasks.review.url`): whether a branch was offered, and how it stands, is
  // sent to every device and drawn below. Said once, so a card with no press
  // to its forge reads as withheld rather than as a forge with nothing to open.
  const scope = note(
    'review links not granted',
    'This device was not granted the link to each review on its forge.',
    'reviews',
  )
  scope.classList.add('rv-scope')
  const left = el('div', { class: 'rv-omitted' })
  const you = groupOf('WAITING ON YOU', 'you', 'Waiting on you', ctx, {
    hint: 'Its agent asked you something — an approval or a question — and the review waits with it.',
  })
  const blocked = groupOf('BLOCKED', 'blocked', 'Blocked', null, {
    hint: 'Held by a required check failing at its head, by being a draft, or by checks nobody ran at its head here. Unanswered threads are not read here, so none is counted.',
  })
  const ready = groupOf('READY TO MERGE', 'ready', 'Ready to merge', null, {
    hint: 'Every required check green at its head, and nothing waits on anybody. Merging is yours, on the forge: Tade never merges.',
  })
  const quiet = quietOf()
  const settled = settledOf()
  made.body.classList.add('rv-body')
  into(
    made.body,
    coming,
    whole,
    lead.node,
    scope,
    left,
    you.made.node,
    blocked.made.node,
    ready.made.node,
    quiet.made.node,
    settled.made.node,
  )
  into(node, made.node)
  const regions = [you, blocked, ready, quiet, settled]

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      const shut = view.standing === 'unreachable' || view.standing === 'closed'
      const { offered, unoffered } = had ? reviewsOf(store) : { offered: [], unoffered: [] }
      const page = had ? reviewsPage(offered, unoffered, view.asOf, view.frozen) : null
      coming.hidden = had || shut
      figureIn(made.figure, page)
      stateBoxIn(whole, wholeOf(had, shut, page))
      const shown = page !== null && page.total > 0
      lead.node.hidden = !shown
      scope.hidden = !shown || mayFor(store, 'tasks.review.url')
      const gone = had ? omittedSaid(omitted(store, 'tasks')) : null
      left.hidden = !shown || (gone === null && !view.frozen)
      if (!left.hidden) {
        const clock = view.frozen ? `as of ${shortClockOf(new Date(view.asOf).toISOString())}` : ''
        sayLeft(left, [clock, gone].filter(Boolean).join(' · '))
      }
      if (!shown) {
        for (const one of regions) one.made.node.hidden = true
        return
      }
      lead.fill(page)
      you.fill(page.you, view)
      blocked.fill(page.blocked, view)
      ready.fill(page.ready, view)
      quiet.fill(page.unoffered)
      settled.fill(page.settled)
    },
  }
}

/**
 * The page's own state, when there is nothing to draw: coming, could not
 * reach, or nothing offered and nothing waiting to be — never a blank.
 */
function wholeOf(had, shut, page) {
  if (!had) {
    return shut ? stateOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, 'alert') : null
  }
  if (page.total > 0) return null
  return stateOf(
    'empty',
    'No reviews',
    'When an agent offers its branch for merge, it is drawn here with what holds it.',
  )
}

/** The bar's word: what most wants the person, as a pill in its tone. */
function figureIn(figure, page) {
  const said = figureSaid(page)
  textIn(figure, said.word)
  figure.classList.toggle('ui-pill', said.word !== '')
  toneOn(figure, said.tone)
}

/** The line under the lead: the moment a page that is not live was true at, and what it was not sent. */
function sayLeft(node, said) {
  if (node.dataset.said === said) return
  node.dataset.said = said
  node.replaceChildren(unknown(said))
}

/* ── the lead: never offered, open by what holds it, merged ───────────────── */

/**
 * The flow of the work, left to right: what has commits and no review, what
 * is open — the page's one big figure, and a bar of every open review by what
 * holds it — and what merged. On a phone the open part goes first and the two
 * either side of it sit under it.
 */
function leadOf() {
  const node = el('div', { class: 'ui-card rv-lead' })
  const before = stageOf('Not offered', 'rv-before')
  const after = stageOf('Merged', 'rv-after')
  const open = el('div', { class: 'rv-open' })
  const head = el('p', { class: 'rv-open-head' })
  into(
    head,
    el('strong', { class: 'rv-open-n' }),
    el('span', { class: 'rv-open-word', text: 'open' }),
    el('span', { class: 'rv-open-held' }),
  )
  const bar = stack('Open reviews, by what holds them')
  bar.classList.add('rv-bar')
  const threads = unknown('unanswered threads: not read here')
  threads.classList.add('rv-threads')
  into(open, head, bar, threads)
  into(node, before.node, arrow(), open, arrow(), after.node)
  return {
    node,
    fill(page) {
      const [n, , held] = head.children
      textIn(n, String(page.open))
      textIn(held, heldSaid(page))
      bar.hidden = page.open === 0
      bar.setAttribute('aria-label', leadSaid(page))
      stackIn(bar, page.parts)
      node.classList.toggle('is-wanted', page.counts.you > 0)
      const stages = stagesOf(page)
      before.fill(stages.before)
      after.fill(stages.after)
    },
  }
}

function arrow() {
  return el('span', { class: 'rv-arrow', text: '›', attrs: { 'aria-hidden': 'true' } })
}

/** A stage either side of open: its word, its figure, and a line under it. */
function stageOf(word, klass) {
  const node = el('p', { class: `rv-stage ${klass}` })
  into(
    node,
    el('span', { class: 'rv-stage-word', text: word }),
    el('strong', { class: 'rv-stage-n' }),
    el('span', { class: 'rv-stage-under' }),
  )
  return {
    node,
    fill(one) {
      const [, n, under] = node.children
      textIn(n, String(one.n))
      textIn(under, one.under)
      node.classList.toggle('is-none', one.n === 0)
    },
  }
}

/* ── the open reviews: a section for each kind of hold, a card for each ───── */

function groupOf(heading, key, label, ctx, opts) {
  const made = section(heading, opts)
  made.node.classList.add('rv-group', `rv-group-${key}`)
  const list = el('ul', { class: 'rv-cards', attrs: { 'aria-label': label } })
  into(made.body, list)
  return {
    made,
    fill(cards, view) {
      made.node.hidden = cards.length === 0
      textIn(made.figure, cards.length === 0 ? '' : count(cards.length))
      // A label on an empty figure is one axe refuses: said only when drawn.
      if (cards.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${cards.length} ${label.toLowerCase()}`)
      keyed(
        list,
        cards,
        (one) => one.id,
        () => createCard(ctx),
        (item, one) => fillCard(item, one, view),
      )
    },
  }
}

/**
 * A review: its agent and how long, what was asked for, what holds it and
 * why, the presses to answer it where it waits on you, its checks as cells,
 * and its branch with the press to its forge across the foot.
 *
 * The card is not a link: it may hold buttons, and a button inside a link is
 * two targets in one place. Its head is the link to the agent's page.
 *
 * The press to its forge is **the only link off this machine in the design**,
 * and is `https:`-only (`forgeOf`, `safeHref`): the URL came from the forge,
 * which makes it the one string on this page written by something off this
 * machine. It opens in a new tab with `noopener noreferrer`, so the forge gets
 * no handle on this window and no referrer carrying the away view's address.
 */
function createCard(ctx) {
  const item = el('li', { class: 'ui-card rv-card' })
  const head = el('a', { class: 'rv-card-head', attrs: { href: '/' } })
  into(
    head,
    el('span', { class: 'rv-card-name' }),
    el('span', { class: 'rv-card-project' }),
    el('span', { class: 'rv-card-age' }),
    icon('chevron', 'rv-go'),
  )
  const words = el('p', { class: 'rv-card-words' })
  // The mark in its own column and the words in one block beside it, so a
  // reason that wraps comes back under the word rather than under the mark.
  const hold = el('p', { class: 'rv-hold' })
  const said = el('span', { class: 'rv-hold-said' })
  into(
    said,
    el('strong', { class: 'rv-hold-word' }),
    el('span', { class: 'rv-hold-sep', text: ' · ', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'rv-hold-because' }),
  )
  into(hold, glyphOf({ glyph: '◆', word: '', tone: 't-wants' }, 'rv-hold-mark'), said)
  const quick = ctx === null || ctx === undefined ? null : quickActs(ctx)
  quick?.node.classList.add('rv-acts')
  const checks = el('div', { class: 'rv-checks' })
  const cells = el('ul', { class: 'rv-cells' })
  const overruled = el('span', { class: 'ui-pill rv-overruled', text: 'overruled' })
  into(
    checks,
    el('span', { class: 'rv-checks-word', text: 'Checks', attrs: { 'aria-hidden': 'true' } }),
    cells,
    overruled,
  )
  const foot = el('div', { class: 'rv-card-foot' })
  const branch = el('p', { class: 'rv-branch' })
  into(branch, el('span', { class: 'rv-branch-name' }), el('span', { class: 'rv-branch-distance' }))
  const forge = el('a', {
    class: 'press quietly small rv-forge',
    attrs: { href: '/', target: '_blank', rel: 'noopener noreferrer' },
  })
  into(forge, icon('arrow'), el('span', { class: 'rv-forge-n' }))
  into(foot, branch, forge)
  into(item, head, words, hold, quick?.node, checks, foot)
  item.quick = quick
  return item
}

function fillCard(item, card, view) {
  const [head, words, hold, ...rest] = item.children
  const [checks, foot] = rest.slice(-2)
  for (const kind of ['you', 'red', 'draft', 'unchecked', 'ready']) {
    item.classList.toggle(`is-${kind}`, card.hold === kind)
  }
  headIn(head, card)
  textIn(words, card.words ?? '')
  words.hidden = card.words === null
  const [mark, said] = hold.children
  const [word, , because] = said.children
  // The glyph's word is the hold's own, said once by the strong word beside it.
  markIn(mark, { ...card.holdMark, word: '' })
  textIn(word, card.holdMark.word)
  textIn(because, card.because)
  const row = item.quick === null ? null : rowAt(view, card)
  if (row !== null) item.quick.update(row, view)
  checksIn(checks, card.checks)
  footIn(foot, card)
}

/** The task row a card was made from, for the presses, which act on the row itself. */
function rowAt(view, card) {
  return taskAt(view.store, card.project, card.name)
}

/** The head: the name, the project, how long, and the chevron to its agent's page. */
function headIn(head, card) {
  const [name, project, age] = head.children
  head.setAttribute('href', card.href)
  textIn(name, card.name)
  textIn(project, card.project)
  ageIn(age, card.waitedSaid, card.asksYou ? 'waiting' : 'moved')
}

/**
 * How long, with its verb for anybody listening — and no label at all where
 * there is no moment, since a label on an empty span is one axe refuses.
 */
function ageIn(node, said, verb) {
  textIn(node, said ?? '')
  if (said === null) node.removeAttribute('aria-label')
  else node.setAttribute('aria-label', `${verb} ${said}`)
}

/**
 * The checks at its head: a cell for every failing check and every one that
 * never ran, each its name in its tone, or one cell for the rollup's word. The
 * cells are the text — the glyph is drawn and the word is said.
 */
function checksIn(node, checks) {
  const [, cells, overruled] = node.children
  cells.setAttribute('aria-label', checks.said)
  keyed(cells, checks.cells, (one) => one.key, createCell, fillCell)
  overruled.hidden = !checks.overruled
  overruled.setAttribute('aria-label', 'a failing check here was overruled at the machine')
}

function createCell() {
  const item = el('li', { class: 'rv-cell' })
  into(
    item,
    el('span', { class: 'rv-cell-mark', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'rv-cell-name' }),
    el('span', { class: 'sr-only' }),
  )
  return item
}

function fillCell(item, cell) {
  const [mark, name, word] = item.children
  textIn(mark, cell.glyph)
  textIn(name, cell.name)
  textIn(word, ` ${cell.word}`)
  toneIn(item, cell.tone)
}

/** The foot: the branch and how far it is from its base, and the press to its forge where there is a link. */
function footIn(foot, card) {
  const [branch, forge] = foot.children
  const [name, distance] = branch.children
  textIn(name, card.branch ?? 'no branch')
  textIn(distance, card.distance ?? '')
  distance.hidden = card.distance === null
  forge.hidden = card.forge === null
  if (card.forge === null) return
  if (forge.getAttribute('href') !== card.forge.href) forge.setAttribute('href', card.forge.href)
  const [, n] = forge.children
  textIn(n, card.forge.number ?? 'forge')
  forge.setAttribute(
    'aria-label',
    `Open ${card.forge.number === null ? 'the review' : `review ${card.forge.number}`} on its forge, in a new tab`,
  )
}

/* ── commits and no review: quiet rows ────────────────────────────────────── */

function quietOf() {
  const made = section('NOT OFFERED', {
    hint: 'A branch with commits ahead of its base and no review on its forge. Opening one is its agent’s to do — tell it from its page.',
  })
  const list = panel('ul', 'rv-rows')
  list.setAttribute('aria-label', 'Not offered for merge')
  into(made.body, list)
  return {
    made,
    fill(rows) {
      made.node.hidden = rows.length === 0
      textIn(made.figure, rows.length === 0 ? '' : count(rows.length))
      if (rows.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${rows.length} not offered`)
      keyed(
        list,
        rows,
        (one) => one.id,
        createRow,
        (item, one) => fillRow(item, one, one.agent, `agent ${one.agent.word}`),
      )
    },
  }
}

/** A row: the mark, the name and its project, the line under them and how long — the whole of it the link to its page. */
function createRow() {
  const item = el('li')
  const link = el('a', { class: 'rv-row', attrs: { href: '/' } })
  into(
    link,
    glyphOf({ glyph: '·', word: '', tone: 't-quiet' }, 'rv-row-mark'),
    el('span', { class: 'rv-row-name' }),
    el('span', { class: 'rv-row-age' }),
    el('span', { class: 'rv-row-line' }),
    icon('chevron', 'rv-go'),
  )
  into(item, link)
  return item
}

function fillRow(item, row, mark, word) {
  const [link] = item.children
  const [glyph, name, age, line] = link.children
  link.setAttribute('href', row.href)
  markIn(glyph, { ...mark, word })
  textIn(name, `${row.project} / ${row.name}`)
  ageIn(age, row.waitedSaid, 'moved')
  textIn(line, rowLine(row))
}

/* ── merged and closed: folded away until asked for ───────────────────────── */

/** Whether the settled reviews are unfolded, for as long as the page is open. */
let unfolded = false

function settledOf() {
  const made = section('MERGED AND CLOSED')
  const list = panel('ul', 'rv-rows')
  list.id = 'rv-settled'
  list.setAttribute('aria-label', 'Merged and closed')
  const press = el('button', {
    class: 'press quietly small rv-fold',
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
    fill(rows) {
      n = rows.length
      made.node.hidden = n === 0
      textIn(made.figure, n === 0 ? '' : count(n))
      if (n === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${n} merged or closed`)
      keyed(
        list,
        rows,
        (one) => one.id,
        createRow,
        (item, one) => fillRow(item, one, one.reviewMark, `review ${one.reviewMark.word}`),
      )
      foldIn()
    },
  }
}
