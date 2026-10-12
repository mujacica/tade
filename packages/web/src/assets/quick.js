// The presses on a card: what a device was granted, a thumb's reach from the
// overview.
//
// **The same acts as the task's own page, and nothing else.** Each press is a
// verb out of `acts.js` — `controlsFor` decides whether it is drawn,
// `bodyFor` what it sends, `afterAnswer` what came of it — so a card cannot
// offer what the task's page would not, and the machine re-asks the scope, the
// setting, the origin, the project and the state at the act whatever the card
// said. A verb this device was not granted is **absent**; a verb the world
// cannot do right now is absent too, because its reason is the task's page's
// to give in full, one tap away.
//
// Four presses and a link: allow and deny what an agent is waiting on, mark it
// finished (two taps, as everywhere — finishing starts whatever waited on it),
// set it aside or pick it back up, and *Tell* — which goes to the task's page,
// because telling an agent something is a sentence and a card is no place to
// write one.

import { afterAnswer, bodyFor, confirms, controlsFor } from './acts.js'
import { classOn, el, felt, into, textIn } from './dom.js'
import { icon } from './icons.js'
import { taskPath } from './routes.js'
import { keyOf } from './screens.js'
import { answerIn } from './ui.js'

/** The verbs a card offers a press for, in the order they are drawn. */
export const QUICK = ['answer', 'done', 'park']

/** The short word on each press: a card is a thumb's width, not a sentence's. */
export function quickWord(verb, row, asked = false) {
  if (asked) return 'Sure?'
  switch (verb) {
    case 'answer':
      return `Allow ${row.approval?.tool ?? ''}`.trim()
    case 'done':
      return 'Done'
    case 'park':
      return row.parked === true ? 'Resume' : 'Set aside'
    default:
      return ''
  }
}

/**
 * `tell: false` on the task's own page, where telling its agent is the box a
 * little further down rather than a link back to the page it is on.
 */
export function quickActs(ctx, opts = {}) {
  const offersTell = opts.tell !== false
  const node = el('div', { class: 'quick' })
  // Nothing until a row says what may be asked of it.
  node.hidden = true
  const said = el('p', { class: 'quick-said', attrs: { role: 'status' } })
  const presses = new Map()
  let held = null
  let going = false

  const send = async (verb, typed, press) => {
    if (going || held === null) return
    going = true
    press.disabled = true
    const answer = await ctx.ask(
      'POST',
      `/api/act/${verb}`,
      bodyFor(verb, held, keyOf(), ctx.revOf(), typed),
    )
    going = false
    press.disabled = false
    if (answer.status === 200) felt()
    const came = afterAnswer(answer, ctx.sentence(answer))
    answerIn(said, came.said, came.trouble)
  }

  const pressOf = (verb, word, kind, typed, drawn) => {
    const press = el('button', { class: `press small ${kind}`, attrs: { type: 'button' } })
    const label = el('span')
    into(press, icon(drawn), label)
    let asked = false
    press.addEventListener('click', () => {
      if (confirms(verb) && !asked) {
        asked = true
        classOn(press, 'asked', true)
        textIn(label, quickWord(verb, held ?? {}, true))
        return
      }
      asked = false
      classOn(press, 'asked', false)
      void send(verb, typed, press)
    })
    presses.set(word, { press, label, verb })
    return press
  }

  const allow = pressOf('answer', 'allow', '', { allow: true }, 'check')
  const deny = pressOf('answer', 'deny', 'quietly', { allow: false }, 'close')
  const done = pressOf('done', 'done', 'quietly', { summary: '' }, 'flag')
  const park = pressOf('park', 'park', 'quietly', {}, 'pause')
  const tell = el('a', { class: 'press small ghost', attrs: { href: '/' } })
  into(tell, icon('talk'), el('span', { text: 'Tell' }))
  into(node, allow, deny, done, park, tell, said)

  return {
    node,
    update(task, view) {
      held = task
      const acts = view.may.acts ?? {}
      const standing = new Map(
        controlsFor(task, acts, [...QUICK, 'steer']).map((one) => [one.verb, one.kind]),
      )
      const yes = (verb) => standing.get(verb) === 'yes'
      allow.hidden = !yes('answer')
      deny.hidden = !yes('answer')
      done.hidden = !yes('done')
      park.hidden = !yes('park')
      tell.hidden = !offersTell || !yes('steer')
      tell.setAttribute('href', taskPath(task.id))
      for (const one of presses.values()) {
        if (one.press.classList.contains('asked')) continue
        textIn(one.label, one === presses.get('deny') ? 'Deny' : quickWord(one.verb, task))
      }
      node.hidden = [allow, done, park, tell].every((one) => one.hidden)
    },
  }
}
