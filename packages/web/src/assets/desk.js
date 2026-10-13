// The control room's frame, in type: the window's own parts.
//
// The window has the work down one side, an agent's screen in the middle and
// the orchestrator in a strip at its foot. A page has the same three, and one
// more the window keeps along its top and its footer — the places. So the
// frame here is the menu on the left (`shell.js`), the work on the right
// (`side.js`: a project at a time, its agents and its queue as a tree), and
// **Tade at the foot of the middle**, under whatever screen is open, the way
// the strip sits under the window's pane. **Nothing in them is new
// information**: the side is the same rows the screens draw, and the dock is
// the last lines of the conversation and the same box the conversation screen
// has (`composerOf`). The one way anything here says something to the work is
// through Tade, which is narrowed to what this device was granted at the
// machine.
//
// Each of the three folds (`docks.js`), and below a desk's width the side is a
// drawer and on a phone Tade is a sheet: one press away, never gone.
//
// **Built once and patched**, like every screen: a part is filled on every
// paint and rebuilt never, so focus and a half-typed message survive a delta.

import { mayFor } from './access.js'
import { el, into, keyed, textIn, toneOn } from './dom.js'
import { CHAT_KINDS } from './glyphs.js'
import { icon } from './icons.js'
import { navFor } from './routes.js'
import { sideOf } from './side.js'
import { chatOf, talkOf } from './store.js'
import { composerOf, saidOn, whoSaid } from './talk.js'

export { noAgentsSaid } from './side.js'

/** How many lines of the conversation the dock shows: the exchange that just happened. */
const STRIP_LINES = 8

/** The two parts, built once, empty until the first paint fills them. */
export function deskParts(ctx) {
  const side = sideOf()

  const dock = el('section', { class: 'dock', attrs: { 'aria-labelledby': 'dock-head' } })
  const head = el('div', { class: 'dock-head' })
  const title = el('h2', { text: 'Tade', attrs: { id: 'dock-head' } })
  // What was said last, on the heading line: what a folded dock still says.
  const last = el('span', { class: 'dock-last' })
  const whole = el('a', {
    class: 'tap icon',
    attrs: { href: '/talk', 'aria-label': 'The whole conversation' },
  })
  into(whole, icon('arrow'))
  const fold = el('button', { class: 'dock-fold dock-press', attrs: { type: 'button' } })
  into(fold, icon('chevron', 'twist'), el('span', { class: 'fold-said' }))
  into(head, icon('spark'), title, last, whole, fold)
  // It scrolls on its own, so it is a stop a keyboard can reach and scroll.
  const lines = el('ul', {
    class: 'lines',
    attrs: { tabindex: '0', 'aria-label': 'The conversation, its last lines' },
  })
  const quiet = el('p', { class: 'empty nothing' })
  const typing = composerOf(ctx, {
    label: 'what to ask Tade',
    placeholder: 'Ask Tade…',
    send: 'Ask',
    rows: '1',
  })
  const composer = el('div', { class: 'composer' })
  into(composer, ...typing.nodes)
  const body = el('div', { class: 'dock-body' })
  into(body, lines, quiet, composer)
  into(dock, head, body)

  return {
    side: side.node,
    dock,
    fold,
    update(view) {
      side.update(view)
      dockIn({ node: dock, lines, quiet, last }, view)
      typing.update(talkOf(view.store))
    },
  }
}

/**
 * The last few lines, or why there are none, and the box.
 *
 * **Not drawn on the conversation's own screen**, which has the whole of it
 * and the same box: two boxes for one message on one page is one too many.
 */
function dockIn(made, view) {
  const there = navFor(view.where) === 'talk'
  made.node.hidden = there
  if (there) return
  const may = mayFor(view.store, 'chat')
  const talk = talkOf(view.store)
  const shown = may ? chatOf(view.store).slice(-STRIP_LINES) : []
  keyed(made.lines, shown, (line) => line.id, createLine, fillLine)
  // **The absences, each in its own words**, as the conversation screen has
  // them. A surface that is off is the composer's to say (`reasonFor`), once,
  // under where the box would be; what is left here is this device not being
  // granted the lines, or nothing having been said.
  const said =
    (talk ?? null) === null
      ? ''
      : !may
        ? 'Not granted'
        : shown.length === 0
          ? 'Nothing said yet'
          : ''
  textIn(made.quiet, said)
  made.quiet.hidden = said === ''
  const end = shown.at(-1)
  textIn(made.last, end === undefined ? said : saidOn(end))
}

/**
 * One line of the conversation: who, and the words.
 *
 * Clamped rather than whole, because the dock sits under the work and a reply
 * that grew it would push the work off the screen. The whole of every line is
 * one link away, on the conversation's own screen; the cut is the
 * stylesheet's, so nothing here shortens anybody's words.
 */
function createLine() {
  const node = el('li')
  into(node, el('span', { class: 'who' }), el('span', { class: 'words' }))
  return node
}

function fillLine(node, line) {
  const [who, words] = node.children
  const kind = CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
  textIn(who, [whoSaid(line), kind.word, line.tool].filter((one) => one).join(' · '))
  toneOn(who, kind.tone)
  textIn(words, saidOn(line))
}
