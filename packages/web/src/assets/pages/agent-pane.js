// One agent, looked into: what it has been doing, and what its screen shows — the
// pane on the agent's own page (`agent.js`). The list of every agent is
// `../agents.js`.
//
// **Read-only, and the absences are the point.** Nothing here writes to an
// agent: there is no box that types into a lane, no key that reaches one, and
// no route a page could use for either. What a person on a phone may say to an
// agent goes through the verbs on the task screen (`steer`, a message into a
// conversation that is already running) or through Tade (`talk.js`, and the
// strip on a desk) — both of which already exist, are gated at the machine and
// are written down under the device's id.
//
// **What its screen shows is asked for only while somebody is looking.** The
// pane asks `/api/agent/...` while its page is open and visible, every
// `EVERY_MS`, and the asking is what makes the window go on reading the lane
// (`web-lanes.ts`): a page that is navigated away from, hidden or closed stops
// asking and the window stops reading a beat or two later. Nothing about it
// rides on the stream, which every screen pays for.
//
// **The rows are an agent's bytes, so they are text and only text.** One text
// node in a `<pre>`, set through `textContent` like everything else — never
// markup, never a link, never a colour read out of an escape — and what the
// machine took out of them (`screen.ts`) is drawn as the `…` it left.
import { el, empty, into, keyed, skeleton, textIn, toneOn } from '../dom.js'
import { ageSaid, count } from '../figures.js'
import { section } from '../rows.js'
import { troubleOf, troubleSaid, UNKNOWN_TROUBLE } from '../trouble.js'

/** How often a page that is looking asks again: the window's own beat. */
const EVERY_MS = 2000

/**
 * Why there is no screen, as a sentence somebody can act on.
 *
 * One per word of `SCREEN_WHY`, held equal to it by `test/agents.test.ts`:
 * each is a different thing to do next, and one sentence for all five would be
 * the page lying four times out of five.
 */
export const WHY_SAID = {
  'not granted': 'Screen not granted — grant it at the machine',
  'no agent': 'No agent running',
  'not read yet': 'Reading the screen…',
  'could not read': 'Couldn’t read the screen — the window at the machine still shows it',
  'not here': 'Not on this device',
}

/**
 * What each kind of moment looks like: a glyph, and a tone that is never the
 * only thing saying it — the sentence beside it is Tade's own (`activitySaid`).
 */
const MOMENTS = {
  made: { glyph: '+', tone: 't-quiet' },
  state: { glyph: '◆', tone: 't-here' },
  started: { glyph: '▶', tone: 't-working' },
  stopped: { glyph: '■', tone: 't-quiet' },
  turn: { glyph: '↺', tone: 't-quiet' },
  used: { glyph: '⌸', tone: 't-quiet' },
  asked: { glyph: '?', tone: 't-wants' },
  allowed: { glyph: '✓', tone: 't-done' },
  refused: { glyph: '✕', tone: 't-failed' },
  checked: { glyph: '✓', tone: 't-quiet' },
  committed: { glyph: '●', tone: 't-working' },
  finished: { glyph: '✓', tone: 't-done' },
  told: { glyph: '✎', tone: 't-quiet' },
  failed: { glyph: '▲', tone: 't-failed' },
}

/* ── one agent, looked into ────────────────────────────────────────────────── */

/**
 * What it has been doing, and what its screen shows — for the task screen.
 *
 * Returns its two sections, an `update` the screen calls with every paint, and
 * a `leave` the router calls when somebody goes elsewhere: the one thing that
 * stops the asking, and so the reading at the machine.
 */
export function agentPane(where, ctx) {
  // **The current turn and its screen are one card**, as the window draws a
  // pane: what the agent is doing on its top line (`head`, the task screen's
  // to fill), the last rows of its screen under it, and what was left out at
  // its foot.
  const screen = section('NOW')
  const card = el('div', { class: 'ui-panel term' })
  const head = el('div', { class: 'term-head' })
  const why = el('p', { class: 'empty term-why' })
  const frame = el('div', {
    class: 'scrolls screen',
    attrs: { role: 'region', 'aria-label': 'The last rows of its screen', tabindex: '0' },
  })
  const rows = el('pre')
  into(frame, rows)
  // Before the first answer, the rows that are coming rather than a sentence.
  const coming = skeleton(8)
  coming.classList.add('term-coming')
  const facts = el('p', { class: 'aside term-foot' })
  into(card, head, why, coming, frame, facts)
  into(screen.body, card)

  const activity = section('ACTIVITY')
  const list = el('ul', { class: 'ui-timeline moments' })
  const none = empty('nothing written down about it yet')
  const more = el('p', { class: 'unknown', text: 'and more before this' })
  const waiting = skeleton(4)
  into(activity.body, waiting, list, none, more)

  const path = `/api/agent/${encodeURIComponent(where.project)}/${encodeURIComponent(where.task)}`
  let answer = null
  let failed = null
  let view = null
  let timer = null
  let gone = false

  const draw = () => {
    if (view === null) return
    coming.hidden = answer !== null || failed !== null
    waiting.hidden = answer !== null || failed !== null
    if (failed !== null && answer === null) {
      why.hidden = false
      textIn(why, failed)
      frame.hidden = true
      facts.hidden = true
      none.hidden = true
      return
    }
    if (answer === null) {
      why.hidden = true
      frame.hidden = true
      facts.hidden = true
      none.hidden = true
      more.hidden = true
      return
    }
    // Asked for and answered, where there is no screen to draw: the reason,
    // and no rows coming.
    coming.hidden = true
    screenIn(answer, view)
    momentsIn(answer, view)
  }

  const screenIn = (said, at) => {
    const shown = said.screen
    why.hidden = shown !== null
    textIn(why, shown === null ? (WHY_SAID[said.why] ?? WHY_SAID['could not read']) : '')
    frame.hidden = shown === null
    if (shown === null) {
      facts.hidden = true
      textIn(screen.figure, '')
      return
    }
    // **One text node, written only when it changed**, so a selection somebody
    // is making in it survives every ask that brought the same rows back.
    textIn(rows, shown.lines.join('\n'))
    const age = ageSaid(shown.at, at.asOf, at.frozen)
    textIn(screen.figure, age === null ? '' : `read ${age} ago`)
    const parts = []
    if (shown.above > 0) parts.push(`${shown.above} rows above these`)
    if (shown.cut > 0) parts.push(`${shown.cut} cut at the edge`)
    if (shown.taken > 0) parts.push(`${shown.taken} taken out`)
    // A failed ask after a good one keeps the rows and says so: what is on
    // screen is the last thing that was true, and never a blank pane.
    if (failed !== null) parts.push(failed)
    textIn(facts, parts.join(' · '))
    facts.hidden = parts.length === 0
  }

  const momentsIn = (said, at) => {
    const seen = new Map()
    const keyedRows = said.activity.map((one) => {
      const base = `${one.at}|${one.kind}|${one.said}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return { ...one, key: `${base}|${n}` }
    })
    keyed(
      list,
      keyedRows,
      (one) => one.key,
      createMoment,
      (one, row) => fillMoment(one, row, at),
    )
    none.hidden = keyedRows.length > 0 || !said.here
    more.hidden = !said.more
    textIn(activity.figure, said.activity.length === 0 ? '' : count(said.activity.length))
  }

  const ask = async () => {
    timer = null
    if (gone) return
    // **Hidden is not looking.** A tab in the background asks nothing, so a
    // laptop with the page left open in another tab is not a lane being read
    // every two seconds for as long as it is awake.
    if (document.visibilityState === 'visible') {
      const got = await ctx.ask('GET', path)
      if (gone) return
      if (got.status === 200 && got.body !== null && got.body.v === 1) {
        answer = got.body
        failed = null
      } else {
        failed = troubleSaid(troubleOf(got) ?? UNKNOWN_TROUBLE)
      }
      draw()
    }
    timer = setTimeout(() => void ask(), EVERY_MS)
  }
  void ask()

  return {
    nodes: [screen.node, activity.node],
    head,
    update(next) {
      view = next
      draw()
    },
    leave() {
      gone = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

function createMoment() {
  const node = el('li')
  const row = el('div')
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const said = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(row, glyph, said, aside)
  into(node, row)
  return node
}

function fillMoment(node, moment, view) {
  const [row] = node.children
  const [glyph, said, aside] = row.children
  const mark = MOMENTS[moment.kind] ?? { glyph: '·', tone: 't-quiet' }
  textIn(glyph, mark.glyph)
  toneOn(glyph, mark.tone)
  textIn(said, moment.said)
  const age = ageSaid(moment.at, view.asOf, view.frozen)
  textIn(aside, age ?? '')
}
