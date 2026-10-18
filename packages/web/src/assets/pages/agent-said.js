// One agent's conversation, on its own page: what it was told, what it said,
// and every tool it reached for as a row that opens onto the call — drawn as
// the conversation with Tade is (`../conversation.js`), so the two read alike.
//
// **What is here is its harness's own record, read at the machine** while this
// page asks (`agent-pane.js`, `web-lanes.ts`), cleaned there as its screen is,
// and only for a device granted its screen. It is nobody's words: drawn as
// markdown by a reader that builds nodes and never markup, and a call as text.
//
// **Asked every two seconds, sent only when it moved** — the pane says which
// revision it holds (`?seen=`), and the machine answers that one with no turns.

import { CALL_STATES, callIn, callRow, wordsIn } from '../conversation.js'
import { classOn, el, into, keyed, textIn, toneOn } from '../dom.js'
import { ageSaid } from '../figures.js'
import { followOf } from '../follow.js'
import { section } from '../rows.js'
import { stateBox, stateBoxIn } from '../ui.js'
import { stateOf } from './agent-shape.js'

/**
 * Who a turn is from: its mark, in the conversation with Tade's own marks
 * (`CHAT_KINDS`) — `❯` what it was told, bright, and `◆` what it said — and
 * its word.
 */
const TURN_HEADS = {
  sent: { glyph: '❯', word: 'told it', tone: '' },
  reply: { glyph: '◆', word: 'it said', tone: 't-working' },
}

/**
 * Why there is no conversation, as a heading and what to do about it.
 *
 * One per word of `CONVERSATION_WHY`, held equal to it by
 * `test/agents-client.test.ts`: each is a different thing to do next.
 */
export const UNREAD_SAID = {
  'not granted': ['Conversation not granted', 'Grant its screen at the machine'],
  'not read yet': ['Reading its conversation…', null],
  'could not read': [
    'Couldn’t read its conversation',
    'Its harness’s record is there and could not be read',
  ],
}

/** How long something it was told may run before it is folded under a press. */
export const FOLD_AT = 600

export function conversationView() {
  const made = section('CONVERSATION')
  made.node.id = 'ag-said'
  const why = stateBox()
  // **Read as a chat**, in a region of its own on a page with more on it:
  // opened at its newest turn, kept there while it is followed, let go the
  // moment somebody scrolls up in it, and one press to come back down.
  const list = el('ul', {
    class: 'rows chat ag-said',
    attrs: { tabindex: '0', 'aria-label': 'Its conversation' },
  })
  const follow = followOf(() => list)
  const jump = el('div', { class: 'ag-said-jump' })
  into(jump, follow.press)
  const foot = el('p', { class: 'unknown' })
  into(made.body, why, list, jump, foot)

  return {
    node: made.node,
    /** `heard` is the pane's: the last answer, whose conversation is the newest one held. */
    update(heard, view) {
      const answer = heard.answer
      const talk = answer?.conversation ?? null
      const turns = talk?.turns ?? []
      textIn(made.figure, turns.length === 0 ? '' : String(turns.length))
      if (answer === null) {
        stateBoxIn(why, null)
      } else if (talk === null) {
        const [title, line] = UNREAD_SAID[answer.unread] ?? UNREAD_SAID['could not read']
        stateBoxIn(
          why,
          stateOf(answer.unread === 'could not read' ? 'error' : 'empty', title, line, 'agents'),
        )
      } else {
        stateBoxIn(why, turns.length === 0 ? stateOf('empty', 'Nothing said yet', null) : null)
      }
      keyed(
        list,
        turns,
        (turn) => turn.id,
        createTurn,
        (node, turn) => fillTurn(node, turn, view),
      )
      if (turns.length > 0) follow.drawn()
      const parts = []
      if (talk?.earlier === true) parts.push('earlier turns are not on this page')
      if ((talk?.taken ?? 0) > 0) parts.push(`${talk.taken} taken out`)
      textIn(foot, parts.join(' · '))
      foot.hidden = parts.length === 0
    },
  }
}

function createTurn() {
  const node = el('li', { class: 'line' })
  const fold = el('button', {
    class: 'more',
    text: 'Show all',
    attrs: { type: 'button', 'aria-expanded': 'false' },
  })
  const words = el('div')
  fold.addEventListener('click', () => {
    const open = words.classList.toggle('ag-said-open')
    fold.setAttribute('aria-expanded', open ? 'true' : 'false')
    textIn(fold, open ? 'Show less' : 'Show all')
  })
  const mark = el('span', { class: 'line-mark' })
  into(mark, el('span', { attrs: { 'aria-hidden': 'true' } }), el('span', { class: 'sr-only' }))
  const body = el('div', { class: 'line-body' })
  into(
    body,
    el('p', { class: 'aside' }),
    words,
    fold,
    el('p', { class: 'unknown', text: 'more than this was written down' }),
    callRow(),
  )
  into(node, mark, body)
  return node
}

/**
 * One turn: its mark and when beside its words, or one row for a tool. What it
 * was told is folded past `FOLD_AT`, because Tade's opening is long and the
 * page is for what it is doing.
 */
function fillTurn(node, turn, view) {
  const [mark, body] = node.children
  const [glyph, word] = mark.children
  const [head, words, fold, cut, call] = body.children
  const tool = turn.kind === 'tool'
  const kind = TURN_HEADS[turn.kind] ?? TURN_HEADS.reply
  const drawn = tool ? (CALL_STATES[turn.outcome] ?? CALL_STATES.none) : kind
  textIn(glyph, drawn.glyph)
  textIn(word, tool ? '' : ` ${kind.word}`)
  toneOn(mark, drawn.tone)
  const age = turn.at === null ? null : ageSaid(turn.at, view.asOf, view.frozen)
  // When, over what it was told: the start of each exchange.
  textIn(
    head,
    turn.kind === 'sent'
      ? [kind.word, age].filter((one) => one !== null && one !== '').join(' · ')
      : '',
  )
  head.hidden = turn.kind !== 'sent'
  call.hidden = !tool
  if (tool) {
    words.hidden = true
    callIn(call, turn)
  } else {
    wordsIn(words, turn.text, true)
  }
  const long = !tool && turn.kind === 'sent' && (turn.text?.words.length ?? 0) > FOLD_AT
  classOn(words, 'ag-said-long', long)
  fold.hidden = !long
  cut.hidden = tool || turn.text?.more !== true
  classOn(node, 'is-asked', turn.kind === 'sent')
  classOn(node, 'is-reply', turn.kind === 'reply')
  classOn(node, 'is-tool', tool)
  classOn(node, 'is-failed', tool && turn.outcome === 'failed')
}
