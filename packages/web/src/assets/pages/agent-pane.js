// One agent, looked into: what its screen shows, and the asking that brings
// it and its activity back — the screen card on the agent's own page
// (`agent.js`), which draws the activity as its timeline (`agent-time.js`).
// The list of every agent is `../agents.js`.
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
import { el, into, skeleton, textIn } from '../dom.js'
import { ageSaid } from '../figures.js'
import { troubleOf, troubleSaid, UNKNOWN_TROUBLE } from '../trouble.js'
import { stateBox, stateBoxIn } from '../ui.js'

/** How often a page that is looking asks again: the window's own beat. */
const EVERY_MS = 2000

/**
 * Why there is no screen, as a sentence somebody can act on.
 *
 * One per word of `SCREEN_WHY`, held equal to it by `test/agents-client.test.ts`:
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

/** The icon each absence is drawn with: a lock is not a broken pane. */
const WHY_ICON = {
  'not granted': 'devices',
  'no agent': 'agents',
  'not read yet': 'clock',
  'could not read': 'alert',
  'not here': 'folder',
}

/**
 * The screen card, and the asking behind it.
 *
 * Returns the card, an `update` the page calls with every paint, `heard()` —
 * the last answer and the last failure, which the page draws its timeline
 * from — and a `leave` the router calls when somebody goes elsewhere: the one
 * thing that stops the asking, and so the reading at the machine. `told` is
 * called after every ask, so the timeline moves when the answer does rather
 * than at the next delta.
 */
export function agentPane(where, ctx, told = () => {}) {
  const card = el('div', { class: 'ui-panel ag-term' })
  const frame = el('div', {
    class: 'scrolls screen',
    attrs: { role: 'region', 'aria-label': 'The last rows of its screen', tabindex: '0' },
  })
  const rows = el('pre')
  into(frame, rows)
  // Before the first answer, the rows that are coming rather than a sentence.
  const coming = skeleton(8)
  coming.classList.add('ag-term-coming')
  const why = stateBox()
  why.classList.add('ag-term-why')
  const foot = el('p', { class: 'ag-term-foot' })
  into(card, coming, why, frame, foot)
  // What the section's figure says: when the rows were read.
  const read = el('span')

  const path = `/api/agent/${encodeURIComponent(where.project)}/${encodeURIComponent(where.task)}`
  let answer = null
  let failed = null
  let view = null
  let timer = null
  let gone = false

  const draw = () => {
    if (view === null) return
    coming.hidden = answer !== null || failed !== null
    if (answer === null) {
      frame.hidden = true
      foot.hidden = true
      textIn(read, '')
      stateBoxIn(why, failed === null ? null : { kind: 'error', icon: 'alert', ...said(failed) })
      return
    }
    const shown = answer.screen
    frame.hidden = shown === null
    if (shown === null) {
      foot.hidden = true
      textIn(read, '')
      const word = answer.why ?? 'could not read'
      stateBoxIn(why, {
        kind: word === 'could not read' ? 'error' : 'empty',
        icon: WHY_ICON[word] ?? 'alert',
        ...said(WHY_SAID[word] ?? WHY_SAID['could not read']),
      })
      return
    }
    stateBoxIn(why, null)
    // **One text node, written only when it changed**, so a selection somebody
    // is making in it survives every ask that brought the same rows back.
    textIn(rows, shown.lines.join('\n'))
    const age = ageSaid(shown.at, view.asOf, view.frozen)
    textIn(read, age === null ? '' : `read ${age} ago`)
    const parts = []
    if (shown.above > 0) parts.push(`${shown.above} rows above these`)
    if (shown.cut > 0) parts.push(`${shown.cut} cut at the edge`)
    if (shown.taken > 0) parts.push(`${shown.taken} taken out`)
    // A failed ask after a good one keeps the rows and says so: what is on
    // screen is the last thing that was true, and never a blank pane.
    if (failed !== null) parts.push(failed)
    textIn(foot, parts.join(' · '))
    foot.hidden = parts.length === 0
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
      told()
    }
    timer = setTimeout(() => void ask(), EVERY_MS)
  }
  void ask()

  return {
    card,
    read,
    heard: () => ({ answer, failed }),
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

/**
 * A sentence as a state's heading and its line: what is not there, and — after
 * the dash — what to do about it.
 */
function said(sentence) {
  const cut = sentence.indexOf(' — ')
  // Shorthand: a `title` key is a tooltip to `design.test.ts`, and this is a heading.
  const title = cut < 0 ? sentence : sentence.slice(0, cut)
  const line = cut < 0 ? null : sentence.slice(cut + 3)
  return { title, line }
}
