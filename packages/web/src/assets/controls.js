// The controls a task's page and a project's page are built with: one block per
// verb, and the key every press mints. Shared, so the two pages
// (`pages/agent.js`, `pages/project.js`) and the command bar ask for the same
// blocks rather than each drawing its own.

import {
  afterAnswer,
  asksFor,
  bodyFor,
  confirms,
  controlsFor,
  headingFor,
  howSaid,
  QUEUE_ASKS,
  SHOWN,
  wordsFor,
} from './acts.js'
import { classOn, el, into, textIn } from './dom.js'
import { section } from './rows.js'
import { answerIn } from './ui.js'

/* ── the controls a task's page and a project's page are built with ──────── */

/* One task's own page is `pages/agent.js`; its controls are these. */

/**
 * Every control this page has, as one block per verb.
 *
 * **Absent rather than refused, three times over.** A verb this device was not
 * granted is not built at all and says nothing — a sentence naming a scope
 * somebody does not have is a map of what else there is to ask for. A verb the
 * *world* cannot do right now is absent with the row's own reason beside it.
 * And what every one of them sends is the task's own `rev`: what the screen
 * said, echoed back, so an act against a world that has moved is a `409` that
 * redraws the truth rather than a tap that undoes somebody's decision.
 *
 * **The key is minted once per press and kept across a retry**: a press whose
 * answer never arrived is a press whose repeat must not be a second act, and
 * the key is what makes the machine able to tell the two apart.
 *
 * What is typed stays typed until the act actually happened (`afterAnswer`).
 */
export function actsIn(node, ctx, verbs = SHOWN) {
  const blocks = new Map()
  for (const verb of verbs) {
    const block = blockFor(verb, ctx)
    blocks.set(verb, block)
    into(node, block.node)
  }
  return {
    update(row, view) {
      const acts = view.may.acts ?? { answer: false, steer: false }
      for (const one of controlsFor(row, acts, verbs)) {
        blocks.get(one.verb)?.update(row, one)
      }
    },
  }
}

/**
 * One verb's block: a heading, whatever it needs typed, and the press.
 *
 * One shape for all eight, because the differences are three fields — what it
 * says, whether it takes text, and how many presses it has — and eight
 * hand-written blocks would be eight places for a `rev` to stop being echoed.
 */
function blockFor(verb, ctx) {
  const part = section(headingFor(verb))
  const why = el('p', { class: 'empty' })
  const box = TYPES[verb] === undefined ? null : el('textarea', { attrs: TYPES[verb] })
  const press = el('button', { class: 'press quietly' })
  const deny = verb === 'answer' ? el('button', { class: 'press quietly' }) : null
  const row = el('div', { class: 'presses' })
  // **Two lines, not one.** `how` is a fact about this harness that is true on
  // every frame; `said` is what came of the last press. One node for both
  // would mean the next delta — two seconds away — wiping the answer somebody
  // just got with a sentence they had already read.
  const how = el('p', { class: 'empty' })
  const said = el('p', { attrs: { role: 'status' } })
  const asks = el('div', { class: 'presses' })
  into(part.body, why)
  if (box !== null) into(part.body, box)
  into(row, press)
  if (deny !== null) into(row, deny)
  into(part.body, verb === 'queue' ? asks : row, how, said)

  let held = null
  let going = false
  let asked = false

  const send = async (typed) => {
    if (going || held === null) return
    going = true
    press.disabled = true
    if (deny !== null) deny.disabled = true
    const answer = await ctx.ask(
      'POST',
      `/api/act/${verb}`,
      bodyFor(verb, held, keyOf(), ctx.revOf(), typed),
    )
    going = false
    press.disabled = false
    if (deny !== null) deny.disabled = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    answerIn(said, came.said, came.trouble)
    // **Only what actually happened clears the box.** A `409` is the world
    // having moved, and throwing away a paragraph somebody typed on a phone
    // because of it is the one failure they cannot undo.
    if (came.clear && box !== null) box.value = ''
    asked = false
    settle()
  }

  const typedOf = (over = {}) => ({
    said: box?.value ?? '',
    text: box?.value ?? '',
    add: box?.value ?? '',
    summary: box?.value ?? '',
    ...over,
  })

  const settle = () => {
    const word = wordsFor(verb, held ?? {})
    if (word === '') return
    textIn(press, asked ? 'Tap again to confirm' : word)
    classOn(press, 'asked', asked)
  }

  press.addEventListener('click', () => {
    // A second tap for the two that asking again does not undo. The schema's
    // own `confirm` literal is the other half, and neither stands in for the
    // other: this stops a mis-tap, and the literal stops a body that means
    // *do not*.
    if (confirms(verb) && !asked) {
      asked = true
      settle()
      return
    }
    void send(typedOf(verb === 'answer' ? { allow: true } : {}))
  })
  deny?.addEventListener('click', () => void send(typedOf({ allow: false })))
  const choices = []
  for (const ask of verb === 'queue' ? QUEUE_ASKS : []) {
    const one = el('button', { class: 'press quietly', text: ask.said })
    one.addEventListener('click', () => void send(typedOf({ change: ask.change })))
    choices.push({ ask, node: one })
    into(asks, one)
  }

  return {
    node: part.node,
    update(task, standing) {
      held = task
      // Nothing at all for a verb this device was not granted: no heading, no
      // reason, no control.
      part.node.hidden = standing.kind === 'off'
      if (standing.kind === 'off') return
      const shown = standing.kind === 'yes'
      // Hidden where there is nothing to say as well as where the control is
      // drawn: a row from a server that mentioned this verb in neither list
      // has no reason to give, and an empty paragraph under a heading reads as
      // something that failed to load.
      why.hidden = shown || standing.why === ''
      textIn(why, shown ? '' : standing.why)
      // A block that can only say why not is one line, not a section: its
      // heading and its reason side by side, quiet, so the presses that can be
      // pressed are what the eye lands on.
      classOn(part.node, 'is-off', !shown)
      row.hidden = !shown
      asks.hidden = !shown
      said.hidden = !shown
      how.hidden = true
      if (box !== null) box.hidden = !shown
      if (!shown) {
        asked = false
        return
      }
      settle()
      // Built once and hidden per row: parked work has no startable choice,
      // and offering one is a tap that can only be refused.
      const offered = asksFor(task)
      for (const choice of choices) choice.node.hidden = !offered.includes(choice.ask)
      if (deny !== null) textIn(deny, 'Deny')
      const clause = howSaid(standing.how)
      how.hidden = clause === ''
      textIn(how, clause)
    },
  }
}

/**
 * The boxes, and what each one is for.
 *
 * `maxlength` is the server's own bound (`BOUNDS`), so a phone says *that is
 * as much as this takes* while somebody is typing rather than after they send
 * it — and the server still refuses one past it, because a client bound is a
 * courtesy and never a check.
 *
 * **An `aria-label` as well as a placeholder**, because a placeholder is not a
 * label: it goes the moment somebody types, so a screen reader meeting a
 * half-filled box would have nothing to say about what it is for.
 */
const TYPES = {
  steer: {
    rows: '3',
    maxlength: '2000',
    placeholder: 'what to tell its agent',
    'aria-label': 'what to tell its agent',
  },
  note: {
    rows: '3',
    maxlength: '4000',
    placeholder: 'what to write down, as you write it',
    'aria-label': 'what to write down',
  },
  context: {
    rows: '4',
    maxlength: '4000',
    placeholder: 'what to add to what it is told',
    'aria-label': 'what to add to what it is told',
  },
  done: {
    rows: '2',
    maxlength: '500',
    placeholder: 'what it finished as (optional)',
    'aria-label': 'what it finished as',
  },
}

/**
 * A fresh idempotency key: this browser's own randomness, and nothing of the
 * machine's.
 *
 * `crypto.randomUUID` where the browser has it — every target this page claims
 * does, over a secure context — and a value out of `getRandomValues` where it
 * does not. Never a counter and never a timestamp: two tabs of one phone would
 * mint the same one, and a key bound to another act is refused rather than
 * obeyed, so a collision would read as a broken button.
 */
export function keyOf() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((one) => one.toString(16).padStart(2, '0')).join('')
}
