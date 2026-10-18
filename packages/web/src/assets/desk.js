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
import { classOn, el, into, keyed, textIn, toneOn } from './dom.js'
import { followOf } from './follow.js'
import { toolNamed } from './glyphs.js'
import { icon } from './icons.js'
import { navFor } from './routes.js'
import { sideOf } from './side.js'
import { chatOf, talkOf } from './store.js'
import { composerOf, createChatLine, fillChatLine, lineMark, saidOn } from './talk.js'

export { noAgentsSaid } from './side.js'

/** How many lines of the conversation the dock shows: the exchange that just happened. */
const STRIP_LINES = 8

/** The two parts, built once, empty until the first paint fills them. */
export function deskParts(ctx) {
  const side = sideOf()

  const dock = el('section', { class: 'dock', attrs: { 'aria-labelledby': 'dock-head' } })
  const head = el('div', { class: 'dock-head' })
  const title = el('h2', { text: 'Tade', attrs: { id: 'dock-head' } })
  // What was said last, on the heading line: what a folded dock still says —
  // with its mark, so folded it still says whether that was news, an answer,
  // a call that worked or one that failed.
  const last = el('span', { class: 'dock-last' })
  const lastMark = el('span', { class: 'line-mark', attrs: { 'aria-hidden': 'true' } })
  const lastWords = el('span', { class: 'dock-last-words' })
  into(last, lastMark, lastWords)
  const whole = el('a', {
    class: 'tap icon',
    attrs: { href: '/talk', 'aria-label': 'The whole conversation' },
  })
  into(whole, icon('arrow'))
  const fold = el('button', { class: 'dock-fold dock-press', attrs: { type: 'button' } })
  into(fold, icon('chevron', 'twist'), el('span', { class: 'fold-said' }))
  into(head, icon('spark'), title, last, whole, fold)
  // It scrolls on its own, so it is a stop a keyboard can reach and scroll —
  // and it is drawn by the conversation's own renderer (`createChatLine`), so
  // the dock and the whole conversation are the same lines, only fewer.
  const lines = el('ul', {
    class: 'rows chat lines compact',
    attrs: { tabindex: '0', 'aria-label': 'The conversation, its last lines' },
  })
  const follow = followOf(() => lines)
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
  const jump = el('div', { class: 'dock-jump' })
  into(jump, follow.press)
  into(body, lines, jump, quiet, composer)
  into(dock, head, body)

  return {
    side: side.node,
    dock,
    fold,
    update(view) {
      side.update(view)
      dockIn({ node: dock, lines, quiet, last, lastMark, lastWords }, view)
      typing.update(talkOf(view.store), view)
      if (!dock.hidden) follow.drawn()
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
  keyed(
    made.lines,
    shown,
    (line) => line.id,
    createChatLine,
    (node, line) => fillChatLine(node, line, view),
  )
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
  const mark = end === undefined ? null : lineMark(end)
  textIn(made.lastMark, mark?.glyph ?? '')
  toneOn(made.lastMark, mark?.tone ?? '')
  made.lastMark.hidden = mark === null
  for (const kind of ['asked', 'reply', 'tool', 'tade', 'problem', 'none']) {
    classOn(made.last, `is-${kind}`, (end?.kind ?? 'none') === kind)
  }
  textIn(made.lastWords, end === undefined ? said : lastSaid(end))
}

/** The last line in a few words: a tool's name and what it was given, or the words. */
function lastSaid(line) {
  if (line.kind !== 'tool') return saidOn(line)
  const brief = line.call?.brief ?? ''
  return [toolNamed(line.tool), brief].filter((one) => one !== '').join(' · ')
}
