// The frame the overview is drawn inside: the wordmark, the switch to the full
// view, each machine's up or down, the freshness clock, the bars that say how
// the page stands to the machine, and the region a screen reader is told
// about.
//
// **The freshness line is the most important thing on the page**, and this is
// why: when the stream drops, every row keeps its last state and the page gains
// one bar. No row changes glyph, no count changes, nothing becomes nought.
// *Unreachable is never stopped* — a sleeping laptop runs nothing, and a page
// that drew `0 working` because it could not ask would be lying about
// somebody's morning.
//
// **There is no navigation.** The page has one screen (§10 T5 of the Duo
// plan): everything else Tade shows is a panel of the window, one press away
// in the full view, so a menu here would be a second way to the same places.
//
// **One `aria-live` region, and it announces only what crossed into wanting
// you and what stopped.** Announcing the snapshot would read the whole page
// aloud every two seconds, which is worse than announcing nothing.

import { classOn, el, hintOf, into, keyed, textIn, toneOn } from './dom.js'
import { clockOf, duration, shortClockOf } from './figures.js'
import { freshMark } from './glyphs.js'
import { icon, wordmark } from './icons.js'
import { backoffAt, partsOf } from './live.js'
import { machinesUpOf } from './machines.js'
import { TITLES } from './routes.js'
import { modeSwitch } from './switch.js'

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
  const brand = el('a', { class: 'brand', attrs: { href: '/', 'aria-label': 'Tade, overview' } })
  into(brand, wordmark())
  // Overview and Full view (`switch.js`): drawn once the machine has said it
  // draws a window to share (`boot.js`), and not before — a switch to a view
  // that cannot load is a press that goes nowhere.
  const modes = modeSwitch('overview')
  modes.hidden = true
  // Each machine, up or not, as a dot and its name: the machine this page
  // talks to and every other one it has seen (`machinesUpOf`).
  const machines = el('ul', { class: 'machines', attrs: { 'aria-label': 'Machines' } })
  const fresh = el('p', { class: 'fresh', attrs: { role: 'status' } })
  const dot = el('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } })
  const freshSaid = el('span', { class: 'fresh-said' })
  into(fresh, dot, freshSaid)
  const again = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Ask the machine again' },
  })
  into(again, icon('refresh'))
  into(top, brand, modes, machines, fresh, again)

  const bars = el('div', { class: 'bars' })
  const main = el('main', { attrs: { id: 'main' } })
  const frame = el('div', { class: 'frame' })
  into(frame, bars, main)

  const announce = el('p', {
    class: 'sr-only',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  })

  return {
    parts: [skip, top, frame, announce],
    // What only a device with a session is drawn (`insideIn`).
    inside: [again, machines],
    frame,
    main,
    bars,
    dot,
    freshSaid,
    announce,
    again,
    modes,
    machines,
  }
}

/**
 * Each machine's up or down in the header, as `machinesUpOf` says it: a dot
 * in its tone and its name, and what it is in a word or two when it is not up
 * — a colour is never the only word — with the whole sentence as its label. `live` is whether this page hears the machine it talks
 * to, which is the one row nothing on the snapshot can say.
 */
export function machinesIn(shown, store, live) {
  const rows = machinesUpOf(store, live)
  // One machine and it up is the freshness line's to say; a strip of one dot is noise.
  shown.machines.hidden = rows.length < 2
  keyed(shown.machines, rows, (one) => one.key, createMachine, fillMachine)
}

function createMachine() {
  const node = el('li', { class: 'machine' })
  into(
    node,
    el('span', { class: 'glyph', text: '●', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'machine-name' }),
    el('span', { class: 'machine-said' }),
  )
  return node
}

function fillMachine(node, one) {
  const [dot, name, said] = node.children
  toneOn(dot, one.tone)
  textIn(name, one.name)
  textIn(said, one.up ? '' : one.short)
  said.hidden = one.up
  node.setAttribute('aria-label', `${one.name}, ${one.said}`)
  classOn(node, 'is-down', !one.up)
}

/** The screen for a path this page does not know: an old bookmark of a page that went. */
export function nowhereScreen() {
  const node = el('div', { class: 'column' })
  into(
    node,
    el('h1', { text: 'Not found' }),
    el('p', {
      text: 'Everything but the overview is in the full view now, as a panel of the window.',
    }),
    el('a', { class: 'press', text: 'Overview', attrs: { href: '/' } }),
  )
  return { node, update() {} }
}

/**
 * The machines and the retry, drawn only for a device with a session.
 *
 * Without one the page is the pairing screen or the last view it kept, and
 * nothing around it may say otherwise: a machine drawn up, or a retry, would
 * each be a claim about a machine this page never asked — and together they
 * read as a broken connection rather than *pair first*.
 */
export function insideIn(shown, inside) {
  for (const part of shown.inside) if (!inside) part.hidden = true
  shown.again.hidden = !inside
  shown.frame?.classList.toggle('is-outside', !inside)
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
 * **One line each**: a glyph, the lead in a few words, and — where there is
 * more to say — a `?` that opens the rest under it. The sentence is still
 * there for whoever asks; it is no longer a paragraph across the top of every
 * screen for whoever did not.
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
      const under = node?.querySelector('.under')
      if (under !== null && under !== undefined) textIn(under, said[at].under ?? '')
      const lead = node?.querySelector('.lead')
      if (lead !== null && lead !== undefined) textIn(lead, said[at].lead)
    }
    return
  }
  shown.barsAre = want
  shown.bars.textContent = ''
  for (const one of said) {
    const node = el('div', { class: `bar ${one.tone ?? ''}`, attrs: { 'data-bar': one.key } })
    const line = el('div', { class: 'bar-line' })
    into(
      line,
      el('span', { class: 'glyph', text: one.glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'lead', text: one.lead }),
    )
    const hint = (one.under ?? '') === '' ? null : hintOf(one.under, 'under')
    if (hint !== null) into(line, hint.press)
    if (one.press !== undefined) {
      const press = el('button', {
        class: 'press quietly small',
        text: one.press.said,
        attrs: { type: 'button' },
      })
      press.addEventListener('click', one.press.does)
      into(line, press)
    }
    into(node, line, hint?.body)
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

/** How long before a session ends the page starts saying so. */
export const ENDING_WARNS_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The bar for a session about to run out, or null — pure, so a test holds it.
 *
 * A phone that is signed out in the middle of a trip, with nothing having
 * said so, is a phone somebody has to walk back to the machine for. Three
 * days ahead, a bar with the time left; past the end, nothing, because the
 * next read answers `401` and the page is the pairing screen anyway.
 */
export function endingBar(until, now) {
  const ends = typeof until === 'string' ? Date.parse(until) : Number.NaN
  if (Number.isNaN(ends) || ends <= now || ends - now > ENDING_WARNS_MS) return null
  return {
    key: 'ending',
    tone: 'is-stale',
    glyph: '◷',
    lead: `Signs out in ${duration(ends - now)}`,
    under: 'Pair this device again at the machine before then to carry on without a gap.',
  }
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
  return `${TITLES[where.view] ?? 'Tade'} · Tade`
}

/** Whether a region should be dimmed, which is the whole of what stale looks like. */
export function heldOn(root, standing) {
  classOn(root, 'held', standing === 'unreachable' || standing === 'closed')
}
