// The frame every screen is drawn inside: the wordmark, the freshness clock, the
// navigation, the bars that say how the page stands to the machine, and the
// region a screen reader is told about.
//
// **The freshness line is the most important thing on the page**, and §5.10 is
// why: when the stream drops, every row keeps its last state and the page gains
// one bar. No row changes glyph, no count changes, nothing becomes nought.
// *Unreachable is never stopped* — a sleeping laptop runs nothing, and a page
// that drew `0 working` because it could not ask would be lying about
// somebody's morning.
//
// Two accessibility decisions are structural rather than attributes sprinkled
// on afterwards:
//
// - **One `aria-live` region, and it announces only what crossed into wanting
//   you and what stopped.** Announcing the snapshot would read the whole page
//   aloud every two seconds, which is worse than announcing nothing.
// - **The navigation is a real `<nav>` with `aria-current` on where you are**,
//   and **an update never moves it**: the tab you are on changes when you
//   navigate and at no other time.

import { classOn, el, into, textIn, toneOn } from './dom.js'
import { clockOf, count, duration, shortClockOf } from './figures.js'
import { freshMark } from './glyphs.js'
import { backoffAt, partsOf } from './live.js'
import { MORE, NAV, navFor, pathOf, TITLES } from './routes.js'

/**
 * The whole frame, built once for the life of the page.
 *
 * Returns the parts the wiring writes into. Nothing here is rebuilt: a screen
 * is swapped inside `main`, and everything else is patched.
 */
export function shell() {
  const skip = el('a', {
    class: 'skip',
    text: 'skip to what wants you',
    attrs: { href: '#main' },
  })

  const top = el('header', { class: 'top' })
  const brand = el('a', { class: 'brand', attrs: { href: '/' } })
  into(
    brand,
    el('span', { class: 'mark', text: '▞', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: 'TADE' }),
    el('span', { class: 'what', text: 'away' }),
  )
  const fresh = el('p', { class: 'fresh', attrs: { role: 'status' } })
  const dot = el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } })
  const freshSaid = el('span')
  into(fresh, dot, el('span', { text: ' ' }), freshSaid)
  const tools = el('div', { class: 'tools' })
  const again = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Ask the machine again' },
  })
  into(again, el('span', { text: '⟳', attrs: { 'aria-hidden': 'true' } }))
  const keys = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Keyboard keys' },
  })
  into(keys, el('span', { text: '?', attrs: { 'aria-hidden': 'true' } }))
  into(tools, again, keys)
  into(top, brand, fresh, tools)

  const bars = el('div', { class: 'bars' })

  const frame = el('div', { class: 'frame' })
  const rail = el('nav', { class: 'rail', attrs: { 'aria-label': 'Sections' } })
  const main = el('main', { attrs: { id: 'main' } })
  into(frame, rail, main)

  const tabs = el('nav', { class: 'tabs', attrs: { 'aria-label': 'Sections' } })

  const sheet = el('div', {
    class: 'sheet',
    attrs: { role: 'dialog', 'aria-label': 'Keyboard keys' },
  })
  sheet.hidden = true
  into(sheet, keySheet())

  const announce = el('p', {
    class: 'sr-only',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  })

  const links = navLinks(rail, tabs)

  return {
    parts: [skip, top, bars, frame, tabs, sheet, announce],
    main,
    bars,
    dot,
    freshSaid,
    announce,
    sheet,
    again,
    keys,
    links,
  }
}

/**
 * The navigation, drawn twice: a rail for a tablet and up, a bottom bar for a
 * phone.
 *
 * Twice rather than one list moved by CSS, because the two are different
 * shapes — the rail carries names and counts at a desk and the bar carries four
 * plus More, which is the only arrangement that fits 360px with 44px targets.
 * Both are in the DOM, one is displayed, and each is a `<nav>` a screen reader
 * can jump to.
 */
function navLinks(rail, tabs) {
  const made = []
  for (const one of [...NAV, { view: 'more', mark: '⋯', label: 'More', counts: null }]) {
    made.push(entry(tabs, one, 'tab'))
  }
  for (const one of [...NAV, ...MORE]) {
    made.push(entry(rail, one, 'rail'))
  }
  return made
}

function entry(parent, one, where) {
  // The bottom bar's rows are styled by class and the rail's by descendant, so
  // the class is what the bar needs and the rail does not.
  const link = el('a', {
    class: where === 'tab' ? 'tab' : '',
    attrs: { href: pathOf({ view: one.view }) },
  })
  const mark = el('span', { class: 'mark', text: one.mark, attrs: { 'aria-hidden': 'true' } })
  const label = el('span', { text: one.label })
  const figure = el('span', { class: 'count' })
  into(link, mark, label, figure)
  parent.append(link)
  return { link, figure, view: one.view, counts: one.counts, where }
}

/**
 * Where you are, written into the navigation.
 *
 * **Only navigation calls this.** A delta never moves the current tab: the one
 * thing worse than a page that does not update is a page that moves the thing
 * you were about to press.
 */
export function navOn(links, where) {
  const here = navFor(where)
  for (const one of links) {
    if (one.view === here) one.link.setAttribute('aria-current', 'page')
    else one.link.removeAttribute('aria-current')
  }
}

/** What each count is a count *of*, because `5` alone is read aloud as "five". */
const NOUNS = {
  wantsYou: 'wanting you',
  queue: 'queued',
  reviews: 'offered for merge',
  findings: 'findings',
  notes: 'notes',
}

/** The counts beside the navigation, which a delta does move. */
export function navCounts(links, counts) {
  for (const one of links) {
    if (one.counts === null) continue
    const n = counts[one.counts] ?? 0
    textIn(one.figure, count(n))
    one.figure.setAttribute('aria-label', `${n} ${NOUNS[one.counts] ?? one.counts}`)
  }
}

/**
 * The freshness line, and the bar under it when there is something to say.
 *
 * The time is **the server's own**, out of the snapshot; the device's clock is
 * read only for the parenthesis, so a phone with a wrong clock shows an odd age
 * rather than a wrong time.
 */
export function freshIn(shown, standing, connection, store, now) {
  const mark = freshMark(standing)
  // At 360px the seconds are what gets cut off the end of the line, and the
  // line is the most important thing on the page. The minute is enough there;
  // the second is worth having where there is room for it.
  const tight = globalThis.matchMedia?.('(max-width: 479px)').matches === true
  const clock = tight ? shortClockOf : clockOf
  const at = store.fresh === null ? '—' : clock(store.fresh.at)
  const said = partsOf(standing, connection, at, now, tight)
  textIn(shown.freshSaid, said.words)
  textIn(shown.dot, said.glyph)
  toneOn(shown.dot, mark.tone)
  shown.freshSaid.setAttribute('aria-label', `${mark.word}. ${said.words}`)
}

/**
 * The bars: one per thing the page has to say about itself, and never more than
 * one of a kind.
 *
 * Rebuilt only when the set of them changes, because a bar that was replaced on
 * every beat would take the retry button out from under a thumb.
 */
export function barsIn(shown, said) {
  const want = said.map((one) => one.key).join('|')
  if (shown.barsAre === want) {
    // The same bars, so only their words are written — a bar rebuilt on every
    // beat would take the retry button out from under a thumb mid-press.
    for (let at = 0; at < said.length; at += 1) {
      const node = shown.bars.children[at]
      if (node !== undefined) textIn(node.children[2], said[at].under ?? '')
    }
    return
  }
  shown.barsAre = want
  shown.bars.textContent = ''
  for (const one of said) {
    const node = el('div', { class: `bar ${one.tone ?? ''}`, attrs: { 'data-bar': one.key } })
    into(
      node,
      el('span', { class: 'glyph', text: one.glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'lead', text: one.lead }),
      el('span', { class: 'under', text: one.under ?? '' }),
    )
    if (one.press !== undefined) {
      const press = el('button', {
        class: 'press quietly',
        text: one.press.said,
        attrs: { type: 'button' },
      })
      press.addEventListener('click', one.press.does)
      into(node, press)
    }
    shown.bars.append(node)
  }
}

/**
 * What the bars say, as a pure function of how the page stands.
 *
 * Held apart from the drawing so a test can read it: the hardest thing to get
 * right here is that an unreachable page **says when it was last true** and
 * never says that nothing is running.
 */
export function barsFor(standing, connection, store, now, tries, extra = []) {
  const said = [...extra]
  const at = store.fresh === null ? '—' : clockOf(store.fresh.at)
  if (standing === 'reconnecting') {
    said.push({
      key: 'reconnecting',
      tone: 'is-stale',
      glyph: '◴',
      lead: 'Reconnecting.',
      under: `Nothing here is newer than ${at}. Trying again in ${duration(backoffAt(tries))}.`,
    })
  }
  if (standing === 'unreachable') {
    said.push({
      key: 'unreachable',
      tone: 'is-gone',
      glyph: '○',
      lead: `Unreachable since ${at}.`,
      // The sentence this bar exists for. Nothing here is nought, empty or
      // stopped: what is on screen is the last thing that was known to be
      // true, and it could not be asked again.
      under:
        'The machine may be asleep, or Tade may be closed. What is below is the last thing this device was told — not what is happening now.',
    })
  }
  if (standing === 'closed') {
    said.push({
      key: 'closed',
      glyph: '⏸',
      lead: connection.why,
      under: `Nothing here is newer than ${at}.`,
    })
  }
  void now
  return said
}

/** The keys, listed where `?` and the header button both reach them. */
function keySheet() {
  const list = el('dl')
  for (const [key, what] of [
    ['g n', 'Now'],
    ['g q', 'Queue'],
    ['g s', 'Spend'],
    ['g c', 'Checks'],
    ['j / k', 'move through rows'],
    ['Enter', 'open the row'],
    ['Escape', 'go back'],
    ['?', 'these keys'],
  ]) {
    into(list, el('dt', { text: key }), el('dd', { text: what }))
  }
  return list
}

/**
 * What crossed into wanting you, and what stopped — the only thing announced.
 *
 * Pure, so the wording is testable: *two tasks now want you: a, b* rather than
 * a page read aloud twice a second. Nothing is announced on the first snapshot,
 * because arriving at a page is not a change to it.
 */
export function crossing(was, is) {
  if (was === null) return ''
  const into_ = [...is].filter((id) => !was.has(id))
  const out = [...was].filter((id) => !is.has(id))
  const parts = []
  if (into_.length > 0) parts.push(`${said(into_.length)} now want you: ${into_.join(', ')}`)
  if (out.length > 0) parts.push(`${said(out.length)} stopped wanting you: ${out.join(', ')}`)
  return parts.join('. ')
}

const said = (n) => `${n} task${n === 1 ? '' : 's'}`

/** The document title, which is what a screen reader announces on navigation. */
export function titleFor(where) {
  const name = TITLES[where.view] ?? 'Tade'
  if (where.view === 'project') return `${where.project} · Tade`
  if (where.view === 'task') return `${where.task} · ${where.project} · Tade`
  return `${name} · Tade`
}

/** Whether a region should be dimmed, which is the whole of what stale looks like. */
export function heldOn(root, standing) {
  classOn(root, 'held', standing === 'unreachable' || standing === 'closed')
}
