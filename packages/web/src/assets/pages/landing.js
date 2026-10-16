// The landing desk: every finished piece of work and every open review, in the
// order it is cheapest to trust — the same desk the window draws.
//
// **What somebody opening this page wants first** is what they can land now
// with the least reading, so the page leads with how the desk divides — ready,
// waiting on them, waiting on its agent — and then a card for each piece of
// work in the desk's own order: its name, where it stands and the one sentence
// why, and the figures somebody reads before trusting it (its checks at the
// head, the judge's findings, the collisions, what it changed, what it cost).
// A card's head is the link to its agent's page, where it is read and answered.
//
// Nothing here decides where a piece of work stands (`landing-shape.js`): the
// machine placed every row by core's own rule, and the page sorts by that.

import { mayFor } from '../access.js'
import { stack, stackIn } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn, toneOn } from '../dom.js'
import { count } from '../figures.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { rowsOf } from '../store.js'
import { facts, factsIn, stateBox, stateBoxIn } from '../ui.js'
import { deskPage, figureSaid, leadSaid, TIERS, wholeOf } from './landing-shape.js'

export function landingScreen() {
  const node = el('div')
  const made = section('LANDING DESK', {
    top: true,
    hint: 'Finished work and open reviews, cheapest to trust first: green and nothing open, then what waits on you, then what waits on its agent. Landing is yours, on the forge: Tade never merges.',
  })
  const coming = skeleton(4)
  const whole = stateBox()
  whole.classList.add('ld-whole')
  const lead = leadOf()
  const groups = Object.entries(TIERS).map(([key, tier]) => groupOf(key, tier))
  made.body.classList.add('ld-body')
  into(made.body, coming, whole, lead.node, ...groups.map((one) => one.made.node))
  into(node, made.node)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      const shut = view.standing === 'unreachable' || view.standing === 'closed'
      const granted = had && mayFor(store, 'tasks.landing')
      const page = granted
        ? deskPage(rowsOf(store, 'tasks'), view.asOf, {
            frozen: view.frozen,
            spend: mayFor(store, 'tasks.spend'),
          })
        : null
      coming.hidden = had || shut
      figureIn(made.figure, page)
      stateBoxIn(whole, wholeOf(had, shut, granted, page))
      const shown = page !== null && page.total > 0
      lead.node.hidden = !shown
      for (const one of groups) {
        if (shown) one.fill(page.groups[one.key])
        else one.made.node.hidden = true
      }
      if (shown) lead.fill(page)
    },
  }
}

/** The bar's word: what is ready, as a pill in its tone. */
function figureIn(figure, page) {
  const said = figureSaid(page)
  textIn(figure, said.word)
  figure.classList.toggle('ui-pill', said.word !== '')
  toneOn(figure, said.tone)
}

/* ── the lead: how the desk divides ───────────────────────────────────────── */

function leadOf() {
  const node = el('div', { class: 'ui-card ld-lead' })
  const head = el('p', { class: 'ld-lead-head' })
  into(
    head,
    el('strong', { class: 'ld-lead-n' }),
    el('span', { class: 'ld-lead-word', text: 'ready to land' }),
    el('span', { class: 'ld-lead-of' }),
  )
  const bar = stack('The desk, by whose move it is')
  bar.classList.add('ld-bar')
  into(node, head, bar)
  return {
    node,
    fill(page) {
      const [n, , of] = head.children
      textIn(n, String(page.groups.ready.length))
      textIn(of, `of ${page.total} on the desk`)
      bar.setAttribute('aria-label', leadSaid(page))
      stackIn(bar, page.parts)
    },
  }
}

/* ── a section per tier, a card per piece of work ─────────────────────────── */

function groupOf(key, tier) {
  const made = section(tier.heading)
  made.node.classList.add('ld-group', `ld-group-${key}`)
  const list = el('ul', { class: 'ld-cards', attrs: { 'aria-label': tier.word } })
  into(made.body, list)
  return {
    key,
    made,
    fill(cards) {
      made.node.hidden = cards.length === 0
      textIn(made.figure, cards.length === 0 ? '' : count(cards.length))
      if (cards.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${cards.length} ${tier.word}`)
      keyed(list, cards, (one) => one.id, createCard, fillCard)
    },
  }
}

/**
 * A piece of work: its name, project and how long it has waited — the head is
 * the link to its agent's page — what was asked for, where it stands and why,
 * and its figures in one row.
 */
function createCard() {
  const item = el('li', { class: 'ui-card ld-card' })
  const head = el('a', { class: 'ld-card-head', attrs: { href: '/' } })
  into(
    head,
    el('span', { class: 'ld-card-name' }),
    el('span', { class: 'ld-card-project' }),
    el('span', { class: 'ld-card-age' }),
    icon('chevron', 'ld-go'),
  )
  const words = el('p', { class: 'ld-card-words' })
  const why = el('p', { class: 'ld-why' })
  const said = el('span', { class: 'ld-why-said' })
  into(said, el('span', { class: 'ld-why-because' }), el('span', { class: 'ld-why-also' }))
  into(why, glyphOf({ glyph: '✓', word: '', tone: 't-done' }, 'ld-why-mark'), said)
  const figures = facts('Before trusting it')
  figures.classList.add('ld-facts')
  into(item, head, words, why, figures)
  return item
}

function fillCard(item, card) {
  const [head, words, why, figures] = item.children
  for (const kind of Object.keys(TIERS)) item.classList.toggle(`is-${kind}`, card.tier === kind)
  const [name, project, age] = head.children
  head.setAttribute('href', card.href)
  textIn(name, card.name)
  textIn(project, card.project)
  textIn(age, card.waitedSaid ?? '')
  // A label on an empty span is one axe refuses: said only where there is a moment.
  if (card.ageLabel === null) age.removeAttribute('aria-label')
  else age.setAttribute('aria-label', card.ageLabel)
  textIn(words, card.words ?? '')
  words.hidden = card.words === null
  const [mark, said] = why.children
  markIn(mark, card.mark)
  const [because, also] = said.children
  textIn(because, card.why)
  textIn(also, card.also === null ? '' : ` · ${card.also}`)
  factsIn(figures, card.facts)
}
