// Pairing a device, as a flow somebody is led through rather than a form in
// the middle of a page.
//
// **Four steps, and the page always says which one you are on**: open Tade at
// the machine, scan the code it draws, name this device, approve it at the
// machine. The page can tell the first two from the third by whether a ticket
// arrived in the address (the code is a link with one in its fragment), and
// the fourth is the wait while the machine asks the person at it — so each
// step lights as it is reached, the done ones tick, and what to do next is
// the one thing drawn large. Then it hands you into the app.
//
// **What does not change**: the ticket is in the fragment and leaves the
// address bar as it is read (`boot.js`); it is presented once and burned on
// the claim, so a refusal or a deadline means a new code, never a retry; the
// person at the machine decides; and what letting this device in will let it
// read is said **at the moment of deciding**, beside the press — the one
// sentence on this screen that may not be folded away.
//
// **Unreachable is not unpaired.** A page that could not reach the machine at
// all says so first, because *scan the code* is the wrong advice for a laptop
// that is asleep.

import { el, into, textIn } from './dom.js'
import { icon, iconIn, wordmark } from './icons.js'

/** The four steps, in order: what each is called and what it is drawn as. */
export const STEPS = [
  { key: 'open', title: 'Open Tade on the machine', sub: 'Settings › Away', icon: 'laptop' },
  { key: 'scan', title: 'Scan its code', sub: "with this device's camera", icon: 'scan' },
  { key: 'name', title: 'Name this device', sub: 'so you can revoke it', icon: 'notes' },
  { key: 'approve', title: 'Approve it there', sub: "a key in Tade's window", icon: 'check' },
]

/**
 * Where the flow stands, as a pure function of what the page knows.
 *
 * `ticket` is whether one arrived in the address — none means the very
 * start, since nothing here can tell that Tade is open; `phase` is what pressing
 * Pair has come to — `idle`, `asking` while the machine decides, `done`, or
 * `refused`. The step a person is on is the first one not done.
 */
export function stepOf(ticket, phase) {
  if (phase === 'done') return STEPS.length
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
  const card = el('section', { class: 'pair-card', attrs: { 'aria-labelledby': 'pair-head' } })
  const mark = el('span', { class: 'pair-mark' })
  into(mark, wordmark())
  const title = el('h1', { text: 'Pair this device', attrs: { id: 'pair-head' } })

  // What the machine could not be reached about, before anything else.
  const gone = el('p', { class: 'pair-gone' })
  into(
    gone,
    icon('alert'),
    el('span', {
      text: 'Tade isn’t answering. The machine may be asleep, or Tade closed there.',
    }),
  )
  gone.hidden = ctx.outside?.() !== 'unreachable'

  const steps = el('ol', { class: 'steps' })
  const drawn = STEPS.map((step, at) => {
    const item = el('li', { class: 'step' })
    const dot = el('span', { class: 'step-dot', attrs: { 'aria-hidden': 'true' } })
    into(dot, icon(step.icon))
    const words = el('span', { class: 'step-words' })
    into(
      words,
      el('span', { class: 'step-title', text: step.title }),
      el('span', { class: 'step-sub', text: step.sub }),
    )
    const state = el('span', { class: 'sr-only' })
    into(item, dot, words, state)
    steps.append(item)
    return { item, dot, state, at }
  })

  // The controls for the step a person is on.
  const form = el('div', { class: 'pair-form' })
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
  // **Said where somebody is deciding**, and so not behind a `?`.
  const why = el('p', {
    class: 'caveat',
    text: 'Tade will ask at the machine before this device is let in. It will be able to read every project, task, note, check and figure — including what you have typed into Tade, as you typed it — and to change nothing.',
  })
  into(form, label, field, press, why)

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

  const said = el('p', { attrs: { role: 'status' } })
  const away = el('p', { class: 'pair-away' })
  into(away, icon('devices'), el('span', { text: 'On the go: Settings › Away, on the machine' }))
  into(card, mark, title, gone, steps, form, waiting, paired, said, away)
  into(node, card)

  const ticket = ctx.ticket()
  let phase = 'idle'

  const draw = () => {
    const now = stepOf(ticket !== null, phase)
    for (const one of drawn) {
      const state = one.at < now ? 'done' : one.at === now ? 'now' : 'next'
      one.item.setAttribute('data-state', state)
      if (one.at === now) one.item.setAttribute('aria-current', 'step')
      else one.item.removeAttribute('aria-current')
      iconIn(one.dot.firstChild, state === 'done' ? 'check' : STEPS[one.at].icon)
      textIn(one.state, state === 'done' ? ', done' : state === 'now' ? ', this step' : '')
    }
    form.hidden = ticket === null || phase !== 'idle'
    waiting.hidden = phase !== 'asking'
    paired.hidden = phase !== 'done'
    away.hidden = ticket !== null
  }

  if (ticket !== null) {
    const pair = async () => {
      if (phase !== 'idle') return
      phase = 'asking'
      textIn(said, '')
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
      textIn(said, `${ctx.sentence(answer)} Scan a new code in the window.`)
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
