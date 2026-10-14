// The devices: this one first — what it is, whether it is connected, how long
// its session has left, how it reaches the machine and what it was granted —
// then every device that can reach this machine, its notifications, and what
// it has itself said to Tade.
//
// **What somebody opening this page wants** is two answers: *is this device
// all right*, and *which devices can get in*. So the lead is this device,
// drawn — its kind, a live mark, its session as a gauge and four facts — and
// the list of every device is the first thing under it, this one marked and
// the rest by name, kind and when each was let in. What this device may read
// and do is a matrix of every grant, on and off, so a grant that is missing
// can be told from one the page forgot.
//
// **Nothing here widens anything.** Another device is a name and a date,
// because that is all `/api/devices` sends about one (`listing`, `src/devices.ts`);
// where it connects from, what it may do and what it did are the machine's to
// show, where it is disconnected. Every figure and word is `devices-shape.js`'s.

import { mayFor } from '../access.js'
import { gauge, gaugeIn } from '../charts.js'
import { classOn, el, into, keyed, skeleton, textIn } from '../dom.js'
import { icon } from '../icons.js'
import {
  CANNOT,
  DENIED,
  INSECURE,
  NOT_OFFERED,
  OFF,
  ON,
  PUSH_SAID,
  pushState,
  subscribe,
  unsubscribe,
} from '../push.js'
import { section } from '../rows.js'
import { chatOf, notesOf } from '../store.js'
import { TROUBLES, troubleOf, UNKNOWN_TROUBLE } from '../trouble.js'
import { answerIn, facts, factsIn, panel, problem, problemIn, stateBox, stateBoxIn } from '../ui.js'
import {
  leadState,
  listOf,
  listSaid,
  liveOf,
  matrixOf,
  reachOf,
  recentOf,
  thisOf,
} from './devices-shape.js'

/** A region's state, as `stateBoxIn` takes it: a kind, its heading, a line, the one press and its mark. */
function boxOf(kind, heading, line = null, action = null, mark = undefined) {
  const title = heading
  return { kind, title, line, action, icon: mark }
}

/**
 * What this browser's own credential is, and every device that has been let in.
 *
 * **The whole list is here on purpose.** Nothing on this machine is contained —
 * an agent runs as you and can append to the paired-device list — so seeing
 * every device there is, is the mitigation, and disconnecting one needs no
 * network at all. That is said here because this is the page somebody reads it
 * on, and it is the page's own sentence about its own list rather than a second
 * copy of the domain's.
 */
export function devicesScreen(ctx) {
  const node = el('div')
  const top = section('DEVICES', { top: true })
  // Signing this device out, at the end of the bar: an act on the page's own
  // subject, where every screen keeps what may be done here. **Two presses**,
  // because the way back in is a code at the machine — a mis-tap on a train
  // is an evening without Tade.
  const out = signOutOf(ctx)
  into(top.tools, out.press)

  const lead = leadOf(() => void freshen())
  into(top.body, out.said, lead.node)

  const every = everyOf(() => void freshen())
  const grants = grantsOf()
  const telling = tellingOf(ctx)
  const recent = recentPartOf()
  // The list and, beside it at a desk, the two short ones; the matrix across
  // the whole width under both, where its cells sit four abreast. On a phone
  // it is one column in this order, the matrix last because the lead already
  // says how much of it is on.
  const aside = el('div', { class: 'dv-aside' })
  into(aside, telling.node, recent.node)
  const cols = el('div', { class: 'dv-cols' })
  into(cols, every.node, aside, grants.node)
  into(node, top.node, cols)

  /** `asking` until the list answers, then `done` or `failed`. */
  let asked = 'asking'
  let last = null
  // The device list is not on the stream — letting a phone in or disconnecting
  // one is not a projection change — so it is asked for when this screen
  // opens, which is the only moment anybody is reading it. `freshen` answers
  // nothing, so whether it worked is whether the list it holds was replaced:
  // a new answer is always a new array.
  const freshen = async () => {
    asked = 'asking'
    if (last !== null) draw(last)
    const before = ctx.devices()
    await ctx.freshen()
    asked = ctx.devices() !== before ? 'done' : 'failed'
    if (last !== null) draw(last)
  }

  const draw = (view) => {
    last = view
    const who = ctx.session()
    const rows = ctx.devices()
    const list = listOf(rows, view.asOf)
    textIn(top.figure, list === null ? '' : String(list.length))
    lead.fill(who, rows, view, asked)
    every.fill(list, asked)
    grants.fill(matrixOf(who))
    telling.fill()
    const store = view.store
    recent.fill(
      store.had === true
        ? recentOf(
            {
              chat: chatOf(store),
              notes: notesOf(store),
              device: who?.device ?? store.you?.device ?? null,
              mayTalk: mayFor(store, 'chat'),
              mayNotes: mayFor(store, 'notes'),
            },
            view.asOf,
          )
        : null,
    )
  }

  void freshen()
  return { node, update: draw }
}

/* ── signing out ───────────────────────────────────────────────────────────── */

function signOutOf(ctx) {
  const press = el('button', {
    class: 'press quietly small dv-out',
    attrs: { type: 'button' },
  })
  into(press, icon('close'), el('span', { text: 'Sign out' }))
  // Where a sign-out that did not happen says why. Hidden while empty, in the
  // sheet, so a press that wrote into it shows it without waiting for a paint.
  const said = el('p', { class: 'dv-out-said', attrs: { role: 'status' } })
  let armed = false
  const word = () => {
    textIn(press.lastChild, armed ? 'Tap again to sign out' : 'Sign out')
    classOn(press, 'asked', armed)
  }
  press.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      word()
      return
    }
    press.disabled = true
    const who = ctx.session()
    if (who === null) {
      answerIn(said, '', TROUBLES.no_session)
      press.disabled = false
      armed = false
      word()
      return
    }
    const answer = await ctx.ask('DELETE', `/api/devices/${encodeURIComponent(who.device)}`, {})
    if (answer.status === 200) {
      ctx.go('/pair', { replace: true })
      return
    }
    press.disabled = false
    armed = false
    word()
    answerIn(said, '', troubleOf(answer) ?? UNKNOWN_TROUBLE)
  })
  // Leaving the press puts it back, so a first tap left behind is not a
  // second one waiting for whoever touches it next.
  press.addEventListener('blur', () => {
    if (!armed || press.disabled) return
    armed = false
    word()
  })
  return { press, said }
}

/* ── the lead: this device ─────────────────────────────────────────────────── */

const FACTS = ['Paired', 'Reaches Tade', 'May read', 'May do']

function leadOf(retry) {
  const node = el('section', { class: 'ui-panel dv-lead', attrs: { 'aria-label': 'This device' } })
  const state = stateBox()
  const me = el('div', { class: 'dv-me' })
  const mark = el('span', { class: 'dv-mark', attrs: { 'aria-hidden': 'true' } })
  const who = el('div', { class: 'dv-who' })
  const name = el('p', { class: 'dv-name' })
  const pills = el('p', { class: 'dv-pills' })
  const live = el('span', { class: 'ui-pill dv-live' })
  const liveGlyph = el('span', { attrs: { 'aria-hidden': 'true' } })
  const liveWord = el('span')
  into(live, liveGlyph, liveWord)
  const here = el('span', { class: 'ui-pill t-here', text: 'this device' })
  into(pills, here, live)
  const kind = el('p', { class: 'dv-kind' })
  into(who, name, pills, kind)
  const time = gauge('Session left')
  time.classList.add('dv-gauge')
  into(me, mark, who, time)
  const figures = facts('This device')
  into(node, state, me, figures)
  let drawn = null

  return {
    node,
    fill(session, rows, view, asked) {
      const shown = leadState(session, asked)
      const again = asked === 'failed' ? { word: 'Try again', run: retry } : null
      stateBoxIn(state, shown === null ? null : boxOf(shown.kind, shown.heading, shown.line, again))
      me.hidden = shown !== null
      figures.hidden = shown !== null
      if (shown !== null) return
      const one = thisOf(session, rows, view.asOf)
      if (drawn !== one.icon) {
        drawn = one.icon
        mark.replaceChildren(icon(one.icon))
      }
      textIn(name, one.name)
      const standing = liveOf(view.standing)
      // A toned pill draws its own dot (`ui.css`), so the glyph is said only
      // where there is no tone to draw one.
      textIn(liveGlyph, standing.glyph)
      liveGlyph.hidden = standing.tone !== null
      textIn(liveWord, standing.word)
      for (const tone of ['t-done', 't-working', 't-failed']) {
        classOn(live, tone, standing.tone === tone)
      }
      textIn(kind, one.kindWord)
      gaugeIn(
        time,
        one.session === null
          ? { share: null }
          : {
              share: one.session.share,
              said: one.session.said,
              under: one.session.endsOn === null ? 'left' : `until ${one.session.endsOn}`,
              pressure: one.session.pressure,
            },
      )
      const reach = reachOf(globalThis.location?.hostname, globalThis.location?.protocol)
      const grants = matrixOf(session)
      factsIn(figures, [
        { label: FACTS[0], value: one.ago === null ? null : agoIn(one.ago), under: one.when },
        { label: FACTS[1], value: reach.word, under: reach.under },
        { label: FACTS[2], value: grants?.readSaid ?? null },
        { label: FACTS[3], value: grants?.doSaid ?? null },
      ])
    },
  }
}

/** `3d` as a phrase: `3d ago`, and `now` as `just now`. */
function agoIn(ago) {
  return ago === 'now' ? 'just now' : `${ago} ago`
}

/* ── every device ──────────────────────────────────────────────────────────── */

function everyOf(retry) {
  const made = section('EVERY DEVICE', {
    hint: 'Every device that can reach this machine, by the name it was paired under. Nothing on that machine is contained — an agent there runs as you and could pair itself — which is why every one is listed. Where a device connects from, what it may do and what it did are shown at the machine, and disconnecting one is done there and needs no network.',
  })
  const sum = el('p', { class: 'dv-sum' })
  const list = panel('ul', 'dv-list')
  const coming = skeleton(2)
  const wrong = stateBox()
  const stale = problem()
  stale.classList.add('dv-stale')
  into(made.body, sum, stale, list, coming, wrong)
  return {
    node: made.node,
    fill(rows, asked) {
      const none = rows === null
      coming.hidden = !none || asked !== 'asking'
      const again = { word: 'Try again', run: retry }
      stateBoxIn(
        wrong,
        none && asked === 'failed'
          ? boxOf('error', TROUBLES.offline.title, TROUBLES.offline.fix, again)
          : !none && rows.length === 0
            ? boxOf('empty', 'No device is paired', 'Pair one from the Away panel at the machine.')
            : null,
      )
      // A list that is there but could not be asked again is still the list,
      // said as the one it is rather than replaced by an error.
      problemIn(stale, !none && asked === 'failed' ? TROUBLES.offline : null, again)
      list.hidden = none || rows.length === 0
      textIn(sum, listSaid(rows))
      keyed(list, rows ?? [], (one) => one.key, createDevice, fillDevice)
    },
  }
}

function createDevice() {
  const node = el('li', { class: 'dv-row' })
  const tile = el('span', { class: 'dv-tile', attrs: { 'aria-hidden': 'true' } })
  const words = el('span', { class: 'dv-row-words' })
  const line = el('span', { class: 'dv-row-line' })
  const name = el('span', { class: 'dv-row-name' })
  const you = el('span', { class: 'ui-pill t-here', text: 'this device' })
  const fresh = el('span', { class: 'ui-pill', text: 'new' })
  into(line, name, you, fresh)
  const under = el('span', { class: 'dv-row-under' })
  into(words, line, under)
  const ago = el('span', { class: 'dv-row-ago' })
  into(node, tile, words, ago)
  return node
}

function fillDevice(node, one) {
  const [tile, words, ago] = node.children
  const [line, under] = words.children
  const [name, you, fresh] = line.children
  if (tile.dataset.icon !== one.icon) {
    tile.dataset.icon = one.icon
    tile.replaceChildren(icon(one.icon))
  }
  classOn(node, 'is-you', one.you)
  classOn(name, 'is-unnamed', !one.named)
  textIn(name, one.name)
  you.hidden = !one.you
  fresh.hidden = !one.fresh
  textIn(under, one.when === null ? one.kindWord : `${one.kindWord} · paired ${one.when}`)
  textIn(ago, one.ago === null ? '' : agoIn(one.ago))
}

/* ── what this device may read and do ──────────────────────────────────────── */

function grantsOf() {
  const made = section('ACCESS', {
    hint: 'What this device was granted at the machine, one device at a time — and only there: nothing on this page or any other can widen it. The machine asks again at every act, together with its own settings, which can turn a grant off for every device at once.',
  })
  const box = panel('div', 'dv-grants')
  const read = groupOf('May read')
  const does = groupOf('May do')
  into(box, read.node, does.node)
  const coming = skeleton(2)
  into(made.body, box, coming)
  return {
    node: made.node,
    fill(matrix) {
      coming.hidden = matrix !== null
      box.hidden = matrix === null
      if (matrix === null) return
      read.fill(matrix.read, matrix.readSaid)
      does.fill(matrix.does, matrix.doSaid)
    },
  }
}

let groups = 0

function groupOf(heading) {
  groups += 1
  const id = `dv-group-${groups}`
  const node = el('div', { class: 'dv-group' })
  const head = el('div', { class: 'dv-group-head' })
  const n = el('span', { class: 'dv-group-n' })
  into(head, el('h3', { text: heading, attrs: { id } }), n)
  const cells = el('ul', { class: 'dv-cells', attrs: { 'aria-labelledby': id } })
  into(node, head, cells)
  return {
    node,
    fill(list, said) {
      textIn(n, said)
      keyed(cells, list, (one) => one.key, createCell, fillCell)
    },
  }
}

function createCell() {
  const node = el('li', { class: 'dv-cell' })
  const tick = el('span', { class: 'dv-tick', attrs: { 'aria-hidden': 'true' } })
  const words = el('span', { class: 'dv-cell-words' })
  into(
    words,
    el('span', { class: 'dv-cell-word' }),
    el('span', { class: 'dv-cell-under' }),
    el('span', { class: 'sr-only' }),
  )
  into(node, tick, words)
  return node
}

function fillCell(node, one) {
  const [tick, words] = node.children
  const [word, under, sr] = words.children
  classOn(node, 'is-on', one.on)
  classOn(node, 'is-floor', one.floor)
  const drawn = one.on ? 'check' : 'off'
  if (tick.dataset.drawn !== drawn) {
    tick.dataset.drawn = drawn
    tick.replaceChildren(one.on ? icon('check') : el('span', { class: 'dv-dash' }))
  }
  textIn(word, one.word)
  textIn(under, one.under ?? '')
  under.hidden = one.under === null || one.under === undefined
  // *On* and *off*, never *not granted*: that is the page's word for content
  // withheld from this device (`NOT_FOR_A_GRANTED_DEVICE`), and a scope the
  // machine did not give is not a figure this device was kept from reading.
  textIn(sr, one.floor ? ', always on' : one.on ? ', on' : ', off')
}

/* ── notifications ─────────────────────────────────────────────────────────── */

/**
 * The word a notification's standing is said in beside its sentence, and the
 * glyph before it — `PUSH_SAID`'s six standings, less the one that hides the
 * section, and the moment before the phone has answered.
 */
const TELLING = {
  [ON]: { glyph: '●', word: 'on', on: true },
  [OFF]: { glyph: '○', word: 'off', on: false },
  [DENIED]: { glyph: '⊘', word: 'blocked', on: false },
  [INSECURE]: { glyph: '⊘', word: 'needs https', on: false },
  [CANNOT]: { glyph: '⊘', word: 'unavailable', on: false },
}
const ASKING = { glyph: '◴', word: 'asking', on: false }

/**
 * **The notifications control, and it is on this screen because this is the
 * screen about this device.** The permission belongs to the phone, not to the
 * machine, and `pushState` reads the phone's own answer rather than a row in a
 * file — so a permission somebody took back in their browser's settings draws
 * as blocked here instead of as on.
 */
function tellingOf(ctx) {
  const made = section('NOTIFICATIONS', {
    hint: 'A count of what wants you and nothing else — no project, no task, no title — unless details are turned on at the machine. Relayed by your browser’s push service, which cannot read it; sent only while Tade’s window is open and the machine awake, and never caught up.',
  })
  const box = panel('div', 'dv-tell')
  const pill = el('span', { class: 'ui-pill dv-tell-pill' })
  const glyph = el('span', { attrs: { 'aria-hidden': 'true' } })
  const word = el('span')
  into(pill, glyph, word)
  const said = el('p', { class: 'dv-tell-said', attrs: { role: 'status' } })
  const tell = el('button', { class: 'press dv-tell-press', attrs: { type: 'button' } })
  into(box, pill, said, tell)
  into(made.body, box)
  /** What the *phone* says, which is the one thing this screen cannot derive. */
  let standing = null
  /**
   * What the machine was offering when the phone was last asked.
   *
   * Kept so that a paint can tell *the machine changed its mind* from *this
   * is the fourth paint of the same second*: asking the browser costs a
   * `getRegistration` and a `getSubscription`, which is not a thing to do four
   * times a second, and not asking at all would leave the control absent for
   * as long as the screen stays open after somebody turns notifications on.
   */
  let asked = null
  const draw = () => {
    // Hidden rather than drawn as unavailable while the machine is not
    // offering it: a control for a thing nobody turned on costs a section to
    // say nothing. The same decision the window makes about its own away
    // panel.
    made.node.hidden = standing === null || standing === NOT_OFFERED
    const shown = TELLING[standing] ?? ASKING
    textIn(glyph, shown.glyph)
    glyph.hidden = shown.on
    textIn(word, shown.word)
    classOn(pill, 't-done', shown.on)
    textIn(said, standing === null ? 'asking…' : (PUSH_SAID[standing] ?? ''))
    tell.hidden = standing !== ON && standing !== OFF
    classOn(tell, 'quietly', standing === ON)
    textIn(tell, standing === ON ? 'Stop telling this device' : 'Tell this device')
  }
  const askPhone = async () => {
    asked = JSON.stringify(ctx.shell()?.notifying ?? null)
    standing = await pushState(ctx.shell())
    draw()
  }
  draw()
  void askPhone()

  tell.addEventListener('click', async () => {
    tell.disabled = true
    // **The press is what raises the browser's prompt**, and it has to be this
    // handler: a prompt that is not a direct answer to a gesture is refused by
    // every browser that implements this, silently.
    standing = standing === ON ? await unsubscribe(ctx.ask) : await subscribe(ctx.shell(), ctx.ask)
    tell.disabled = false
    draw()
  })

  return {
    node: made.node,
    fill() {
      // The machine's half arrives on `/api/devices`, which `freshen` asks
      // again when this screen opens — so somebody who turns notifications on
      // at the machine and reloads the phone gets the control, and nobody
      // pays for a round trip per paint.
      if (asked !== JSON.stringify(ctx.shell()?.notifying ?? null)) void askPhone()
    },
  }
}

/* ── what this device said ─────────────────────────────────────────────────── */

function recentPartOf() {
  const made = section('FROM THIS DEVICE', {
    hint: 'What this device said to Tade and the notes it left, newest first. Everything a device asks for — a park, an answer, a message — is also written in the journal at the machine under its id.',
  })
  const sum = el('p', { class: 'dv-sum' })
  const list = el('ol', { class: 'ui-timeline dv-recent' })
  const more = el('p', { class: 'dv-more' })
  const coming = skeleton(2)
  const state = stateBox()
  into(made.body, sum, list, more, coming, state)
  return {
    node: made.node,
    fill(recent) {
      coming.hidden = recent !== null
      const shown = recent?.items ?? []
      list.hidden = shown.length === 0
      textIn(sum, recent?.said ?? '')
      textIn(more, recent !== null && recent.more > 0 ? `and ${recent.more} older` : '')
      stateBoxIn(
        state,
        recent === null || shown.length > 0
          ? null
          : !recent.granted
            ? boxOf(
                'empty',
                'Not granted to this device',
                'Reading the conversation or the notes is granted at the machine.',
                null,
                'talk',
              )
            : boxOf(
                'empty',
                'Nothing sent from here yet',
                'A message to Tade or a note left from this device shows here.',
                null,
                'talk',
              ),
      )
      keyed(list, shown, (one) => one.key, createMoment, fillMoment)
    },
  }
}

function createMoment() {
  const node = el('li')
  const body = el('div')
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const words = el('span', { class: 'name dv-said' })
  into(words, el('span', { class: 'sr-only' }), el('span'))
  const ago = el('span', { class: 'dv-row-ago' })
  into(body, glyph, words, ago)
  into(node, body)
  return node
}

function fillMoment(node, one) {
  const [glyph, words, ago] = node.firstChild.children
  if (glyph.dataset.icon !== one.icon) {
    glyph.dataset.icon = one.icon
    glyph.replaceChildren(icon(one.icon))
  }
  // The words as they were said and no more: a clamp in the sheet cuts a long
  // one, never an ellipsis written into it (`more` is the wire's, `said.ts`).
  const [kind, said] = words.children
  textIn(kind, one.kind === 'note' ? 'Note: ' : 'Message: ')
  textIn(said, one.said.words)
  textIn(ago, one.ago === null ? '' : agoIn(one.ago))
}
