// Pairing a device, as a flow somebody is led through rather than a form in
// the middle of a page.
//
// **Four steps, and the page always says which one you are on**: open Tade at
// the machine, scan the code it draws — or, on a computer, open the link under
// it — name this device, approve it at the machine. The page can tell the first two from the third by whether a ticket
// arrived in the address (the code is a link with one in its fragment), and
// the fourth is the wait while the machine asks the person at it — so each
// step lights as it is reached, the done ones tick, and what to do next is
// the one thing drawn large. Then it hands you into the app.
//
// **What does not change**: the ticket is in the fragment and leaves the
// address bar as it is read (`boot.js`); it is presented once and burned on
// the claim, so a refusal or a deadline means a new code, never a retry; the
// person at the machine decides; and what letting this device in will let it
// read is said **at the moment of deciding**, beside the press: *read only*,
// with the whole of what it reads one `?` away.
//
// **Trouble is red and short** (`trouble.js`): an expired code, a refusal or a
// machine that is not answering is what happened and what to do, at the top of
// the card with a press to start over — never a quiet step back.
//
// **A phone scans and a computer opens a link** (`formOf`): the page guesses
// which it is on from the browser and the pointer, and says the step that fits
// — with one press to say otherwise, because a guess about a device is wrong
// for somebody.
//
// **Unreachable is not unpaired.** A page that could not reach the machine at
// all says so first, because *scan the code* is the wrong advice for a laptop
// that is asleep.

import { el, into, textIn } from './dom.js'
import { icon, iconIn, wordmark } from './icons.js'
import { TROUBLES, troubleOf } from './trouble.js'
import { note, problem, problemIn } from './ui.js'

const OPEN = {
  key: 'open',
  title: 'Open Tade on the machine',
  sub: 'Settings › Away view',
  icon: 'laptop',
}
const NAME = { key: 'name', title: 'Name this device', sub: 'so you can revoke it', icon: 'notes' }
const APPROVE = {
  key: 'approve',
  title: 'Approve it there',
  sub: "a key in Tade's window",
  icon: 'check',
}

/**
 * The four steps, in order, for each kind of device: what each is called and
 * what it is drawn as. Only the second differs — how the code gets here.
 */
export const FLOWS = {
  handheld: [
    OPEN,
    { key: 'scan', title: 'Scan its code', sub: 'with the camera', icon: 'scan' },
    NAME,
    APPROVE,
  ],
  computer: [
    OPEN,
    { key: 'link', title: 'Open its link here', sub: 'the address under the code', icon: 'arrow' },
    NAME,
    APPROVE,
  ],
}

/** How many steps a flow has: the same for both, so where you are is one number. */
export const STEP_COUNT = 4

/** What switching says, on each: the other kind of device, and its drawing. */
const OTHER = {
  handheld: { form: 'computer', word: 'On a computer?', icon: 'laptop' },
  computer: { form: 'handheld', word: 'On a phone?', icon: 'devices' },
}

/**
 * Whether this is a device you hold up to a screen or a computer you click
 * on, out of the browser's own description of itself and whether its pointer
 * is a finger. A tablet scans as a phone does.
 */
export function formOf(agent, coarse) {
  const said = String(agent ?? '')
  if (/iPhone|iPod|iPad|Android|Mobile/.test(said)) return 'handheld'
  // An iPad asking for the desktop site says it is a Mac; its finger does not.
  return coarse === true ? 'handheld' : 'computer'
}

/**
 * Where the flow stands, as a pure function of what the page knows.
 *
 * `ticket` is whether one arrived in the address — none means the very
 * start, since nothing here can tell that Tade is open; `phase` is what pressing
 * Pair has come to — `idle`, `asking` while the machine decides, `done`, or
 * `refused`. The step a person is on is the first one not done.
 */
export function stepOf(ticket, phase) {
  if (phase === 'done') return STEP_COUNT
  if (phase === 'asking') return 3
  // Refused, a code was in hand, so Tade is open: the way on is a new one.
  if (phase === 'refused') return 1
  // No code yet is the very start: nothing here can tell that Tade is open.
  return ticket ? 2 : 0
}

/**
 * A word for this device, offered as its name: what it is, out of the
 * browser's own description of itself, and nothing more particular than that.
 */
export function deviceWord(agent) {
  const said = String(agent ?? '')
  if (/iPhone/.test(said)) return 'iPhone'
  if (/iPad/.test(said)) return 'iPad'
  if (/Android/.test(said)) return /Mobile/.test(said) ? 'Android phone' : 'Android tablet'
  if (/Macintosh|Mac OS X/.test(said)) return 'Mac'
  if (/Windows/.test(said)) return 'Windows PC'
  if (/CrOS/.test(said)) return 'Chromebook'
  if (/Linux/.test(said)) return 'Linux'
  return ''
}

/** How long a paired page shows its tick before going in. */
export const IN_AFTER_MS = 1200

export function pairScreen(ctx) {
  const node = el('div', { class: 'pair' })
  const card = el('section', {
    class: 'pair-card ui-panel',
    attrs: { 'aria-labelledby': 'pair-head' },
  })
  const mark = el('span', { class: 'pair-mark' })
  into(mark, wordmark())
  const title = el('h1', { text: 'Pair this device', attrs: { id: 'pair-head' } })

  // What went wrong, before anything else: the machine not answering, or the
  // code that ran out — red, in a few words, with the one thing to do.
  const trouble = problem()
  const again = { word: 'Start over', run: () => ctx.go('/pair', { replace: true, reload: true }) }
  if (ctx.outside?.() === 'unreachable') problemIn(trouble, TROUBLES.offline, again)

  let form = formOf(
    globalThis.navigator?.userAgent,
    globalThis.matchMedia?.('(pointer: coarse)').matches,
  )
  const steps = el('ol', { class: 'steps' })
  const drawn = FLOWS[form].map((_, at) => {
    const item = el('li', { class: 'step' })
    const dot = el('span', { class: 'step-dot', attrs: { 'aria-hidden': 'true' } })
    into(dot, icon(FLOWS[form][at].icon))
    const title = el('span', { class: 'step-title' })
    const sub = el('span', { class: 'step-sub' })
    const words = el('span', { class: 'step-words' })
    into(words, title, sub)
    const state = el('span', { class: 'sr-only' })
    into(item, dot, words, state)
    steps.append(item)
    return { item, dot, title, sub, state, at }
  })

  // The controls for the step a person is on.
  const controls = el('div', { class: 'pair-form' })
  const label = el('label', { text: 'This device', attrs: { for: 'label' } })
  const field = el('input', {
    attrs: {
      id: 'label',
      type: 'text',
      maxlength: '40',
      autocomplete: 'off',
      placeholder: 'My phone',
      enterkeyhint: 'go',
    },
  })
  field.value = deviceWord(globalThis.navigator?.userAgent)
  const press = el('button', { class: 'press pair-press', attrs: { type: 'button' } })
  into(press, el('span', { text: 'Pair' }), icon('chevron'))
  // **Said where somebody is deciding**: what letting it in grants, as two
  // words beside the press and the whole of it one `?` away.
  const why = note(
    'read only',
    'Tade asks at the machine first. This device will read every project, task, note, check and figure — what you typed into Tade included — and change nothing.',
    'checks',
  )
  into(controls, label, field, press, why)

  const waiting = el('div', { class: 'pair-waiting' })
  into(
    waiting,
    el('span', { class: 'pair-pulse', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: 'Waiting for the machine' }),
  )
  const paired = el('div', { class: 'pair-done' })
  const tick = el('span', { class: 'pair-tick', attrs: { 'aria-hidden': 'true' } })
  into(tick, icon('check'))
  into(paired, tick, el('span', { text: 'Paired' }))

  // A guess about a device is wrong for somebody: one press says otherwise.
  const other = el('button', { class: 'press ghost pair-other', attrs: { type: 'button' } })
  const otherIcon = icon('laptop')
  const otherWord = el('span')
  into(other, otherIcon, otherWord)
  other.addEventListener('click', () => {
    form = OTHER[form].form
    draw()
  })
  into(card, mark, title, trouble, steps, controls, waiting, paired, other)
  into(node, card)

  const ticket = ctx.ticket()
  let phase = 'idle'

  const draw = () => {
    const now = stepOf(ticket !== null, phase)
    const flow = FLOWS[form]
    for (const one of drawn) {
      const step = flow[one.at]
      const state = one.at < now ? 'done' : one.at === now ? 'now' : 'next'
      one.item.setAttribute('data-state', state)
      if (one.at === now) one.item.setAttribute('aria-current', 'step')
      else one.item.removeAttribute('aria-current')
      iconIn(one.dot.firstChild, state === 'done' ? 'check' : step.icon)
      textIn(one.title, step.title)
      textIn(one.sub, step.sub)
      textIn(one.state, state === 'done' ? ', done' : state === 'now' ? ', this step' : '')
    }
    controls.hidden = ticket === null || phase !== 'idle'
    waiting.hidden = phase !== 'asking'
    paired.hidden = phase !== 'done'
    // Once a code is here, how it came is past: nothing left to switch.
    other.hidden = ticket !== null
    iconIn(otherIcon, OTHER[form].icon)
    textIn(otherWord, OTHER[form].word)
  }

  if (ticket !== null) {
    const pair = async () => {
      if (phase !== 'idle') return
      phase = 'asking'
      problemIn(trouble, null)
      draw()
      const answer = await ctx.ask('POST', '/api/pair', { ticket, label: field.value })
      if (answer.status === 201) {
        phase = 'done'
        draw()
        // A beat to see it worked, and then into the app.
        setTimeout(() => ctx.go('/', { replace: true, reload: true }), IN_AFTER_MS)
        return
      }
      // One try per ticket, whatever the answer: it was burned the moment it
      // was presented, so the way on is a new code, from step two.
      phase = 'refused'
      draw()
      problemIn(trouble, troubleOf(answer, 'pair'), again)
    }
    press.addEventListener('click', () => void pair())
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return
      event.preventDefault()
      void pair()
    })
  }
  draw()

  return { node, update() {} }
}
