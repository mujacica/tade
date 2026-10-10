import { afterAnswer, askBody, stopBody } from './acts.js'
import { el, empty, into, keyed, proseOf, textIn, toneOn } from './dom.js'
import { ageSaid } from './figures.js'
import { CHAT_KINDS } from './glyphs.js'
import { nothingSaid } from './pages.js'
import { section } from './rows.js'
import { keyOf } from './screens.js'
import { chatOf, omitted, talkOf } from './store.js'

// The conversation with Tade, and the one box on this page that sends words.
//
// **Its own file**, because it is the one screen that is not a list of rows
// about work: it is an exchange, read from the bottom, with a composer under
// it. `pages.js` was at the size a file is allowed to be and the seam is
// honest rather than convenient.
//
// The five rules that break this screen quietly:
//
// - **A reply is text and never markup.** `proseOf` sets `textContent`, like
//   every other authored string on this page: there is no Markdown renderer
//   here and no `innerHTML` anywhere, and that is what actually stands against
//   a reply quoting an injected `<script>` out of something an agent read.
// - **What was typed survives everything but a `200`.** A `409` is the world
//   having moved — Tade started answering somebody else — and throwing away
//   the paragraph somebody typed on a phone because of it is the one failure
//   they cannot undo. It is also why the box is never rebuilt on a delta: the
//   screen is built once and patched (`keyed`), so focus, a half-made
//   selection and a half-typed message all survive a frame.
// - **The composer is absent where it could not be used**, with its reason.
//   Three different absences and three different sentences: this surface is
//   not turned on, this device was not granted it, or Tade is answering
//   somebody else. A disabled box invites a paragraph and then refuses it.
// - **Tade's own words, never this page's.** What came of a press is the
//   answer's `said`; what the conversation says is the projection's. There is
//   no sentence here about what Tade is doing.
// - **The line that says who asked is not decoration.** A request from a
//   paired device that read as something the person typed would be the `said`
//   confusion in the one place somebody actually reads the words.

/** How long a message may be, which is `ASK_BOUND` said on this side. */
const BOUND = 4000

export function talkScreen(ctx) {
  const node = el('div')
  const made = section('WITH TADE', { top: true })
  const list = el('ul', { class: 'rows' })
  const none = empty('nothing said yet')
  into(made.body, list, none)
  const older = el('p', { class: 'unknown' })

  const composer = section('SAY SOMETHING')
  const why = el('p', { class: 'empty' })
  const box = el('textarea', {
    attrs: {
      rows: '3',
      maxlength: String(BOUND),
      placeholder: 'ask Tade something',
      'aria-label': 'what to say to Tade',
    },
  })
  const press = el('button', { class: 'press quietly', text: 'Send' })
  const stop = el('button', { class: 'press quietly', text: 'Stop it' })
  const presses = el('div', { class: 'presses' })
  const said = el('p', { attrs: { role: 'status' } })
  into(presses, press, stop)
  into(composer.body, why, box, presses, said)
  into(node, made.node, older, composer.node)

  let talk = null
  let going = false

  /** One press, and the answer is the only thing that clears the box. */
  const send = async (what, body) => {
    if (going || talk === null) return
    going = true
    press.disabled = true
    stop.disabled = true
    const answer = await ctx.ask('POST', `/api/ask/${what}`, body)
    going = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    textIn(said, came.said)
    if (came.clear && what === 'ask') box.value = ''
    settle()
  }

  /**
   * What the two controls and the box are, given what is true now.
   *
   * One function for all three, so a screen cannot turn the box on and leave
   * the reason beside it from the last frame.
   */
  const settle = () => {
    const mine = talk !== null && talk.mine === true
    const busy = talk !== null && talk.busy === true
    press.hidden = !mine || busy
    stop.hidden = !mine || !busy
    box.hidden = !mine || busy
    press.disabled = going
    stop.disabled = going
    textIn(why, reasonFor(talk))
    why.hidden = reasonFor(talk) === ''
  }

  press.addEventListener('click', () => {
    if (talk === null || box.value.trim() === '') return
    void send('ask', askBody(talk, keyOf(), ctx.revOf(), box.value))
  })
  stop.addEventListener('click', () => {
    if (talk === null) return
    void send('stop', stopBody(talk, keyOf(), ctx.revOf()))
  })

  return {
    node,
    update(view) {
      talk = talkOf(view.store)
      const lines = chatOf(view.store)
      textIn(made.figure, lines.length === 0 ? '' : String(lines.length))
      none.hidden = lines.length > 0
      textIn(none, nothingSaid(view.may.talk, omitted(view.store, 'chat'), 'nothing said yet'))
      keyed(
        list,
        lines,
        (line) => line.id,
        createChatLine,
        (one, line) => fillChatLine(one, line, view),
      )
      const left = omitted(view.store, 'chat')
      const more = left > 0 && view.may.talk === true
      textIn(older, more ? `${left} earlier lines are not on this page` : '')
      older.hidden = !more
      settle()
    },
  }
}

/**
 * Why there is no box, in words — or empty where there is one.
 *
 * **Three absences and three sentences**, because the thing to do about each is
 * different: turn a setting on at the machine, be granted it at the machine, or
 * wait. A page that said *you cannot do that* to all three would send somebody
 * to the wrong place twice out of three times.
 */
export function reasonFor(talk) {
  if (talk === null || talk === undefined) {
    return 'Talking to Tade is not turned on for this machine. It is a setting in the window, beside the one that let this device in.'
  }
  if (talk.mine !== true) {
    return 'This device was not granted talking to Tade. That needs the person at the machine: it is a control in the away panel, beside the one that lets a device act.'
  }
  if (talk.busy === true) {
    return talk.whose === 'you'
      ? 'Tade is answering the person at the machine.'
      : `Tade is answering ${talk.whose ?? 'something'}.`
  }
  return ''
}

export function createChatLine() {
  const node = el('li')
  const head = el('p', { class: 'aside' })
  into(node, head)
  return node
}

/**
 * One line: who, when, and the words.
 *
 * The words are written **every** time rather than once, which is the one
 * difference from a note: a reply arrives in pieces, so the row it is in is
 * patched as it streams. Everything else about the row is stable, so the
 * `aside` is the only other thing touched.
 */
export function fillChatLine(node, line, view) {
  const [head] = node.children
  const kind = CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
  const age = ageSaid(line.at, view.asOf, view.frozen)
  textIn(
    head,
    [whoSaid(line), kind.word, line.tool, age === null ? '' : age]
      .filter((one) => one !== '' && one !== null && one !== undefined)
      .join(' · '),
  )
  toneOn(head, kind.tone)
  if (node.children.length === 1) into(node, proseOf(''))
  const body = node.children[1]
  if (body !== undefined) textIn(body, saidOn(line))
}

/**
 * Who said it, in the words the record uses.
 *
 * `you` is the person at the machine and a device is its id — the same id the
 * journal writes and the device list shows, so a line on a phone joins up with
 * both. Empty for Tade's own lines and the model's, where the kind's own word
 * already says it.
 */
export function whoSaid(line) {
  if (line.from === null || line.from === undefined || line.from === '') return ''
  return line.from === 'you' ? 'you, at the machine' : line.from
}

/**
 * The words on a line, or Tade's own clause where there are none.
 *
 * A tool line has no words by construction: what crossed is the name and the
 * outcome, because its arguments are the call itself. So the clause says what
 * happened rather than leaving the row blank, which would read as a reply that
 * failed to load.
 */
export function saidOn(line) {
  if (line.text !== null && line.text !== undefined) {
    return line.text.words + (line.text.more === true ? ' …' : '')
  }
  if (line.kind === 'tool') {
    return line.outcome === 'running' ? 'still going' : ''
  }
  return ''
}
