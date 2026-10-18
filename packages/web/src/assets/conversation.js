// A conversation's lines drawn as one: the words as markdown, and a tool call as
// a compact row that opens onto what it was handed and what it answered. The
// conversation with Tade (`talk.js`) and an agent's (`pages/agent-said.js`)
// both draw with this, so the two read alike.
//
// **What is drawn here is nobody's words.** A reply, a call's arguments and a
// tool's answer are text a model or a tool wrote, cleaned at the machine
// (`@tade/web`'s `cleanText`) and never trusted here: words go through
// `markdown.js`, which builds nodes and never markup, and a call's arguments
// and answer are one text node each in a `<pre>` — drawn as they came, with
// the `…` the machine left where it took something out.
//
// **A row that opens is a real button with its own words**: the tool's name,
// the line that says which call it was, and how it went — so a screen reader,
// a voice control and a thumb all reach it by what it shows, and
// `aria-expanded` says whether it is open. One the device was not granted the
// call of, or one with nothing written down, is the same row with nothing to
// open, and so is not a button.

import { classOn, el, into, textIn, toneOn } from './dom.js'
import { toolNamed } from './glyphs.js'
import { markdownIn } from './markdown.js'

/**
 * How a call went, as its glyph, its word and its tone — never colour alone,
 * and **the window's own marks** (`transcript-view.ts`): `✓` green for one that
 * worked, `✗` red for one that failed, `·` for one whose record does not say,
 * and the spinner while it is going (the glyph is its text alternative; the
 * stylesheet draws it turning, `is-spinning`).
 */
export const CALL_STATES = {
  running: { glyph: '◌', word: 'still going', tone: 't-working' },
  ok: { glyph: '✓', word: '', tone: 't-done' },
  failed: { glyph: '✗', word: 'failed', tone: 't-failed' },
  none: { glyph: '◌', word: 'no answer', tone: 't-quiet' },
  // It answered, in a record that does not say whether it worked: never ok.
  unknown: { glyph: '·', word: 'cannot tell', tone: 't-quiet' },
}

let calls = 0

/**
 * Words into a bubble: as markdown where they are a model's or an agent's,
 * and as they were typed where they are a person's — whose own `*` and `#`
 * are theirs to have meant literally.
 */
export function wordsIn(node, said, markdown) {
  const words = said === null || said === undefined ? '' : said.words
  node.hidden = words === ''
  classOn(node, 'ui-md', markdown)
  classOn(node, 'said', true)
  if (markdown) markdownIn(node, words)
  else textIn(node, words)
}

/** An empty call row: the press, and what it opens onto. */
export function callRow() {
  calls += 1
  const id = `call${calls}`
  const node = el('div', { class: 'ui-call' })
  const press = el('button', {
    class: 'ui-call-press',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': id },
  })
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const name = el('span', { class: 'ui-call-name' })
  const brief = el('span', { class: 'ui-call-brief' })
  const state = el('span', { class: 'ui-call-state' })
  into(press, glyph, name, brief, state)
  // The same row with nothing to open: the same four parts, as text.
  const still = el('div', { class: 'ui-call-press is-still' })
  into(
    still,
    el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'ui-call-name' }),
    el('span', { class: 'ui-call-brief' }),
    el('span', { class: 'ui-call-state' }),
  )
  const body = el('div', { class: 'ui-call-body', attrs: { id } })
  body.hidden = true
  press.addEventListener('click', () => {
    body.hidden = !body.hidden
    press.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
  })
  into(node, press, still, body)
  return node
}

/**
 * One call, written into a row `callRow` made: its name, the line that says
 * which, how it went, and — where there is one — the call to open.
 *
 * Patched like every row (`textIn`), so a row somebody opened stays open, and
 * what they selected in it stays selected, while the call it is about answers.
 */
export function callIn(node, one) {
  const [press, still, body] = node.children
  const state = CALL_STATES[one.outcome] ?? CALL_STATES.none
  const call = one.call ?? null
  const opens = call !== null && (call.input !== null || call.result !== null)
  press.hidden = !opens
  still.hidden = opens
  if (!opens) body.hidden = true
  for (const row of [press, still]) partsOf(row, one, state, call)
  classOn(node, 'is-failed', one.outcome === 'failed')
  if (opens) partsIn(body, call)
}

/** A row's four parts: how it went, the tool's name, what it was handed in a line, and the word. */
function partsOf(row, one, state, call) {
  const [glyph, name, brief, word] = row.children
  textIn(glyph, state.glyph)
  classOn(glyph, 'is-spinning', one.outcome === 'running')
  textIn(name, toolNamed(one.tool))
  textIn(brief, call?.brief ?? '')
  brief.hidden = (call?.brief ?? '') === ''
  textIn(word, state.word)
  word.hidden = state.word === ''
  toneOn(glyph, state.tone)
  toneOn(word, state.tone)
}

/** What a call was handed and what it answered, each under its own label. */
function partsIn(body, call) {
  if (body.children.length === 0) {
    into(
      body,
      el('p', { class: 'ui-call-label', text: 'Handed' }),
      callText('What it was handed'),
      el('p', { class: 'ui-call-label', text: 'Answered' }),
      callText('What it answered'),
      el('p', { class: 'ui-call-label' }),
    )
  }
  const [handedLabel, handed, answeredLabel, answered, none] = body.children
  fill(handedLabel, handed, call.input)
  fill(
    answeredLabel,
    answered,
    call.result === null || call.result.words === '' ? null : call.result,
  )
  textIn(none, noAnswer(call.result))
  none.hidden = noAnswer(call.result) === ''
}

/**
 * What to say where there are no words to show: a call that answered nothing
 * and one whose answer nobody kept are two different facts.
 */
function noAnswer(result) {
  if (result === null) return 'What it answered was not written down'
  return result.words === '' ? 'It answered nothing' : ''
}

function fill(label, frame, said) {
  label.hidden = said === null
  frame.hidden = said === null
  const words = said === null ? '' : said.words + (said.more ? '\n…' : '')
  textIn(frame.firstElementChild, words)
}

/**
 * A call's text: one text node in a `<pre>`, in a frame that scrolls sideways
 * on its own and is a named, focusable region so a keyboard can scroll it too.
 */
function callText(label) {
  const frame = el('div', {
    class: 'ui-call-text scrolls',
    attrs: { role: 'region', tabindex: '0', 'aria-label': label },
  })
  into(frame, el('pre'))
  return frame
}
