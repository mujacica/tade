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

import { CALL_STATES, callIn, callRow, readFrom, wordsIn } from '../conversation.js'
import { classOn, el, into, keyed, textIn, toneOn } from '../dom.js'
import { linesKept, readBack } from '../earlier.js'
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
  // **Every turn it was sent, oldest first** (`linesKept`): the newest page of
  // its record moves on as it works, and what was read further back stays
  // above it with nothing between.
  const kept = linesKept()
  /** Where the turns before the oldest held end in its record; null at its beginning. */
  let before = null
  /** Whether any turns arrived yet: the first answer's cursor is where reading back starts. */
  let started = false
  let task = null
  let seen = null
  /** How many things cleaning took out of the newest turns, as their last answer said. */
  let taken = 0
  // **The whole of it can be read here**: scrolled up near the top of its
  // region, the turns before are read out of its record and put above, and
  // the view stays on what the reader was reading.
  const back = readBack(
    () => list,
    async (keep) => {
      if (before === null || task === null) return 'none'
      const got = await readFrom(
        `/api/agent/${agentPath(task)}/earlier?before=${encodeURIComponent(before)}`,
      )
      if (got.status !== 200 || got.body === null || got.body.v !== 1) return 'failed'
      if (got.body.why !== null) return got.body.why === 'unread' ? 'failed' : 'none'
      keep(() => {
        kept.older(got.body.turns)
        before = got.body.before
        draw()
      })
      return before === null ? 'none' : 'read'
    },
  )
  const jump = el('div', { class: 'ag-said-jump' })
  into(jump, follow.press)
  const foot = el('p', { class: 'unknown' })
  into(made.body, why, back.node, list, jump, foot)

  function draw() {
    if (seen === null) return
    const view = seen
    const turns = kept.all()
    textIn(made.figure, turns.length === 0 ? '' : String(turns.length))
    keyed(
      list,
      turns,
      (turn) => turn.id,
      createTurn,
      (node, turn) => fillTurn(node, turn, view, task),
    )
    back.more(before !== null && turns.length > 0)
  }

  return {
    node: made.node,
    leave: () => {
      follow.leave()
      back.leave()
    },
    /** `heard` is the pane's: the last answer, whose conversation is the newest one held. */
    update(heard, view) {
      const answer = heard.answer
      const talk = answer?.conversation ?? null
      const turns = talk?.turns ?? []
      seen = view
      task = answer?.task ?? null
      if (talk !== null && turns.length > 0 && !started) {
        started = true
        before = talk.before ?? null
      }
      kept.newer(turns)
      if (answer === null) {
        stateBoxIn(why, null)
      } else if (talk === null && kept.size === 0) {
        const [title, line] = UNREAD_SAID[answer.unread] ?? UNREAD_SAID['could not read']
        stateBoxIn(
          why,
          stateOf(answer.unread === 'could not read' ? 'error' : 'empty', title, line, 'agents'),
        )
      } else {
        stateBoxIn(why, kept.size === 0 ? stateOf('empty', 'Nothing said yet', null) : null)
      }
      draw()
      if (kept.size > 0) {
        follow.drawn()
        back.drawn()
      }
      if (talk !== null && talk.turns !== null) taken = talk.taken ?? 0
      textIn(foot, taken > 0 ? `${taken} taken out` : '')
      foot.hidden = taken === 0
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
  into(body, el('p', { class: 'aside' }), words, fold, callRow())
  into(node, mark, body)
  return node
}

/**
 * One turn: its mark and when beside its words, or one row for a tool. What it
 * was told is folded past `FOLD_AT`, because Tade's opening is long and the
 * page is for what it is doing.
 */
function fillTurn(node, turn, view, task) {
  const [mark, body] = node.children
  const [glyph, word] = mark.children
  const [head, words, fold, call] = body.children
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
    // Its whole answer is asked for under the agent it is one of, when opened.
    callIn(call, turn, task === null ? null : `/api/agent/${agentPath(task)}/answer`)
  } else {
    wordsIn(words, turn.text, true)
  }
  const long = !tool && turn.kind === 'sent' && (turn.text?.words.length ?? 0) > FOLD_AT
  classOn(words, 'ag-said-long', long)
  fold.hidden = !long
  classOn(node, 'is-asked', turn.kind === 'sent')
  classOn(node, 'is-reply', turn.kind === 'reply')
  classOn(node, 'is-tool', tool)
  classOn(node, 'is-failed', tool && turn.outcome === 'failed')
}

/** `project/task` as two segments of a path, each encoded. */
function agentPath(task) {
  const [project = '', ...rest] = task.split('/')
  return `${encodeURIComponent(project)}/${encodeURIComponent(rest.join('/'))}`
}
